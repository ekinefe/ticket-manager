import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";
import { createAuth } from "../src/auth/server";
import { createLocalDb, DATA_DIR, PROJECT_ROOT } from "../src/db/local";
import { ApiError } from "../src/lib/http";
import {
  getSessionUser,
  requireProjectRole,
  requireSuperAdmin,
  requirePanelAccess,
  listAccessibleProjects,
  listAssignedTickets,
} from "../src/lib/rbac";
import { allocateTicketId } from "../src/lib/ticket-id";
import { logActivity } from "../src/lib/activity";
import { canTransition, INSTANT_NOTIFY_STATUSES, STATUSES, type Status } from "../src/lib/status";
import { notifyStatusChanged } from "../src/lib/notify";
import { validateInvitation, markInvitationAccepted, hashInviteToken, generateInviteToken } from "../src/lib/invite";
import { searchAll } from "../src/lib/search";
import { sanitizeDescHtml } from "../src/lib/sanitize";
import { publish, subscribe, unsubscribe } from "../src/lib/realtime";
import {
  hasPendingAccountInvite,
  validateAccountInvite,
  markAccountInviteAccepted,
} from "../src/lib/account-invite";
import {
  applyPasswordReset,
  createPasswordReset,
  findUserIdByEmail,
  hasPendingPasswordReset,
  validatePasswordReset,
} from "../src/lib/password-reset";
import { clientIp, rateLimit } from "../src/lib/ratelimit";
import { renderTemplate, htmlToText } from "../src/lib/mail/templates";
import { getTransport } from "../src/lib/mail";
import { runJob, startScheduler } from "../src/cron/scheduler";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { projects, projectMembers, tasks, user, invitations, activityLog, taskComments, accountInvites } from "../src/db/schema";

const env: Env = {
  DB: createLocalDb(process.env.TM_DB_FILE || undefined),
  APP_URL: process.env.APP_URL ?? "http://localhost:8788",
  MAIL_FROM: process.env.MAIL_FROM ?? "Ticket Manager <no-reply@tickets.local>",
  MAIL_TRANSPORT: (process.env.MAIL_TRANSPORT as Env["MAIL_TRANSPORT"]) ?? "file",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-change-me",
  OSV_PACKAGES:
    process.env.OSV_PACKAGES ?? '["drizzle-orm@0.45.2","better-auth@1.7.1"]',
};

if (!process.env.BETTER_AUTH_SECRET) {
  console.warn("[uyari] BETTER_AUTH_SECRET atanmadi, yerel gelistirme anahtari kullaniliyor.");
}

export const app = new Hono();
export { env };

async function guard(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return c.json({ error: e.message }, e.status as 400);
    console.error(e);
    return c.json({ error: "Internal server error" }, 500);
  }
}

async function readBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TASK_TYPES = ["TASK", "BUG"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

// Short plain-text preview of a description for the activity log.
const descPreview = (html: string | null | undefined): string => {
  const text = String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
};

async function serveHtml(c: Context, file: string): Promise<Response> {
  try {
    const html = await readFile(file, "utf8");
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  } catch {
    return c.text("Frontend assets are missing.", 500);
  }
}

// Local dev: always revalidate client assets so JS/CSS edits show up on refresh.
const noCache = async (c: Context, next: () => Promise<void>) => {
  await next();
  c.header("Cache-Control", "no-cache");
};
app.use("/js/*", noCache);
app.use("/css/*", noCache);

const CLIENT_INDEX = join(PROJECT_ROOT, "client", "index.html");

app.get("/", (c) => serveHtml(c, CLIENT_INDEX));

// Public sign-up is closed: accounts are created only through invitations.
// The internal accept-invite flow passes this secret header when calling
// auth.api.signUpEmail directly (bypasses HTTP, so it is unaffected anyway).
const INTERNAL_SIGNUP_SECRET = crypto.randomUUID();
app.use("/api/auth/sign-up/email", async (c, next) => {
  if (c.req.header("x-internal-signup") !== INTERNAL_SIGNUP_SECRET) {
    return c.json({ error: "Sign-up is by invitation only" }, 403);
  }
  await next();
});

// ---------- Password reset (public, before the Better Auth catch-all) ----------
const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFor: (c) => `pwreq:${clientIp(c)}`,
});

app.post("/api/auth/request-password-reset", passwordResetRequestLimiter, (c) =>
  guard(c, async () => {
    const body = await readBody<{ email?: string }>(c);
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid e-mail address is required");

    // No account enumeration: the response is identical whether or not the
    // account exists and whether or not a reset is already pending.
    const userId = await findUserIdByEmail(env.DB, email);
    if (userId && !(await hasPendingPasswordReset(env.DB, userId))) {
      const { token } = await createPasswordReset(env.DB, userId);
      const resetUrl = `${env.APP_URL}/reset-password?token=${token}`;
      const html = renderTemplate("reset-password", {
        name: email.split("@")[0],
        reset_url: resetUrl,
      });
      const transport = getTransport(env);
      await transport.send({
        to: email,
        subject: "Reset your Ticket Manager password",
        html,
        text: htmlToText(html),
      });
    }
    return c.json({ ok: true });
  })
);

app.post("/api/auth/reset-password", (c) =>
  guard(c, async () => {
    const body = await readBody<{ token?: string; password?: string }>(c);
    const userId = await validatePasswordReset(env.DB, body.token ?? "");
    await applyPasswordReset(env.DB, userId, body.password ?? "");
    return c.json({ ok: true });
  })
);

app.all("/api/auth/*", (c) => createAuth(env).handler(c.req.raw));

// ---------- General API rate limit (generous; per client IP) ----------
app.use(
  "/api/*",
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    keyFor: (c) => `api:${clientIp(c)}`,
  })
);

// Strict per-user limiter for invitation creation (abuse containment).
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (c) => `invite:${c.req.header("x-forwarded-for") ?? "local"}`,
});

app.get("/api/projects", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    return c.json(await listAccessibleProjects(env.DB, u));
  })
);

// Unauthenticated liveness probe for monitoring / reverse-proxy checks.
app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

app.get("/api/my-tickets", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    return c.json(await listAssignedTickets(env.DB, u));
  })
);

app.get("/api/search", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const q = (c.req.query("q") || "").trim();
    if (q.length < 1) return c.json({ tickets: [], projects: [], users: [], suggested: false });
    return c.json(await searchAll(env.DB, u, q));
  })
);

app.post("/api/projects", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    requirePanelAccess(u);

    const body = await readBody<{ name?: string; prefix?: string }>(c);
    const name = body.name?.trim();
    const prefix = body.prefix?.trim().toUpperCase();
    if (!name) throw new ApiError(400, "Project name is required");
    if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
      throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits (e.g. WCE)");
    }

    const id = crypto.randomUUID();
    const [project] = await env.DB
      .insert(projects)
      .values({ id, name, prefix, currentTicketSequence: 0, createdAt: Date.now() })
      .returning();
    await env.DB.insert(projectMembers).values({ projectId: id, userId: u.id, role: "ADMIN" });
    return c.json(project, 201);
  })
);

app.get("/api/projects/:id", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const [project] = await env.DB.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");

    const members = await env.DB
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        name: user.name,
        email: user.email,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));

    return c.json({ ...project, members });
  })
);

app.patch("/api/projects/:id", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const body = await readBody<{ name?: string; prefix?: string }>(c);
    if (!body.name && !body.prefix) throw new ApiError(400, "Nothing to update");

    const values: Partial<{ name: string; prefix: string }> = {};
    if (body.name) values.name = body.name.trim();
    if (body.prefix) {
      const prefix = body.prefix.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,5}$/.test(prefix)) throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
      values.prefix = prefix;
    }

    const [updated] = await env.DB.update(projects).set(values).where(eq(projects.id, projectId)).returning();
    if (!updated) throw new ApiError(404, "Project not found");
    return c.json(updated);
  })
);

app.delete("/api/projects/:id", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(u);

    const deleted = await env.DB.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
    if (deleted.length === 0) throw new ApiError(404, "Project not found");
    return c.json({ ok: true });
  })
);

// ---------- Super-admin panel API ----------

app.get("/api/admin/users", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    requirePanelAccess(u);

    // Optional pagination: without ?page the full array is returned
    // (backwards compatible with the admin UI).
    const page = Number(c.req.query("page") ?? 0);
    const perPage = Math.min(Number(c.req.query("perPage") ?? 25), 100);
    if (!page || page < 1) {
      const rows = await env.DB
        .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
        .from(user)
        .orderBy(asc(user.name));
      return c.json(rows);
    }

    const [{ total }] = await env.DB.select({ total: sql<number>`count(*)` }).from(user);
    const rows = await env.DB
      .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
      .from(user)
      .orderBy(asc(user.name))
      .limit(perPage)
      .offset((page - 1) * perPage);
    return c.json({ data: rows, total, page, perPage });
  })
);

app.patch("/api/admin/users/:id", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const id = c.req.param("id");
    // Lockout protection: a super admin cannot change their own role.
    if (id === actor.id) throw new ApiError(400, "You cannot change your own role");

    const body = await readBody<{ role?: string }>(c);
    if (body.role !== "SUPER_ADMIN" && body.role !== "ADMIN" && body.role !== "USER") throw new ApiError(400, "Invalid role");

    const [updated] = await env.DB
      .update(user)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(user.id, id))
      .returning({ id: user.id, email: user.email, role: user.role });
    if (!updated) throw new ApiError(404, "User not found");
    return c.json(updated);
  })
);

app.delete("/api/admin/users/:id", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const id = c.req.param("id");
    // Lockout protection: a super admin cannot delete their own account.
    if (id === actor.id) throw new ApiError(400, "You cannot delete your own account");

    // Sessions and memberships cascade; tickets fall back to "Unassigned".
    const deleted = await env.DB
      .delete(user)
      .where(eq(user.id, id))
      .returning({ id: user.id, email: user.email });
    if (deleted.length === 0) throw new ApiError(404, "User not found");
    return c.json({ ok: true });
  })
);

app.get("/api/admin/users/:id", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const id = c.req.param("id");
    const [u] = await env.DB
      .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
      .from(user)
      .where(eq(user.id, id));
    if (!u) throw new ApiError(404, "User not found");
    const memberships = await env.DB
      .select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.userId, id));
    return c.json({ ...u, projects: memberships });
  })
);

app.post("/api/admin/users/:id/projects", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const id = c.req.param("id");
    const body = await readBody<{ projectId?: string; role?: string }>(c);
    if (!body.projectId) throw new ApiError(400, "projectId is required");
    const memberRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";

    const [target] = await env.DB.select({ id: user.id }).from(user).where(eq(user.id, id));
    if (!target) throw new ApiError(404, "User not found");

    await env.DB
      .insert(projectMembers)
      .values({ projectId: body.projectId, userId: id, role: memberRole })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: memberRole },
      });
    return c.json({ ok: true });
  })
);

app.delete("/api/admin/users/:id/projects/:projectId", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    await env.DB
      .delete(projectMembers)
      .where(and(eq(projectMembers.userId, c.req.param("id")), eq(projectMembers.projectId, c.req.param("projectId"))));
    return c.json({ ok: true });
  })
);

// Project-side view of the same memberships (kept in sync by design: both
// editors write to the project_members table).
app.get("/api/admin/projects/:id/members", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const projectId = c.req.param("id");
    const [project] = await env.DB.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");
    const members = await env.DB
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        name: user.name,
        email: user.email,
        globalRole: user.role,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));
    return c.json({ members });
  })
);

app.post("/api/admin/projects/:id/members", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const projectId = c.req.param("id");
    const body = await readBody<{ userId?: string; role?: string }>(c);
    if (!body.userId) throw new ApiError(400, "userId is required");
    const memberRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";

    const [project] = await env.DB.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");
    const [target] = await env.DB.select({ id: user.id }).from(user).where(eq(user.id, body.userId));
    if (!target) throw new ApiError(404, "User not found");

    await env.DB
      .insert(projectMembers)
      .values({ projectId, userId: body.userId, role: memberRole })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: memberRole },
      });
    return c.json({ ok: true });
  })
);

app.delete("/api/admin/projects/:id/members/:userId", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    await env.DB
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, c.req.param("id")), eq(projectMembers.userId, c.req.param("userId"))));
    return c.json({ ok: true });
  })
);

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

async function computePosition(projectId: string, status: Status, beforeTaskId: string | undefined, movedTaskId: string): Promise<number> {
  const siblings = await env.DB
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status), ne(tasks.id, movedTaskId)))
    .orderBy(asc(tasks.position));

  if (siblings.length === 0) return 1;
  if (!beforeTaskId) return siblings[siblings.length - 1].position + 1;
  const idx = siblings.findIndex((s) => s.id === beforeTaskId);
  if (idx === -1) return siblings[siblings.length - 1].position + 1;
  if (idx === 0) return siblings[0].position - 1;
  return (siblings[idx - 1].position + siblings[idx].position) / 2;
}

// Server-Sent Events stream: clients get a "ticket-changed" nudge whenever
// any ticket in the project is created, updated or deleted. The payload is
// deliberately minimal — clients re-fetch the board rather than diffing.
app.get("/api/projects/:id/stream", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id") as string;
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let client: ReadableStreamDefaultController<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = controller;
        subscribe(projectId, controller);
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          } catch {
            /* closed */
          }
        }, 30_000);
        // Clean up when the client disconnects (tab close, navigation).
        c.req.raw.signal.addEventListener("abort", () => {
          if (heartbeat) clearInterval(heartbeat);
          if (client) unsubscribe(projectId, client);
        });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (client) unsubscribe(projectId, client);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  })
);

app.get("/api/projects/:id/tasks", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    // Optional pagination (?page=&perPage= or &limit=&offset=); the board
    // client fetches everything (no params) since it needs the full set.
    const page = Number(c.req.query("page") ?? 0);
    const perPage = Math.min(Number(c.req.query("perPage") ?? 50), 200);
    const limit = Number(c.req.query("limit") ?? 0);
    const offset = Number(c.req.query("offset") ?? 0);

    let query = env.DB.select().from(tasks).where(eq(tasks.projectId, projectId)).$dynamic();
    if (page >= 1) {
      query = query.limit(perPage).offset((page - 1) * perPage);
    } else if (limit > 0) {
      query = query.limit(limit).offset(offset);
    }
    const rows = await query.orderBy(asc(tasks.status), asc(tasks.position));
    return c.json(rows);
  })
);

app.post("/api/projects/:id/tasks", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const body = await readBody<{ title?: string; description?: string; status?: string; assigneeId?: string; type?: string; priority?: string }>(c);
    const title = body.title?.trim();
    if (!title) throw new ApiError(400, "Title is required");
    // Members may pick the initial assignee of a NEW ticket; reassigning later is admin-only.
    const status = body.status ? (isStatus(body.status) ? body.status : (() => { throw new ApiError(400, `Invalid status`); })()) : "TODO";
    if (body.type !== undefined && !TASK_TYPES.includes(body.type)) throw new ApiError(400, `Invalid type: ${String(body.type)}`);
    if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) throw new ApiError(400, `Invalid priority: ${String(body.priority)}`);

    const ticketId = await allocateTicketId(env.DB, projectId);
    const [{ maxPos }] = await env.DB
      .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)));

    const now = Date.now();
    const [task] = await env.DB
      .insert(tasks)
      .values({
        id: crypto.randomUUID(),
        projectId,
        ticketId,
        title,
        description: sanitizeDescHtml(body.description ?? "") || null,
        status,
        type: (body.type ?? "TASK") as "TASK" | "BUG",
        priority: (body.priority ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
        assigneeId: body.assigneeId || null,
        createdBy: u.id,
        position: Number(maxPos) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await logActivity(env.DB, { taskId: task.id, actorId: u.id, eventType: "CREATED", newStatus: status });
    publish(projectId, { type: "created", ticketId, taskId: task.id, actorId: u.id });
    return c.json(task, 201);
  })
);

app.patch("/api/projects/:id/tasks/:taskId", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const u = await getSessionUser(c.req.raw, env);
    const myRole = await requireProjectRole(env.DB, u, projectId);

    const body = await readBody<{
      title?: string;
      description?: string;
      assigneeId?: string | null;
      status?: string;
      beforeTaskId?: string;
      type?: string;
      priority?: string;
    }>(c);

    const [task] = await env.DB
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
    if (!task) throw new ApiError(404, "Task not found");

    // Members may only modify tickets they are assigned to or created;
    // project admins and super admins can modify anything.
    if (myRole !== "ADMIN" && task.assigneeId !== u.id && task.createdBy !== u.id) {
      throw new ApiError(403, "Only the assignee, the ticket creator or a project admin can modify this ticket");
    }

    const oldTitle = task.title;
    const oldDescription = task.description;
    const oldAssigneeId = task.assigneeId;
    const oldType = task.type;
    const oldPriority = task.priority;

    const values: Partial<typeof tasks.$inferInsert> = {};
    if (body.title !== undefined) values.title = body.title.trim();
    if (body.description !== undefined) values.description = sanitizeDescHtml(body.description ?? "") || null;
    if (body.type !== undefined) {
      // Changing the ticket type (and therefore its branch prefix) is admin-only.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can change the ticket type");
      if (!TASK_TYPES.includes(body.type)) throw new ApiError(400, `Invalid type: ${String(body.type)}`);
      values.type = body.type as "TASK" | "BUG";
    }
    if (body.priority !== undefined) {
      // Priority changes are admin-only.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can change the priority");
      if (!PRIORITIES.includes(body.priority)) throw new ApiError(400, `Invalid priority: ${String(body.priority)}`);
      values.priority = body.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    }
    if (body.assigneeId !== undefined) {
      // Assignment is an admin-only action; members cannot reassign even their own tickets.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can reassign tickets");
      values.assigneeId = body.assigneeId || null;
    }

    let oldStatus: Status | null = null;
    let newStatus: Status | null = null;

    if (body.status !== undefined) {
      if (!isStatus(body.status)) throw new ApiError(400, `Invalid status: ${String(body.status)}`);
      oldStatus = task.status as Status;
      newStatus = body.status;
      // Same-status PATCH is a column reorder (drag & drop); only reject illegal cross-status moves.
      if (oldStatus !== newStatus && !canTransition(oldStatus, newStatus)) {
        throw new ApiError(400, `Illegal transition ${oldStatus} -> ${newStatus}`);
      }
      values.status = newStatus;
      values.position = await computePosition(projectId, newStatus, body.beforeTaskId, taskId);
    }

    if (Object.keys(values).length === 0) throw new ApiError(400, "Nothing to update");
    values.updatedAt = Date.now();

    const [updated] = await env.DB.update(tasks).set(values).where(eq(tasks.id, taskId)).returning();

    if (oldStatus && newStatus && oldStatus !== newStatus) {
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "STATUS_CHANGED",
        oldStatus,
        newStatus,
      });
      publish(projectId, { type: "status", ticketId: updated.ticketId, taskId, actorId: u.id });

      if (INSTANT_NOTIFY_STATUSES.has(newStatus)) {
        const [actor] = await env.DB.select({ name: user.name }).from(user).where(eq(user.id, u.id));
        await notifyStatusChanged(env, {
          projectId,
          taskId,
          ticketId: updated.ticketId,
          taskTitle: updated.title,
          oldStatus,
          newStatus,
          actorName: actor?.name ?? u.name,
        }).catch((e) => console.error("notify failed:", e));
      }
    }

    // Field-level history entries (in addition to the status entry above).
    if (values.title !== undefined && values.title !== oldTitle) {
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "TITLE_CHANGED",
        oldValue: oldTitle,
        newValue: values.title,
      });
    }
    if (values.description !== undefined && (values.description ?? null) !== (oldDescription ?? null)) {
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "DESCRIPTION_CHANGED",
        oldValue: descPreview(oldDescription),
        newValue: descPreview(values.description),
      });
    }
    if (body.assigneeId !== undefined && (values.assigneeId ?? null) !== (oldAssigneeId ?? null)) {
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "ASSIGNEE_CHANGED",
        oldValue: oldAssigneeId,
        newValue: values.assigneeId ?? null,
      });
    }
    if (values.type !== undefined && values.type !== oldType) {
      await logActivity(env.DB, { taskId, actorId: u.id, eventType: "TYPE_CHANGED", oldValue: oldType, newValue: values.type });
    }
    if (values.priority !== undefined && values.priority !== oldPriority) {
      await logActivity(env.DB, { taskId, actorId: u.id, eventType: "PRIORITY_CHANGED", oldValue: oldPriority, newValue: values.priority });
    }

    // Non-status edits also nudge open boards (status changes published above).
    if (!(oldStatus && newStatus && oldStatus !== newStatus) &&
        Object.keys(values).some((k) => k !== "updatedAt")) {
      publish(projectId, { type: "updated", ticketId: updated.ticketId, taskId, actorId: u.id });
    }

    return c.json(updated);
  })
);

// Full change history of a single ticket, oldest first.
app.get("/api/projects/:id/tasks/:taskId/events", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const [task] = await env.DB
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
    if (!task) throw new ApiError(404, "Task not found");

    const perPage = Math.min(Number(c.req.query("perPage") ?? 500), 500);
    const page = Math.max(Number(c.req.query("page") ?? 1), 1);
    const rows = await env.DB
      .select({
        id: activityLog.id,
        type: activityLog.eventType,
        oldStatus: activityLog.oldStatus,
        newStatus: activityLog.newStatus,
        oldValue: activityLog.oldValue,
        newValue: activityLog.newValue,
        createdAt: activityLog.createdAt,
        actorId: activityLog.actorId,
        actorName: user.name,
      })
      .from(activityLog)
      .leftJoin(user, eq(user.id, activityLog.actorId))
      .where(eq(activityLog.taskId, taskId))
      .orderBy(asc(activityLog.createdAt), asc(sql`activity_log.rowid`))
      .limit(perPage)
      .offset((page - 1) * perPage);

    // Resolve assignee user ids into display names.
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.type === "ASSIGNEE_CHANGED") {
        if (r.oldValue) ids.add(r.oldValue);
        if (r.newValue) ids.add(r.newValue);
      }
    }
    const nameById = new Map<string, string>();
    for (const id of ids) {
      const [row] = await env.DB.select({ name: user.name }).from(user).where(eq(user.id, id));
      if (row) nameById.set(id, row.name);
    }

    return c.json(
      rows.map((r) =>
        r.type === "ASSIGNEE_CHANGED"
          ? {
              ...r,
              oldValue: r.oldValue ? nameById.get(r.oldValue) ?? null : null,
              newValue: r.newValue ? nameById.get(r.newValue) ?? null : null,
            }
          : r
      )
    );
  })
);

// Comments: every project member can read and write comments on any ticket.
app.get("/api/projects/:id/tasks/:taskId/comments", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const [task] = await env.DB
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
    if (!task) throw new ApiError(404, "Task not found");

    const rows = await env.DB
      .select({
        id: taskComments.id,
        body: taskComments.body,
        createdAt: taskComments.createdAt,
        authorId: taskComments.authorId,
        authorName: user.name,
      })
      .from(taskComments)
      .leftJoin(user, eq(user.id, taskComments.authorId))
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt), asc(sql`task_comments.rowid`))
      .limit(500);
    return c.json(rows);
  })
);

app.post("/api/projects/:id/tasks/:taskId/comments", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const body = (await readBody<{ body?: string }>(c)).body?.trim();
    if (!body) throw new ApiError(400, "Comment cannot be empty");
    if (body.length > 4000) throw new ApiError(400, "Comment is too long (max 4000 characters)");

    const [task] = await env.DB
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
    if (!task) throw new ApiError(404, "Task not found");

    const [row] = await env.DB
      .insert(taskComments)
      .values({ id: crypto.randomUUID(), taskId, authorId: u.id, body, createdAt: Date.now() })
      .returning();
    return c.json({ ...row, authorName: u.name }, 201);
  })
);

app.delete("/api/projects/:id/tasks/:taskId", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const deleted = await env.DB
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .returning({ id: tasks.id });
    if (deleted.length === 0) throw new ApiError(404, "Task not found");
    publish(projectId, { type: "deleted", taskId, actorId: u.id });
    return c.json({ ok: true });
  })
);

const UPLOAD_DIR = join(DATA_DIR, "uploads");
const MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

app.post("/api/projects/:id/media", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "Missing file field");
    const ext = MEDIA_EXT[file.type];
    if (!ext) throw new ApiError(415, `Unsupported media type: ${file.type || "unknown"}`);
    if (file.size > MAX_MEDIA_BYTES) throw new ApiError(413, "File too large (max 100 MB)");

    await mkdir(UPLOAD_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    await writeFile(join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));
    return c.json({ url: `/media/uploads/${name}`, type: file.type, size: file.size }, 201);
  })
);

app.get("/api/projects/:id/invitations", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);    const rows = await env.DB
      .select({
        id: invitations.id,
        email: invitations.email,
        invitedRole: invitations.invitedRole,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(eq(invitations.projectId, projectId));
    return c.json(rows);
  })
);

app.post("/api/projects/:id/invitations", inviteLimiter, (c) =>
  guard(c, async () => {
    // The rate-limit middleware widens Hono's inferred param type.
    const projectId = c.req.param("id") as string;
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const body = await readBody<{ email?: string; role?: "ADMIN" | "MEMBER" }>(c);
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "Valid e-mail address is required");
    const invitedRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";

    const [project] = await env.DB
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");

    const [existingUser] = await env.DB.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existingUser) {
      const [member] = await env.DB
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)));
      if (member) throw new ApiError(409, "This user is already a member of the project");
    }

    const pending = await env.DB
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.projectId, projectId), eq(invitations.email, email)));
    if (pending.length > 0) throw new ApiError(409, "An invitation for this e-mail is already pending");

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const token = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const { tokenHash, expiresAt } = await hashInviteToken(token);

    const [invitation] = await env.DB
      .insert(invitations)
      .values({
        id: crypto.randomUUID(),
        projectId,
        email,
        tokenHash,
        invitedRole,
        expiresAt,
        createdBy: u.id,
        createdAt: Date.now(),
      })
      .returning();

    const inviteUrl = `${env.APP_URL}/accept-invite?token=${token}`;
    const html = renderTemplate("invite", {
      name: email.split("@")[0],
      project: project.name,
      role: invitedRole,
      invite_url: inviteUrl,
    });

    const transport = getTransport(env);
    await transport.send({
      to: email,
      subject: `You have been invited to ${project.name}`,
      html,
      text: htmlToText(html),
    });

    return c.json(
      {
        invitation: {
          id: invitation.id,
          email: invitation.email,
          invitedRole: invitation.invitedRole,
          expiresAt: invitation.expiresAt,
        },
        devInviteUrl: inviteUrl,
      },
      201
    );
  })
);

app.post("/api/invitations/accept", (c) =>
  guard(c, async () => {
    const body = await readBody<{ token?: string; name?: string; password?: string }>(c);
    if (!body.token) throw new ApiError(400, "Missing invite token");
    const password = body.password;
    if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

    const auth = createAuth(env);
    const internalHeaders = new Headers({ "x-internal-signup": INTERNAL_SIGNUP_SECRET });
    const signUp = async (email: string) => {
      const result = await auth.api.signUpEmail({
        headers: internalHeaders,
        body: {
          email,
          name: body.name?.trim() || email.split("@")[0],
          password,
        },
      });
      return result.user.id;
    };

    // Project invitation
    let projectInvitation;
    try {
      projectInvitation = await validateInvitation(env.DB, body.token);
    } catch {
      projectInvitation = null;
    }

    if (projectInvitation) {
      const [existingUser] = await env.DB.select({ id: user.id }).from(user).where(eq(user.email, projectInvitation.email));
      const userId = existingUser ? existingUser.id : await signUp(projectInvitation.email);

      const [alreadyMember] = await env.DB
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectInvitation.projectId)));

      if (!alreadyMember) {
        await env.DB.insert(projectMembers).values({
          projectId: projectInvitation.projectId,
          userId,
          role: projectInvitation.invitedRole,
        });
      }

      await markInvitationAccepted(env.DB, projectInvitation.id);
      return c.json({ ok: true, projectId: projectInvitation.projectId });
    }

    // Standalone account invitation (no project membership)
    const accountInvite = await validateAccountInvite(env.DB, body.token);
    const [existingUser] = await env.DB.select({ id: user.id }).from(user).where(eq(user.email, accountInvite.email));
    if (!existingUser) await signUp(accountInvite.email);
    await markAccountInviteAccepted(env.DB, accountInvite.id);
    return c.json({ ok: true, projectId: null });
  })
);

app.post("/api/admin/invites", inviteLimiter, (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(u);

    const body = await readBody<{ email?: string }>(c);
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "A valid e-mail address is required");

    const [existingUser] = await env.DB.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existingUser) throw new ApiError(409, "An account with this e-mail already exists");
    if (await hasPendingAccountInvite(env.DB, email)) throw new ApiError(409, "An invitation for this e-mail is already pending");

    const { token, expiresAt } = generateInviteToken();
    const { tokenHash } = await hashInviteToken(token);
    const [invite] = await env.DB
      .insert(accountInvites)
      .values({ id: crypto.randomUUID(), email, tokenHash, expiresAt, createdBy: u.id, createdAt: Date.now() })
      .returning();

    // The raw token exists only in the link; the DB stores its SHA-256 hash.
    const inviteUrl = `${env.APP_URL}/accept-invite?token=${token}`;
    const html = renderTemplate("account-invite", {
      name: email.split("@")[0],
      invite_url: inviteUrl,
    });

    const transport = getTransport(env);
    await transport.send({
      to: email,
      subject: "You have been invited to Ticket Manager",
      html,
      text: htmlToText(html),
    });

    return c.json(
      {
        invite: { id: invite.id, email: invite.email, expiresAt: invite.expiresAt },
        devInviteUrl: inviteUrl,
      },
      201
    );
  })
);

app.post("/api/dev/cron/:job", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(u);
    const job = c.req.param("job");
    if (!["daily", "weekly", "security"].includes(job)) throw new ApiError(404, "Unknown job");
    await runJob(env, job);
    return c.json({ ok: true, job });
  })
);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.use("*", serveStatic({ root: "./client" }));
app.use(
  "/media/*",
  serveStatic({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/media/, "/data"),
  })
);
app.get("*", (c) => serveHtml(c, CLIENT_INDEX));

// Only boot the HTTP listener and the scheduler when this file is the
// process entry point; tests import { app, env } without side effects.
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  serve({ fetch: app.fetch, port: 8788 }, (info) => {
    console.log(`Ticket Manager  ->  http://localhost:${info.port}`);
    console.log(`App:   http://localhost:${info.port}`);
    console.log(`Demo login: ekin@plannedlost.dev / admin123!`);
  });
  startScheduler(env);
}
