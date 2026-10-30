import { Hono, type Context } from "hono";
import { createAuth } from "./auth/server";
import { ApiError } from "./shared/http";
import { guard, readBody } from "./shared/route";
import { internalSignupSecret } from "./shared/signup-secret";
import { EMAIL_RE } from "./shared/validate";
import { registerSprintRoutes, createDefaultSprint, listProjectSprints, nextSprintId } from "./domains/sprints/index";
import {
  getSessionUser,
  requireProjectRole,
  requireSuperAdmin,
  requirePanelAccess,
  listAccessibleProjects,
  listAssignedTickets,
  listUnassignedTickets,
  listAllTickets,
  getProjectAccess,
  requireProjectPermission,
  getMemberPermissions,
  setMemberPermissions,
  ensureDefaultMemberPermissions,
  PROJECT_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  type ProjectPermission,
  type ProjectAccess,
  type SessionUser,
} from "./domains/access/index";
import { allocateTicketId, assertTaskVisible, parseLabels, withLabelArrays, withoutShareToken, normalizeLabels, isStatus, isValidDueDate, TASK_TYPES, PRIORITIES, newShareToken, computePosition, applyTaskUpdate, descPreview, ACTIVITY_COALESCE_MS } from "./domains/tickets/index";
import { logActivity } from "./domains/tickets/index";
import { REPO_RE, createBranch, fetchCommitGraph, extractTicketIds, githubConfigured, handleGithubEvent, ticketBranchName, verifyWebhookSignature } from "./domains/github/index";
import { canTransition, STATUSES, type Status } from "./domains/tickets/index";
import { registerReportRoutes } from "./domains/reports/index";
import { planSync, buildEditInstructions, DEFAULT_SYNC_OPTIONS, type SyncOptions, type SprintTarget } from "./domains/projects/index";
import { isStatusMailEnabled, notifyStatusChanged } from "./domains/notifications/index";
import { validateInvitation, markInvitationAccepted, hashInviteToken, generateInviteToken } from "./domains/projects/index";
import { searchAll } from "./domains/tickets/index";
import { sanitizeDescHtml } from "./shared/sanitize";
import { publish, subscribe, unsubscribe } from "./shared/realtime";
import {
  hasPendingAccountInvite,
  validateAccountInvite,
  markAccountInviteAccepted,
} from "./domains/accounts/index";
import {
  applyPasswordReset,
  createPasswordReset,
  findUserIdByEmail,
  hasPendingPasswordReset,
  validatePasswordReset,
  changePassword,
  verifyUserPassword,
} from "./domains/accounts/index";
import { clientIp, rateLimit } from "./shared/ratelimit";
import { renderTemplate, htmlToText } from "./domains/notifications/index";
import { getTransport } from "./domains/notifications/mail/index";
import { registerNotificationRoutes } from "./domains/notifications/index";
import { registerAccountRoutes } from "./domains/accounts/index";
import { registerAdminAccessRoutes } from "./domains/access/index";
import { registerSettingsRoutes, loadGithubSettings } from "./domains/settings/index";
import { registerProjectRoutes } from "./domains/projects/index";
import { registerTicketRoutes } from "./domains/tickets/index";
import { registerGithubRoutes } from "./domains/github/index";
import { runJob } from "./cron/scheduler";
import { and, asc, eq, ne, or, sql, gte, inArray, isNull, count, desc } from "drizzle-orm";
import { githubEvents, githubEventTasks, projects, projectMembers, projectMemberPermissions, tasks, user, invitations, activityLog, taskComments, accountInvites, sprints, appSettings, notifications, accessAudit } from "./db/schema";
import {
  createNotification,
  createProjectNotification,
} from "./domains/notifications/index";
import { notifyMentionedUsers } from "./domains/notifications/index";

// Shared runtime-agnostic Hono application. All route handlers bind to an
// `env` object supplied at construction time (either the local bootstrap or
// the Cloudflare Workers fetch handler). Static-file serving is intentionally
// NOT part of this module: workers uses the platform `[assets]` binding and the
// local dev server adds service of WEB/client itself.
export function createApp(env: Env): Hono {
  const app = new Hono();

app.use("/api/auth/sign-up/email", async (c, next) => {
  if (c.req.header("x-internal-signup") !== internalSignupSecret()) {
    return c.json({ error: "Sign-up is by invitation only" }, 403);
  }
  await next();
});

// ---------- Password reset (public, before the Better Auth catch-all) ----------
registerAccountRoutes(app, env);


// Authenticated self-service password change (no e-mail required).

// Saves the signed-in user's UI language (en | tr).

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

// On Workers every request gets a fresh env that never saw the DB-stored
// settings, so GitHub routes pull just the GitHub credentials in themselves.
// (Deliberately not the whole settings table: e.g. a stale mail_from in the DB
// must not override the Worker's configured mail setup.)
app.use("/api/*", async (c, next) => {
  if (c.req.path.includes("/github")) await loadGithubSettings(env);
  await next();
});

// Strict per-user limiter for invitation creation (abuse containment).
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (c) => `invite:${c.req.header("x-forwarded-for") ?? "local"}`,
});

registerProjectRoutes(app, env);

// Unauthenticated liveness probe for monitoring / reverse-proxy checks.
app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

// ---------- First-run bootstrap (public) ----------
// Creates the initial SUPER_ADMIN. Only reachable while no super admin exists,
// so it is a secure one-time step: after the first admin is created it returns
// 409. Public sign-up is otherwise invitation-only, and the rate limit blocks
// brute-forcing this during setup.
const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFor: (c) => `setup:${clientIp(c)}`,
});

// Tells the first-run setup page whether a super admin already exists.
app.get("/api/setup/status", (c) =>
  guard(c, async () => {
    const [{ superAdminCount }] = await env.DB
      .select({ superAdminCount: count() })
      .from(user)
      .where(eq(user.role, "SUPER_ADMIN"));
    return c.json({ needed: Number(superAdminCount) === 0 });
  })
);

app.post("/api/setup/complete", setupLimiter, (c) =>
  guard(c, async () => {
    const [{ superAdminCount }] = await env.DB
      .select({ superAdminCount: count() })
      .from(user)
      .where(eq(user.role, "SUPER_ADMIN"));
    if (Number(superAdminCount) > 0) throw new ApiError(409, "Super admin already exists");

    const body = await readBody<{ email?: string; name?: string; password?: string }>(c);
    const email = body.email?.trim().toLowerCase();
    const name = body.name?.trim();
    const password = body.password ?? "";
    if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid e-mail address is required");
    if (!name) throw new ApiError(400, "Name is required");
    if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

    const auth = createAuth(env);
    const internalHeaders = new Headers({ "x-internal-signup": internalSignupSecret() });
    let userId: string;
    try {
      const result = await auth.api.signUpEmail({
        headers: internalHeaders,
        body: { email, name, password },
      });
      userId = result.user.id;
    } catch (e) {
      console.error("setup/complete signup failed:", e);
      throw new ApiError(409, `Could not create admin account: ${e instanceof Error ? e.message : "unknown error"}`);
    }

    await env.DB
      .update(user)
      .set({ role: "SUPER_ADMIN", updatedAt: new Date() })
      .where(eq(user.id, userId));

    return c.json({ ok: true, email, role: "SUPER_ADMIN" }, 201);
  })
);

registerTicketRoutes(app, env);






registerSprintRoutes(app, env);



// ---------- Super-admin panel API ----------

registerAdminAccessRoutes(app, env);

// Creates an account directly (name/e-mail/password set by the admin), no
// invite token and no e-mail sent. Mirrors /api/setup/complete's use of the
// internal sign-up header, just without the "no super admin yet" gate.








// Project-side view of the same memberships (kept in sync by design: both
// editors write to the project_members table).




// ---------- Access audit + overview (super admin) ----------


// Users x projects matrix: who has which role / permissions where.

registerSettingsRoutes(app, env);


// ---------- Reports: performance, completed work, forecast ----------
// Covers projects where the caller can see every ticket (super admin, project
// admins, members with VIEW_ALL_TICKETS). Optional ?projectId= narrows it.

registerReportRoutes(app, env);

// ---------- Dashboard stats (role-based, filterable) ----------


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




// Bulk update: apply the same change (status/type/priority/assignee/sprint)
// to many tickets at once, e.g. multi-select on the board or My Tickets.
// Not project-scoped in the URL — tickets can span multiple projects — so
// each one is checked and applied independently; a failure on one doesn't
// block the rest. Reuses applyTaskUpdate, so it enforces exactly the same
// per-field permission rules as a single-ticket PATCH.

// Bulk delete: permanent. Like the bulk update it is not project-scoped in
// the URL, so DELETE_TICKET is checked per ticket's project; tickets the
// caller may not delete are skipped and reported back (never a hard failure).

// ---------- GitHub integration ----------
// One private repo per project, connected through a GitHub App. GitHub pushes
// commits / PR events to the webhook (HMAC-verified); everything else is read
// from our own tables. Credentials live in Admin > Settings (or Worker secrets).

registerGithubRoutes(app, env);




// Commit tree of the project's repo (read live from GitHub through the App).

// Recent repo activity for the dashboard, limited to projects the viewer belongs to.





// Full change history of a single ticket, oldest first.

// Comments: every project member can read and write comments on any ticket.



// Uploaded media keys are always `<uuid>.<ext>`, generated server-side (see
// the upload handler below). Enforcing that shape on lookup closes off path
// traversal on the filesystem storage backend (`../../.env`-style keys),
// where a raw `name` param would otherwise be joined straight into a path.
const MEDIA_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{3,4}$/i;

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
  if (!MEDIA_NAME_RE.test(name)) return c.notFound();
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
    await requireProjectPermission(env.DB, u, projectId, "MANAGE_MEMBERS");
    const rows = await env.DB
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
    const access = await requireProjectPermission(env.DB, u, projectId, "MANAGE_MEMBERS");

    const body = await readBody<{ email?: string; role?: "ADMIN" | "MEMBER" }>(c);
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "Valid e-mail address is required");
    const invitedRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";
    // A MEMBER granted MANAGE_MEMBERS may invite other MEMBERs, but only an
    // actual project/super admin can grant the ADMIN role via invite.
    if (invitedRole === "ADMIN" && access.role !== "ADMIN") {
      throw new ApiError(403, "Only a project admin can invite someone as an admin");
    }

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
        inviteUrl,
      },
      201
    );
  })
);

app.post("/api/invitations/accept", (c) =>
  guard(c, async () => {
    const body = await readBody<{ token?: string; name?: string; password?: string }>(c);
    if (!body.token) throw new ApiError(400, "Missing invite token");
    const name = body.name?.trim();
    if (!name) throw new ApiError(400, "Name is required");
    const password = body.password;
    if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

    const auth = createAuth(env);
    const internalHeaders = new Headers({ "x-internal-signup": internalSignupSecret() });
    const signUp = async (email: string) => {
      const result = await auth.api.signUpEmail({
        headers: internalHeaders,
        body: { email, name, password },
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
        await ensureDefaultMemberPermissions(env.DB, projectInvitation.projectId, userId, projectInvitation.invitedRole);
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
        inviteUrl,
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

registerNotificationRoutes(app, env);






// ---------- Export / Import ----------

// Detailed export. The original keys (project / sprints[].name / tasks[] with a
// numeric `sprint` index) are kept so the file can still be fed to Import;
// everything else is extra context for humans, spreadsheets and backups.
// E-mail addresses are never included.
function csvCell(v: unknown): string {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function plainText(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .trim();
}

app.get("/api/projects/:id/export", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    // A full-project export doesn't make sense as a partial dump, so a
    // restricted member (no VIEW_ALL_TICKETS) can't use it at all.
    await requireProjectPermission(env.DB, u, projectId, "VIEW_ALL_TICKETS");
    const format = (c.req.query("format") || "json").toLowerCase();
    if (format !== "json" && format !== "csv") throw new ApiError(400, "format must be json or csv");

    const [project] = await env.DB.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");

    const projectSprints = await env.DB
      .select()
      .from(sprints)
      .where(eq(sprints.projectId, projectId))
      .orderBy(asc(sprints.createdAt));

    const projectTasks = await env.DB
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.position));

    const members = await env.DB
      .select({ userId: projectMembers.userId, role: projectMembers.role, name: user.name })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));
    const nameById = new Map(members.map((m) => [m.userId, m.name]));
    // Former members can still be an assignee / creator of old tickets.
    const extraIds = [...new Set(projectTasks.flatMap((t) => [t.assigneeId, t.createdBy]).filter((id): id is string => !!id && !nameById.has(id)))];
    for (let i = 0; i < extraIds.length; i += 50) {
      const rows = await env.DB.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, extraIds.slice(i, i + 50)));
      for (const r of rows) nameById.set(r.id, r.name);
    }

    // Join through tasks (not an id list) to stay under D1's bound-variable limit.
    const commentRows = await env.DB
      .select({ taskId: taskComments.taskId, body: taskComments.body, createdAt: taskComments.createdAt, authorName: user.name })
      .from(taskComments)
      .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
      .leftJoin(user, eq(user.id, taskComments.authorId))
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(taskComments.createdAt));
    const activityRows = await env.DB
      .select({
        taskId: activityLog.taskId, type: activityLog.eventType, oldStatus: activityLog.oldStatus,
        newStatus: activityLog.newStatus, oldValue: activityLog.oldValue, newValue: activityLog.newValue,
        createdAt: activityLog.createdAt, actorName: user.name,
      })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .leftJoin(user, eq(user.id, activityLog.actorId))
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(activityLog.createdAt));
    const linkRows = await env.DB
      .select({
        taskId: githubEventTasks.taskId, kind: githubEvents.kind, ref: githubEvents.ref, title: githubEvents.title,
        url: githubEvents.url, state: githubEvents.state, author: githubEvents.author, branch: githubEvents.branch,
      })
      .from(githubEventTasks)
      .innerJoin(githubEvents, eq(githubEvents.id, githubEventTasks.eventId))
      .where(eq(githubEvents.projectId, projectId));

    const by = <T extends { taskId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) (m.get(r.taskId) ?? m.set(r.taskId, []).get(r.taskId)!).push(r);
      return m;
    };
    const commentsBy = by(commentRows);
    const activityBy = by(activityRows);
    const linksBy = by(linkRows);

    const sprintById = new Map(projectSprints.map((sp, i) => [sp.id, { index: i, sprintId: sp.sprintId, name: sp.name }]));
    const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
    const branchOf = (t: { ticketId: string; type: string }) => `${t.type === "BUG" ? "hotfix" : "feature"}/${t.ticketId}`;

    if (format === "csv") {
      const header = [
        "Ticket ID", "Title", "Status", "Type", "Priority", "Labels", "Due date", "Sprint ID", "Sprint", "Assignee", "Created by",
        "Created", "Updated", "Branch", "Comments", "Linked commits/PRs", "Description",
      ];
      const lines = [header.map(csvCell).join(",")];
      // ?ids=GNR-1,GNR-2 limits the CSV to those tickets (the board's filtered view)
      const only = (c.req.query("ids") || "").split(",").map((x) => x.trim()).filter(Boolean);
      const wanted = only.length ? new Set(only) : null;
      for (const t of projectTasks) {
        if (wanted && !wanted.has(t.ticketId)) continue;
        const sp = t.sprintId ? sprintById.get(t.sprintId) : undefined;
        const links = (linksBy.get(t.id) ?? []).map((l) => (l.kind === "PR" ? `PR #${l.ref}` : l.ref.slice(0, 7))).join("; ");
        lines.push([
          t.ticketId, t.title, t.status, t.type, t.priority, parseLabels(t.labels).join("; "), t.dueDate ?? "", sp?.sprintId ?? "", sp?.name ?? "Backlog",
          t.assigneeId ? nameById.get(t.assigneeId) ?? "" : "", t.createdBy ? nameById.get(t.createdBy) ?? "" : "",
          iso(t.createdAt), iso(t.updatedAt), branchOf(t), (commentsBy.get(t.id) ?? []).length, links, plainText(t.description),
        ].map(csvCell).join(","));
      }
      return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${project.prefix}-export.csv"`,
        },
      });
    }

    const statusCounts: Record<string, number> = {};
    for (const t of projectTasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;

    return c.json({
      exportVersion: 3,
      instructions: buildEditInstructions({
        prefix: project.prefix,
        sprints: projectSprints.map((sp) => ({ sprintId: sp.sprintId, name: sp.name })),
        members: members.map((m) => m.name),
      }),
      exportedAt: new Date().toISOString(),
      exportedBy: u.name,
      project: {
        name: project.name,
        prefix: project.prefix,
        id: project.id,
        createdAt: iso(project.createdAt),
        githubRepo: project.githubRepo ?? null,
        defaultAssignee: project.defaultAssigneeId ? nameById.get(project.defaultAssigneeId) ?? null : null,
        lastTicketNumber: project.currentTicketSequence,
      },
      summary: { tickets: projectTasks.length, sprints: projectSprints.length, byStatus: statusCounts },
      members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
      sprints: projectSprints.map((sp) => ({
        name: sp.name,
        sprintId: sp.sprintId,
        id: sp.id,
        createdAt: iso(sp.createdAt),
        ticketCount: projectTasks.filter((t) => t.sprintId === sp.id).length,
      })),
      tasks: projectTasks.map((t) => {
        const sp = t.sprintId ? sprintById.get(t.sprintId) : undefined;
        return {
          ticketId: t.ticketId,
          id: t.id,
          title: t.title,
          description: t.description || undefined,
          status: t.status,
          type: t.type,
          priority: t.priority,
          sprint: sp ? sp.index : null,
          sprintId: sp?.sprintId ?? null,
          labels: parseLabels(t.labels),
          dueDate: t.dueDate ?? null,
          sprintName: sp?.name ?? null,
          assigneeId: t.assigneeId || undefined,
          assignee: t.assigneeId ? nameById.get(t.assigneeId) ?? null : null,
          createdBy: t.createdBy ? nameById.get(t.createdBy) ?? null : null,
          createdAt: iso(t.createdAt),
          updatedAt: iso(t.updatedAt),
          position: t.position,
          branch: branchOf(t),
          comments: (commentsBy.get(t.id) ?? []).map((cm) => ({ author: cm.authorName, createdAt: iso(cm.createdAt), body: cm.body })),
          activity: (activityBy.get(t.id) ?? []).map((a) => ({
            type: a.type, actor: a.actorName, createdAt: iso(a.createdAt),
            oldStatus: a.oldStatus, newStatus: a.newStatus, oldValue: a.oldValue, newValue: a.newValue,
          })),
          github: (linksBy.get(t.id) ?? []).map((l) => ({
            kind: l.kind, ref: l.ref, title: l.title, url: l.url, state: l.state, author: l.author, branch: l.branch,
          })),
        };
      }),
    });
  })
);

// ---------- Sync an existing project from an edited JSON export ----------
// Project admins only. POST {data, options, apply}: apply=false (default)
// returns a preview of what would change; apply=true performs it.

app.post("/api/projects/:id/sync", (c) =>
  guard(c, async () => {
    const projectId = c.req.param("id");
    const u = await getSessionUser(c.req.raw, env);
    const access = await getProjectAccess(env.DB, u, projectId);
    if (access.role !== "ADMIN") throw new ApiError(403, "Project admin role required");

    const body = await readBody<{ data?: unknown; options?: Partial<SyncOptions> & { fields?: Partial<SyncOptions["fields"]> }; apply?: boolean }>(c);
    const fileTasks = (body.data as { tasks?: unknown } | undefined)?.tasks;
    if (!Array.isArray(fileTasks)) throw new ApiError(400, "The JSON must contain a \"tasks\" list");
    if (fileTasks.length > 3000) throw new ApiError(400, "Too many tickets in one file (max 3000)");
    const options: SyncOptions = {
      create: body.options?.create ?? DEFAULT_SYNC_OPTIONS.create,
      update: body.options?.update ?? DEFAULT_SYNC_OPTIONS.update,
      remove: body.options?.remove ?? DEFAULT_SYNC_OPTIONS.remove,
      fields: { ...DEFAULT_SYNC_OPTIONS.fields, ...(body.options?.fields ?? {}) },
    };

    const [project] = await env.DB.select({ id: projects.id, prefix: projects.prefix }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new ApiError(404, "Project not found");
    const [rows, sprintRows, memberRows] = await Promise.all([
      env.DB.select().from(tasks).where(eq(tasks.projectId, projectId)),
      env.DB.select({ id: sprints.id, sprintId: sprints.sprintId, name: sprints.name }).from(sprints).where(eq(sprints.projectId, projectId)),
      env.DB.select({ userId: projectMembers.userId, name: user.name, email: user.email })
        .from(projectMembers).innerJoin(user, eq(user.id, projectMembers.userId)).where(eq(projectMembers.projectId, projectId)),
    ]);

    const plan = planSync({
      file: body.data, options, sprints: sprintRows, members: memberRows,
      tasks: rows.map((t) => ({
        id: t.id, ticketId: t.ticketId, title: t.title, description: t.description, status: t.status,
        type: t.type, priority: t.priority, sprintId: t.sprintId, assigneeId: t.assigneeId,
        labels: parseLabels(t.labels), dueDate: t.dueDate ?? null, position: t.position,
      })),
    });

    const summary = {
      creates: plan.creates.map((t) => ({ title: t.title, status: t.status, sourceTicketId: t.sourceTicketId })),
      updates: plan.updates.slice(0, 500).map((x) => ({ ticketId: x.ticketId, title: x.title, changes: x.changes })),
      updateCount: plan.updates.length,
      missing: plan.missing.slice(0, 500),
      missingCount: plan.missing.length,
      deleteCount: plan.deletes.length,
      sprintsToCreate: plan.sprintsToCreate,
      unchanged: plan.unchanged,
      warnings: plan.warnings.slice(0, 100),
    };
    if (!body.apply) return c.json({ applied: false, plan: summary });

    // ---- apply ----
    const now = Date.now();
    const sprintIdByName = new Map<string, string>();
    for (const name of plan.sprintsToCreate) {
      const code = await nextSprintId({ db: env.DB }, projectId, project.prefix);
      const id = crypto.randomUUID();
      await env.DB.insert(sprints).values({ id, projectId, sprintId: code, name, createdAt: now });
      sprintIdByName.set(name.trim().toLowerCase(), id);
    }
    const targetId = (t: SprintTarget): string | null =>
      t.kind === "backlog" ? null : t.kind === "id" ? t.id : (sprintIdByName.get(t.name.trim().toLowerCase()) ?? null);
    const sprintCode = new Map(sprintRows.map((s) => [s.id, s.sprintId]));
    const label = (id: string | null) => (id ? (sprintCode.get(id) ?? id) : "Backlog");
    const nameOf = (id: string | null) => (id ? (memberRows.find((m) => m.userId === id)?.name ?? id) : null);
    const endOf = async (status: string) => {
      const [{ maxPos }] = await env.DB
        .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
        .from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)));
      return Number(maxPos) + 1;
    };

    for (const upd of plan.updates) {
      const before = rows.find((r) => r.id === upd.id)!;
      const p = upd.patch;
      const values: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
      if (p.title !== undefined) values.title = p.title;
      if (p.description !== undefined) values.description = p.description;
      if (p.type !== undefined) values.type = p.type as "TASK" | "BUG";
      if (p.priority !== undefined) values.priority = p.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      if (p.status !== undefined) values.status = p.status;
      if (p.position === null && p.status !== undefined) values.position = await endOf(p.status);
      else if (typeof p.position === "number") values.position = p.position;
      if (p.sprint !== undefined) values.sprintId = targetId(p.sprint);
      if (p.assigneeId !== undefined) values.assigneeId = p.assigneeId;
      if (p.labels !== undefined) values.labels = p.labels.length ? JSON.stringify(p.labels) : null;
      if (p.dueDate !== undefined) values.dueDate = p.dueDate;
      await env.DB.update(tasks).set(values).where(and(eq(tasks.id, upd.id), eq(tasks.projectId, projectId)));

      const log = (eventType: Parameters<typeof logActivity>[1]["eventType"], extra: { oldStatus?: string; newStatus?: string; oldValue?: string | null; newValue?: string | null } = {}) =>
        logActivity(env.DB, { taskId: upd.id, actorId: u.id, eventType, ...extra });
      if (p.status !== undefined) await log("STATUS_CHANGED", { oldStatus: before.status, newStatus: p.status });
      if (p.title !== undefined) await log("TITLE_CHANGED", { oldValue: before.title, newValue: p.title });
      if (p.description !== undefined) await log("DESCRIPTION_CHANGED", { newValue: plainText(p.description ?? "").slice(0, 200) });
      if (p.type !== undefined) await log("TYPE_CHANGED", { oldValue: before.type, newValue: p.type });
      if (p.priority !== undefined) await log("PRIORITY_CHANGED", { oldValue: before.priority, newValue: p.priority });
      if (p.assigneeId !== undefined) await log("ASSIGNEE_CHANGED", { oldValue: nameOf(before.assigneeId), newValue: nameOf(p.assigneeId) });
      if (p.sprint !== undefined) await log("SPRINT_CHANGED", { oldValue: label(before.sprintId), newValue: label(targetId(p.sprint)) });
    }

    let created = 0;
    for (const cr of plan.creates) {
      const ticketId = await allocateTicketId(env.DB, projectId);
      const [task] = await env.DB.insert(tasks).values({
        id: crypto.randomUUID(), projectId, ticketId, title: cr.title, description: cr.description,
        status: cr.status, type: cr.type as "TASK" | "BUG", priority: cr.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
        assigneeId: cr.assigneeId, sprintId: targetId(cr.sprint),
        labels: cr.labels.length ? JSON.stringify(cr.labels) : null, dueDate: cr.dueDate,
        createdBy: u.id, position: await endOf(cr.status), createdAt: now, updatedAt: now,
      }).returning();
      await logActivity(env.DB, { taskId: task.id, actorId: u.id, eventType: "CREATED", newStatus: cr.status });
      created++;
    }

    let deleted = 0;
    const ids = plan.deletes.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await env.DB.delete(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, chunk))).returning({ id: tasks.id });
      deleted += res.length;
    }

    publish(projectId, { type: "synced", actorId: u.id });
    return c.json({ applied: true, plan: summary, result: { created, updated: plan.updates.length, deleted, sprintsCreated: plan.sprintsToCreate.length } });
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
        labels?: string[];
        dueDate?: string | null;
      }[];
    }>(c);

    const projectName = body.project?.name?.trim();
    const prefix = body.project?.prefix?.trim().toUpperCase();
    if (!projectName) throw new ApiError(400, "Project name is required");
    if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
      throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
    }
    if (!body.sprints?.length && !body.tasks?.length) throw new ApiError(400, "At least one sprint or ticket is required");
    const sprintList = body.sprints ?? [];

    const [taken] = await env.DB.select({ id: projects.id }).from(projects).where(eq(projects.prefix, prefix));
    if (taken) throw new ApiError(409, `The prefix ${prefix} is already used by another project`);
    // Exports carry user ids from the instance they came from; keep only the ones that exist here.
    const knownUsers = new Set((await env.DB.select({ id: user.id }).from(user)).map((r) => r.id));

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

    for (let i = 0; i < sprintList.length; i++) {
      const s = sprintList[i];
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

      // Imported files may carry odd labels; drop them rather than fail the whole import.
      let importLabels: string[] = [];
      try { importLabels = t.labels === undefined ? [] : normalizeLabels(t.labels); } catch { /* ignore */ }

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
        assigneeId: t.assigneeId && knownUsers.has(t.assigneeId) ? t.assigneeId : null,
        sprintId: sprintUuid,
        createdBy: u.id,
        labels: importLabels.length ? JSON.stringify(importLabels) : null,
        dueDate: t.dueDate && isValidDueDate(t.dueDate) ? t.dueDate : null,
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
