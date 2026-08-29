import { Hono, type Context } from "hono";
import { createAuth } from "./auth/server";
import { ApiError } from "./lib/http";
import {
  getSessionUser,
  requireProjectRole,
  requireSuperAdmin,
  requirePanelAccess,
  listAccessibleProjects,
  listAssignedTickets,
} from "./lib/rbac";
import { allocateTicketId } from "./lib/ticket-id";
import { logActivity } from "./lib/activity";
import { canTransition, INSTANT_NOTIFY_STATUSES, STATUSES, type Status } from "./lib/status";
import { notifyStatusChanged } from "./lib/notify";
import { validateInvitation, markInvitationAccepted, hashInviteToken, generateInviteToken } from "./lib/invite";
import { searchAll } from "./lib/search";
import { sanitizeDescHtml } from "./lib/sanitize";
import { publish, subscribe, unsubscribe } from "./lib/realtime";
import {
  hasPendingAccountInvite,
  validateAccountInvite,
  markAccountInviteAccepted,
} from "./lib/account-invite";
import {
  applyPasswordReset,
  createPasswordReset,
  findUserIdByEmail,
  hasPendingPasswordReset,
  validatePasswordReset,
} from "./lib/password-reset";
import { clientIp, rateLimit } from "./lib/ratelimit";
import { renderTemplate, htmlToText } from "./lib/mail/templates";
import { getTransport } from "./lib/mail";
import { runJob } from "./cron/scheduler";
import { and, asc, eq, ne, sql, gte, inArray, isNull } from "drizzle-orm";
import { projects, projectMembers, tasks, user, invitations, activityLog, taskComments, accountInvites, sprints, appSettings, notifications } from "./db/schema";
import {
  createNotification,
  createProjectNotification,
} from "./lib/in-app-notify";
import { notifyMentionedUsers } from "./lib/mentions";

// Shared runtime-agnostic Hono application. All route handlers bind to an
// `env` object supplied at construction time (either the local bootstrap or
// the Cloudflare Workers fetch handler). Static-file serving is intentionally
// NOT part of this module: workers uses the platform `[assets]` binding and the
// local dev server adds service of WEB/client itself.
export function createApp(env: Env): Hono {
  const app = new Hono();

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

// Every project starts with "Sprint 1" (PREFIX-S1); further sprints continue
// the sequence. The UNIQUE constraint on sprint_id is the race backstop.
async function createDefaultSprint(db: typeof env.DB, projectId: string, prefix: string): Promise<void> {
  await db.insert(sprints).values({
    id: crypto.randomUUID(),
    projectId,
    sprintId: `${prefix}-S1`,
    name: "Sprint 1",
    createdAt: Date.now(),
  }).onConflictDoNothing();
}

async function listProjectSprints(db: typeof env.DB, projectId: string) {
  return db
    .select({
      id: sprints.id,
      sprintId: sprints.sprintId,
      name: sprints.name,
      createdAt: sprints.createdAt,
      ticketCount: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sprints.id})`,
    })
    .from(sprints)
    .where(eq(sprints.projectId, projectId))
    .orderBy(asc(sprints.createdAt));
}

// Next human-visible sprint ID for a project: PREFIX-S<max+1>. Parses existing
// IDs rather than trusting a stored counter so manual/out-of-band IDs stay safe.
async function nextSprintId(db: typeof env.DB, projectId: string, prefix: string): Promise<string> {
  const rows = await db
    .select({ sprintId: sprints.sprintId })
    .from(sprints)
    .where(eq(sprints.projectId, projectId));
  let max = 0;
  for (const r of rows) {
    const m = /-S(\d+)$/.exec(r.sprintId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-S${max + 1}`;
}

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
      const transport = await getTransport(env);
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
    await createDefaultSprint(env.DB, id, prefix);
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

    const projectSprints = await listProjectSprints(env.DB, projectId);

    return c.json({ ...project, members, sprints: projectSprints });
  })
);

// ---------- Sprints (per-project iterations) ----------
// Only project admins may create, rename or delete sprints. A project must
// always keep at least one sprint; deleting the last one is rejected.

app.post("/api/projects/:id/sprints", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const body = await readBody<{ name?: string }>(c);
    const [project] = await env.DB
      .select({ prefix: projects.prefix })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");

    const sprintId = await nextSprintId(env.DB, projectId, project.prefix);
    const number = Number(sprintId.split("-S")[1]);
    const name = body.name?.trim() || `Sprint ${number}`;
    const [created] = await env.DB
      .insert(sprints)
      .values({ id: crypto.randomUUID(), projectId, sprintId, name, createdAt: Date.now() })
      .returning();
    return c.json(created, 201);
  })
);

app.patch("/api/projects/:id/sprints/:sid", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const sid = c.req.param("sid");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const body = await readBody<{ name?: string }>(c);
    const name = body.name?.trim();
    if (!name) throw new ApiError(400, "Sprint name is required");

    const [updated] = await env.DB
      .update(sprints)
      .set({ name })
      .where(and(eq(sprints.id, sid), eq(sprints.projectId, projectId)))
      .returning();
    if (!updated) throw new ApiError(404, "Sprint not found");
    return c.json(updated);
  })
);

app.delete("/api/projects/:id/sprints/:sid", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const sid = c.req.param("sid");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId, "ADMIN");

    const [{ total }] = await env.DB
      .select({ total: sql<number>`count(*)` })
      .from(sprints)
      .where(eq(sprints.projectId, projectId));
    if (total <= 1) throw new ApiError(400, "A project must always have at least one sprint");

    const deleted = await env.DB
      .delete(sprints)
      .where(and(eq(sprints.id, sid), eq(sprints.projectId, projectId)))
      .returning({ id: sprints.id });
    if (deleted.length === 0) throw new ApiError(404, "Sprint not found");
    return c.json({ ok: true });
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

// ---------- App settings (super admin) ----------
// Settings are stored in the DB and applied to the runtime env on save so
// changes take effect without a server restart.

const SETTINGS_KEYS = ["app_url", "better_auth_secret", "mail_transport", "mail_from", "resend_api_key"] as const;
type SettingsKey = (typeof SETTINGS_KEYS)[number];

app.get("/api/admin/settings", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const rows = await env.DB.select().from(appSettings);
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    return c.json(settings);
  })
);

app.patch("/api/admin/settings", (c) =>
  guard(c, async () => {
    const actor = await getSessionUser(c.req.raw, env);
    requireSuperAdmin(actor);
    const body = await readBody<Record<string, string>>(c);
    const now = Date.now();
    for (const key of SETTINGS_KEYS) {
      if (key in body) {
        const value = String(body[key] ?? "").trim();
        await env.DB
          .insert(appSettings)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
      }
    }
    // Apply changes to the running env immediately.
    await loadSettings(env);
    return c.json({ ok: true });
  })
);

// ---------- Dashboard stats (role-based, filterable) ----------

app.get("/api/dashboard/stats", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const isSuper = u.role === "SUPER_ADMIN";
    const isAdmin = u.role === "ADMIN" || isSuper;

    // --- Parse filter query params (super admin only) ---
    const qProjectId = isSuper ? (c.req.query("projectId") || "").trim() : "";
    const qSprintId = isSuper ? (c.req.query("sprintId") || "").trim() : "";
    const qAssigneeId = isSuper ? (c.req.query("assigneeId") || "").trim() : "";
    const qStatus = isSuper ? (c.req.query("status") || "").trim() : "";
    const qPriority = isSuper ? (c.req.query("priority") || "").trim() : "";
    const qType = isSuper ? (c.req.query("type") || "").trim() : "";
    const qDays = isSuper ? Number(c.req.query("days") || 14) : 14;

    // Time range (applies to all stats for super admin)
    const daysBack = Math.min(Math.max(qDays || 14, 7), 90);
    const timeCutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

    // Projects the user can access (base RBAC)
    const accessibleProjectIds = isSuper
      ? (await env.DB.select({ id: projects.id }).from(projects)).map((r) => r.id)
      : (await env.DB
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(eq(projectMembers.userId, u.id))
          .orderBy(asc(projectMembers.projectId))
        ).map((r) => r.projectId);

    // Effective project filter: RBAC × optional filter
    let effectiveProjectIds = accessibleProjectIds;
    if (isSuper && qProjectId && accessibleProjectIds.includes(qProjectId)) {
      effectiveProjectIds = [qProjectId];
    }
    const projectFilter = effectiveProjectIds.length > 0
      ? inArray(tasks.projectId, effectiveProjectIds)
      : sql`1 = 0`;

    // Build additional WHERE clauses from filters (all filters applied to taskWhere)
    const extraConditions: ReturnType<typeof sql>[] = [];
    if (isSuper && qSprintId) extraConditions.push(eq(tasks.sprintId, qSprintId));
    if (isSuper && qAssigneeId) extraConditions.push(eq(tasks.assigneeId, qAssigneeId));
    if (isSuper && qStatus) extraConditions.push(sql`${tasks.status} = ${qStatus}`);
    if (isSuper && qPriority) extraConditions.push(sql`${tasks.priority} = ${qPriority}`);
    if (isSuper && qType) extraConditions.push(sql`${tasks.type} = ${qType}`);
    if (isSuper) extraConditions.push(gte(tasks.createdAt, timeCutoffMs));

    const taskWhere = extraConditions.length > 0
      ? and(projectFilter, ...extraConditions)
      : projectFilter;

    // --- Core counts (filtered) ---
    const [{ totalTickets }] = await env.DB
      .select({ totalTickets: sql<number>`count(*)` })
      .from(tasks)
      .where(taskWhere);

    const myTickets = await env.DB
      .select({
        id: tasks.id,
        ticketId: tasks.ticketId,
        title: tasks.title,
        status: tasks.status,
        type: tasks.type,
        priority: tasks.priority,
        projectId: tasks.projectId,
        projectPrefix: projects.prefix,
        projectName: projects.name,
        sprintId: tasks.sprintId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(taskWhere, eq(tasks.assigneeId, u.id)))
      .orderBy(asc(tasks.updatedAt));

    const myProjects = await env.DB
      .select({
        id: projects.id,
        name: projects.name,
        prefix: projects.prefix,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(
        effectiveProjectIds.length > 0
          ? inArray(projects.id, effectiveProjectIds)
          : sql`1 = 0`
      )
      .orderBy(asc(projects.name));

    // --- Status / priority / type breakdown (filtered) ---
    const statusRows = await env.DB
      .select({ status: tasks.status, n: sql<number>`count(*)` })
      .from(tasks)
      .where(taskWhere)
      .groupBy(tasks.status);
    const statusCounts: Record<string, number> = {};
    for (const r of statusRows) statusCounts[r.status] = r.n;

    const priorityRows = await env.DB
      .select({ priority: tasks.priority, n: sql<number>`count(*)` })
      .from(tasks)
      .where(taskWhere)
      .groupBy(tasks.priority);
    const priorityCounts: Record<string, number> = {};
    for (const r of priorityRows) priorityCounts[r.priority] = r.n;

    const typeRows = await env.DB
      .select({ type: tasks.type, n: sql<number>`count(*)` })
      .from(tasks)
      .where(taskWhere)
      .groupBy(tasks.type);
    const typeCounts: Record<string, number> = {};
    for (const r of typeRows) typeCounts[r.type] = r.n;

    // --- Sprint stats (filtered) ---
    let sprintWhere = sql`1 = 1`;
    if (isSuper && qProjectId) sprintWhere = eq(sprints.projectId, qProjectId);
    else if (effectiveProjectIds.length > 0) sprintWhere = inArray(sprints.projectId, effectiveProjectIds);
    else sprintWhere = sql`1 = 0`;

    const sprintRows = await env.DB
      .select({
        id: sprints.id,
        sprintId: sprints.sprintId,
        name: sprints.name,
        projectId: sprints.projectId,
        projectName: projects.name,
        projectPrefix: projects.prefix,
        total: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sprints.id} and ${taskWhere})`,
        done: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sprints.id} and ${tasks.status} = 'DONE' and ${taskWhere})`,
      })
      .from(sprints)
      .innerJoin(projects, eq(projects.id, sprints.projectId))
      .where(sprintWhere)
      .orderBy(asc(sprints.createdAt));

    // --- Daily stats (uses taskWhere which already includes time filter) ---
    const dailyCreatedRows = await env.DB
      .select({
        day: sql<string>`date(${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`,
        n: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(taskWhere)
      .groupBy(sql`date(${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`);

    // For activity-based completed stats: project + time + assignee/type/priority filters
    const activityExtra: ReturnType<typeof sql>[] = [eq(activityLog.newStatus, "DONE")];
    if (isSuper && qAssigneeId) activityExtra.push(eq(tasks.assigneeId, qAssigneeId));
    if (isSuper && qType) activityExtra.push(sql`${tasks.type} = ${qType}`);
    if (isSuper && qPriority) activityExtra.push(sql`${tasks.priority} = ${qPriority}`);

    const activityBase = and(projectFilter, ...activityExtra, gte(activityLog.createdAt, timeCutoffMs));

    const dailyCompletedRows = await env.DB
      .select({
        day: sql<string>`date(${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`,
        n: sql<number>`count(*)`,
      })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .where(activityBase)
      .groupBy(sql`date(${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`);

    const dailyStats: { day: string; created: number; completed: number }[] = [];
    const dailyMap = new Map<string, { created: number; completed: number }>();
    for (const r of dailyCreatedRows) {
      const existing = dailyMap.get(r.day) || { created: 0, completed: 0 };
      existing.created = r.n;
      dailyMap.set(r.day, existing);
    }
    for (const r of dailyCompletedRows) {
      const existing = dailyMap.get(r.day) || { created: 0, completed: 0 };
      existing.completed = r.n;
      dailyMap.set(r.day, existing);
    }
    for (const [day, data] of dailyMap) dailyStats.push({ day, ...data });
    dailyStats.sort((a, b) => a.day.localeCompare(b.day));

    // --- Weekly stats ---
    const weeksBack = Math.min(Math.ceil(daysBack / 7), 12);
    const weeklyCutoffMs = Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000;

    const weeklyCreatedRows = await env.DB
      .select({
        week: sql<string>`strftime('%Y-W%W', ${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`,
        n: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(and(extraConditions.length > 0 ? and(projectFilter, ...extraConditions) : projectFilter, gte(tasks.createdAt, weeklyCutoffMs)))
      .groupBy(sql`strftime('%Y-W%W', ${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`);

    const weeklyActivityBase = and(projectFilter, ...activityExtra, gte(activityLog.createdAt, weeklyCutoffMs));

    const weeklyCompletedRows = await env.DB
      .select({
        week: sql<string>`strftime('%Y-W%W', ${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`,
        n: sql<number>`count(*)`,
      })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .where(weeklyActivityBase)
      .groupBy(sql`strftime('%Y-W%W', ${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`);

    const weeklyStats: { week: string; created: number; completed: number }[] = [];
    const weeklyMap = new Map<string, { created: number; completed: number }>();
    for (const r of weeklyCreatedRows) {
      const existing = weeklyMap.get(r.week) || { created: 0, completed: 0 };
      existing.created = r.n;
      weeklyMap.set(r.week, existing);
    }
    for (const r of weeklyCompletedRows) {
      const existing = weeklyMap.get(r.week) || { created: 0, completed: 0 };
      existing.completed = r.n;
      weeklyMap.set(r.week, existing);
    }
    for (const [week, data] of weeklyMap) weeklyStats.push({ week, ...data });
    weeklyStats.sort((a, b) => a.week.localeCompare(b.week));

    // --- Recent activity (all filters applied) ---
    const activityTaskConditions: ReturnType<typeof sql>[] = [eq(activityLog.eventType, "STATUS_CHANGED")];
    if (isSuper && qSprintId) activityTaskConditions.push(eq(tasks.sprintId, qSprintId));
    if (isSuper && qAssigneeId) activityTaskConditions.push(eq(tasks.assigneeId, qAssigneeId));
    if (isSuper && qStatus) activityTaskConditions.push(sql`${tasks.status} != ${qStatus}`); // show transitions involving this status
    if (isSuper && qPriority) activityTaskConditions.push(sql`${tasks.priority} = ${qPriority}`);
    if (isSuper && qType) activityTaskConditions.push(sql`${tasks.type} = ${qType}`);
    if (isSuper) activityTaskConditions.push(gte(activityLog.createdAt, timeCutoffMs));

    const recentActivity = await env.DB
      .select({
        id: activityLog.id,
        taskId: activityLog.taskId,
        ticketId: tasks.ticketId,
        taskTitle: tasks.title,
        projectName: projects.name,
        projectPrefix: projects.prefix,
        actorId: activityLog.actorId,
        actorName: user.name,
        oldStatus: activityLog.oldStatus,
        newStatus: activityLog.newStatus,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .leftJoin(user, eq(user.id, activityLog.actorId))
      .where(and(projectFilter, ...activityTaskConditions))
      .orderBy(asc(activityLog.createdAt))
      .limit(10);

    // --- Team workload (ADMIN+, filtered) ---
    let teamWorkload: { userId: string; name: string; openCount: number; doneCount: number }[] = [];
    if (isAdmin && effectiveProjectIds.length > 0) {
      const workloadWhere = isSuper
        ? and(taskWhere, sql`${tasks.assigneeId} is not null`)
        : and(projectFilter, sql`${tasks.assigneeId} is not null`);

      const workloadRows = await env.DB
        .select({
          userId: tasks.assigneeId,
          openCount: sql<number>`count(case when ${tasks.status} != 'DONE' then 1 end)`,
          doneCount: sql<number>`count(case when ${tasks.status} = 'DONE' then 1 end)`,
        })
        .from(tasks)
        .where(workloadWhere)
        .groupBy(tasks.assigneeId);

      for (const r of workloadRows) {
        const [uRow] = await env.DB.select({ name: user.name }).from(user).where(eq(user.id, r.userId!));
        teamWorkload.push({
          userId: r.userId!,
          name: uRow?.name ?? "Unknown",
          openCount: r.openCount,
          doneCount: r.doneCount,
        });
      }
      teamWorkload.sort((a, b) => b.openCount - a.openCount);
    }

    // --- Super-admin-only stats (filtered) ---
    let totalProjects = 0;
    let totalUsers = 0;
    let projectStats: { id: string; name: string; prefix: string; total: number; done: number }[] = [];
    let topAssignees: { name: string; total: number }[] = [];
    let filterOptions: {
      projects: { id: string; name: string; prefix: string }[];
      sprints: { id: string; sprintId: string; name: string; projectId: string }[];
      users: { id: string; name: string; email: string }[];
    } | null = null;

    if (isSuper) {
      // Count projects that have at least one matching ticket (or all if no project filter)
      const projCountRow = await env.DB
        .select({ n: sql<number>`count(distinct ${tasks.projectId})` })
        .from(tasks)
        .where(taskWhere);
      totalProjects = projCountRow[0]?.n ?? 0;

      // Count users who have at least one matching ticket
      const userCountRow = await env.DB
        .select({ n: sql<number>`count(distinct ${tasks.assigneeId})` })
        .from(tasks)
        .where(and(taskWhere, sql`${tasks.assigneeId} is not null`));
      totalUsers = userCountRow[0]?.n ?? 0;

      // Per-project breakdown using taskWhere
      projectStats = await env.DB
        .select({
          id: projects.id,
          name: projects.name,
          prefix: projects.prefix,
          total: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${projects.id} and ${taskWhere})`,
          done: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${projects.id} and ${tasks.status} = 'DONE' and ${taskWhere})`,
        })
        .from(projects)
        .where(effectiveProjectIds.length > 0 ? inArray(projects.id, effectiveProjectIds) : sql`1 = 1`)
        .orderBy(asc(projects.name));

      // Top assignees (all filters applied via taskWhere)
      const topRows = await env.DB
        .select({
          name: user.name,
          total: sql<number>`count(*)`,
        })
        .from(tasks)
        .innerJoin(user, eq(user.id, tasks.assigneeId))
        .where(and(taskWhere, sql`${tasks.assigneeId} is not null`))
        .groupBy(tasks.assigneeId)
        .orderBy(sql`count(*) desc`)
        .limit(10);
      topAssignees = topRows;

      // Filter options for the UI dropdowns (always show all options)
      const allProjects = await env.DB
        .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
        .from(projects)
        .orderBy(asc(projects.name));

      let sprintQuery = env.DB
        .select({ id: sprints.id, sprintId: sprints.sprintId, name: sprints.name, projectId: sprints.projectId })
        .from(sprints)
        .orderBy(asc(sprints.createdAt));
      if (qProjectId) {
        sprintQuery = sprintQuery.where(eq(sprints.projectId, qProjectId)) as typeof sprintQuery;
      }
      const allSprints = await sprintQuery;

      const allUsers = await env.DB
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .orderBy(asc(user.name));

      filterOptions = { projects: allProjects, sprints: allSprints, users: allUsers };
    }

    return c.json({
      totalTickets,
      totalProjects,
      totalUsers,
      myTickets,
      myProjects,
      statusCounts,
      priorityCounts,
      typeCounts,
      sprintStats: sprintRows,
      dailyStats,
      weeklyStats,
      recentActivity: recentActivity.reverse(),
      teamWorkload,
      projectStats,
      topAssignees,
      filterOptions,
    });
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

    const body = await readBody<{ title?: string; description?: string; status?: string; assigneeId?: string; type?: string; priority?: string; sprintId?: string | null }>(c);
    const title = body.title?.trim();
    if (!title) throw new ApiError(400, "Title is required");
    // Members may pick the initial assignee of a NEW ticket; reassigning later is admin-only.
    const status = body.status ? (isStatus(body.status) ? body.status : (() => { throw new ApiError(400, `Invalid status`); })()) : "TODO";
    if (body.type !== undefined && !TASK_TYPES.includes(body.type)) throw new ApiError(400, `Invalid type: ${String(body.type)}`);
    if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) throw new ApiError(400, `Invalid priority: ${String(body.priority)}`);
    // If a sprintId is provided, verify it belongs to this project.
    if (body.sprintId) {
      const [sprint] = await env.DB.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.id, body.sprintId), eq(sprints.projectId, projectId)));
      if (!sprint) throw new ApiError(400, "Invalid sprint for this project");
    }

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
        sprintId: body.sprintId || null,
        createdBy: u.id,
        position: Number(maxPos) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await logActivity(env.DB, { taskId: task.id, actorId: u.id, eventType: "CREATED", newStatus: status });
    publish(projectId, { type: "created", ticketId, taskId: task.id, actorId: u.id });

    if (body.assigneeId) {
      await createNotification({
        db: env.DB,
        userId: body.assigneeId,
        actorId: u.id,
        type: "TICKET_CREATED",
        taskId: task.id,
        projectId,
        message: `${u.name} assigned you ${ticketId}: ${title}`,
      }).catch((e) => console.error("notification failed:", e));
    } else {
      await createProjectNotification({
        db: env.DB,
        projectId,
        actorId: u.id,
        type: "TICKET_CREATED",
        taskId: task.id,
        message: `${u.name} created ${ticketId}: ${title}`,
      }).catch((e) => console.error("notification failed:", e));
    }

    if (body.description) {
      await notifyMentionedUsers({
        db: env.DB,
        text: body.description,
        actorId: u.id,
        taskId: task.id,
        projectId,
        messagePrefix: `${u.name} on ${ticketId}`,
      });
    }

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
      sprintId?: string | null;
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
    const oldSprintId = task.sprintId;

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
    if (body.sprintId !== undefined) {
      if (body.sprintId) {
        const [sprint] = await env.DB.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.id, body.sprintId), eq(sprints.projectId, projectId)));
        if (!sprint) throw new ApiError(400, "Invalid sprint for this project");
      }
      values.sprintId = body.sprintId || null;
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

      const notifyUserIds = [task.createdBy, task.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
      for (const uid of notifyUserIds) {
        await createNotification({
          db: env.DB,
          userId: uid,
          actorId: u.id,
          type: "STATUS_CHANGED",
          taskId,
          projectId,
          message: `${u.name} moved ${updated.ticketId} to ${newStatus}`,
        }).catch((e) => console.error("notification failed:", e));
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
      if (values.description) {
        await notifyMentionedUsers({
          db: env.DB,
          text: values.description,
          actorId: u.id,
          taskId,
          projectId,
          messagePrefix: `${u.name} on ${updated.ticketId}`,
        });
      }
    }
    if (body.assigneeId !== undefined && (values.assigneeId ?? null) !== (oldAssigneeId ?? null)) {
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "ASSIGNEE_CHANGED",
        oldValue: oldAssigneeId,
        newValue: values.assigneeId ?? null,
      });
      if (values.assigneeId) {
        await createNotification({
          db: env.DB,
          userId: values.assigneeId,
          actorId: u.id,
          type: "ASSIGNED",
          taskId,
          projectId,
          message: `${u.name} assigned you ${updated.ticketId}: ${updated.title}`,
        }).catch((e) => console.error("notification failed:", e));
      }
    }
    if (values.type !== undefined && values.type !== oldType) {
      await logActivity(env.DB, { taskId, actorId: u.id, eventType: "TYPE_CHANGED", oldValue: oldType, newValue: values.type });
    }
    if (values.priority !== undefined && values.priority !== oldPriority) {
      await logActivity(env.DB, { taskId, actorId: u.id, eventType: "PRIORITY_CHANGED", oldValue: oldPriority, newValue: values.priority });
    }
    if (values.sprintId !== undefined && (values.sprintId ?? null) !== (oldSprintId ?? null)) {
      // Resolve sprint internal IDs to human-readable IDs for the activity log.
      const resolveSprint = async (sid: string | null): Promise<string | null> => {
        if (!sid) return null;
        const [s] = await env.DB.select({ sprintId: sprints.sprintId }).from(sprints).where(eq(sprints.id, sid));
        return s?.sprintId ?? null;
      };
      await logActivity(env.DB, {
        taskId,
        actorId: u.id,
        eventType: "SPRINT_CHANGED",
        oldValue: await resolveSprint(oldSprintId),
        newValue: await resolveSprint(values.sprintId),
      });
      const sprintNotifyUsers = [task.createdBy, task.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
      for (const uid of sprintNotifyUsers) {
        await createNotification({
          db: env.DB,
          userId: uid,
          actorId: u.id,
          type: "SPRINT_CHANGED",
          taskId,
          projectId,
          message: `${u.name} moved ${updated.ticketId} to sprint ${await resolveSprint(values.sprintId) ?? "None"}`,
        }).catch((e) => console.error("notification failed:", e));
      }
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

    const [taskRow] = await env.DB
      .select({ assigneeId: tasks.assigneeId, createdBy: tasks.createdBy, ticketId: tasks.ticketId, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    if (taskRow) {
      const commentNotifyUsers = [taskRow.createdBy, taskRow.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
      for (const uid of commentNotifyUsers) {
        await createNotification({
          db: env.DB,
          userId: uid,
          actorId: u.id,
          type: "COMMENT_ADDED",
          taskId,
          projectId,
          message: `${u.name} commented on ${taskRow.ticketId}: ${taskRow.title}`,
        }).catch((e) => console.error("notification failed:", e));
      }
      await notifyMentionedUsers({
        db: env.DB,
        text: body,
        actorId: u.id,
        taskId,
        projectId,
        messagePrefix: `${u.name} on ${taskRow.ticketId}`,
      });
    }

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

    const name = `${crypto.randomUUID()}.${ext}`;
    await env.STORAGE.put(name, await file.arrayBuffer(), file.type);
    return c.json({ url: `/media/uploads/${name}`, type: file.type, size: file.size }, 201);
  })
);

// Serve uploaded media from the configured storage backend (R2 on Workers,
// filesystem locally). Public by design: URLs are unguessable UUIDs.
app.get("/media/uploads/:name", async (c) => {
  const name = c.req.param("name");
  const obj = await env.STORAGE.get(name);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": obj.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
});

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

    const transport = await getTransport(env);
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
        await createProjectNotification({
          db: env.DB,
          projectId: projectInvitation.projectId,
          actorId: userId,
          type: "MEMBER_ADDED",
          message: `${projectInvitation.email} joined the project as ${projectInvitation.invitedRole}`,
        }).catch((e) => console.error("notification failed:", e));
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

    const transport = await getTransport(env);
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

// ---------- Notifications ----------

app.get("/api/notifications/unread-count", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const [{ n }] = await env.DB
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)));
    return c.json({ count: n });
  })
);

app.get("/api/notifications", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const limit = Math.min(Number(c.req.query("limit") || 30), 100);
    const offset = Number(c.req.query("offset") || 0);

    const rows = await env.DB
      .select({
        id: notifications.id,
        type: notifications.type,
        taskId: notifications.taskId,
        projectId: notifications.projectId,
        message: notifications.message,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorId: notifications.actorId,
        actorName: user.name,
      })
      .from(notifications)
      .leftJoin(user, eq(user.id, notifications.actorId))
      .where(eq(notifications.userId, u.id))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await env.DB
      .select({ total: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.userId, u.id));

    return c.json({ notifications: rows, total });
  })
);

app.patch("/api/notifications/:id/read", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const id = c.req.param("id");
    await env.DB
      .update(notifications)
      .set({ readAt: Date.now() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
    return c.json({ ok: true });
  })
);

app.patch("/api/notifications/:id/unread", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const id = c.req.param("id");
    await env.DB
      .update(notifications)
      .set({ readAt: null })
      .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
    return c.json({ ok: true });
  })
);

app.patch("/api/notifications/read-all", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    await env.DB
      .update(notifications)
      .set({ readAt: Date.now() })
      .where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)));
    return c.json({ ok: true });
  })
);

app.delete("/api/notifications/:id", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    const id = c.req.param("id");
    await env.DB
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
    return c.json({ ok: true });
  })
);

// ---------- Export / Import ----------

app.get("/api/projects/:id/export", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    await requireProjectRole(env.DB, u, projectId);

    const [project] = await env.DB
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");

    const projectSprints = await env.DB
      .select()
      .from(sprints)
      .where(eq(sprints.projectId, projectId))
      .orderBy(asc(sprints.createdAt));

    const projectTasks = await env.DB
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        type: tasks.type,
        priority: tasks.priority,
        assigneeId: tasks.assigneeId,
        createdBy: tasks.createdBy,
        sprintId: tasks.sprintId,
        position: tasks.position,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.position));

    const sprintIndexMap = new Map(projectSprints.map((s, i) => [s.id, i]));

    return c.json({
      project: { name: project.name, prefix: project.prefix },
      sprints: projectSprints.map((s) => ({ name: s.name })),
      tasks: projectTasks.map((t) => ({
        title: t.title,
        description: t.description || undefined,
        status: t.status,
        type: t.type,
        priority: t.priority,
        sprint: t.sprintId != null ? sprintIndexMap.get(t.sprintId) ?? null : null,
        assigneeId: t.assigneeId || undefined,
      })),
    });
  })
);

app.post("/api/projects/import", (c) =>
  guard(c, async () => {
    const u = await getSessionUser(c.req.raw, env);
    requirePanelAccess(u);

    const body = await readBody<{
      project?: { name?: string; prefix?: string };
      sprints?: { name?: string }[];
      tasks?: {
        title?: string;
        description?: string;
        status?: string;
        type?: string;
        priority?: string;
        sprint?: number | null;
        assigneeId?: string;
      }[];
    }>(c);

    const projectName = body.project?.name?.trim();
    const prefix = body.project?.prefix?.trim().toUpperCase();
    if (!projectName) throw new ApiError(400, "Project name is required");
    if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
      throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
    }
    if (!body.sprints?.length) throw new ApiError(400, "At least one sprint is required");

    const projectId = crypto.randomUUID();
    const now = Date.now();

    const createdSprints: { id: string; sprintId: string; name: string; createdAt: number }[] = [];
    const createdTaskIds: string[] = [];

    // NOTE: previously wrapped in a single DB transaction. better-sqlite3
    // (local) requires a synchronous transaction callback while D1 (Workers)
    // requires an async one, so a shared transaction callback cannot serve
    // both runtimes. All statements below are independent (no DB reads), so
    // they run sequentially on env.DB instead, which is correct on both.
    await env.DB.insert(projects).values({
      id: projectId,
      name: projectName,
      prefix,
      currentTicketSequence: 0,
      createdAt: now,
    }).run();

    await env.DB.insert(projectMembers).values({
      projectId,
      userId: u.id,
      role: "ADMIN",
    }).run();

    for (let i = 0; i < body.sprints!.length; i++) {
      const s = body.sprints![i];
      const sprintIdStr = `${prefix}-S${i + 1}`;
      const sprintUuid = crypto.randomUUID();
      await env.DB.insert(sprints).values({
        id: sprintUuid,
        projectId,
        sprintId: sprintIdStr,
        name: s.name?.trim() || `Sprint ${i + 1}`,
        createdAt: now,
      }).run();
      createdSprints.push({ id: sprintUuid, sprintId: sprintIdStr, name: s.name?.trim() || `Sprint ${i + 1}`, createdAt: now });
    }

    let ticketSeq = 0;
    for (const t of body.tasks || []) {
      const title = t.title?.trim();
      if (!title) continue;

      ticketSeq++;
      const ticketId = `${prefix}-${ticketSeq}`;
      const status = t.status && isStatus(t.status) ? t.status : "TODO";
      const type = t.type && TASK_TYPES.includes(t.type) ? t.type : "TASK";
      const priority = t.priority && PRIORITIES.includes(t.priority) ? t.priority : "MEDIUM";

      let sprintUuid: string | null = null;
      if (t.sprint != null && t.sprint >= 0 && t.sprint < createdSprints.length) {
        sprintUuid = createdSprints[t.sprint].id;
      }

      const taskUuid = crypto.randomUUID();
      await env.DB.insert(tasks).values({
        id: taskUuid,
        projectId,
        ticketId,
        title,
        description: sanitizeDescHtml(t.description ?? "") || null,
        status,
        type: type as "TASK" | "BUG",
        priority: priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
        assigneeId: t.assigneeId || null,
        sprintId: sprintUuid,
        createdBy: u.id,
        position: ticketSeq,
        createdAt: now,
        updatedAt: now,
      }).run();
      createdTaskIds.push(taskUuid);
    }

    await env.DB.update(projects)
      .set({ currentTicketSequence: ticketSeq })
      .where(eq(projects.id, projectId))
      .run();

    publish(projectId, { type: "imported", actorId: u.id });

    return c.json({
      ok: true,
      projectId,
      sprintsCreated: createdSprints.length,
      tasksCreated: createdTaskIds.length,
    }, 201);
  })
);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  return app;
}

// Read all settings from the DB and override the matching env fields.
// Loaded once at startup (by the local or the Workers bootstrap) and again
// whenever settings are saved via the admin panel.
export async function loadSettings(env: Env): Promise<void> {
  const rows = await env.DB.select().from(appSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  if (map.get("app_url")) env.APP_URL = map.get("app_url")!;
  if (map.get("better_auth_secret")) env.BETTER_AUTH_SECRET = map.get("better_auth_secret")!;
  if (map.get("mail_transport")) env.MAIL_TRANSPORT = map.get("mail_transport") as Env["MAIL_TRANSPORT"];
  if (map.get("mail_from")) env.MAIL_FROM = map.get("mail_from")!;
  if (map.get("resend_api_key")) env.RESEND_API_KEY = map.get("resend_api_key")!;
}

