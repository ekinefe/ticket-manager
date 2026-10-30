import { Hono, type Context } from "hono";
import { createAuth } from "./auth/server";
import { ApiError } from "./shared/http";
import { guard, readBody } from "./shared/route";
import { INTERNAL_SIGNUP_SECRET } from "./shared/signup-secret";
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
import { registerOnboardingRoutes } from "./domains/accounts/index";
import { registerInvitationRoutes } from "./domains/projects/index";
import { registerTransferRoutes } from "./domains/projects/index";
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
  if (c.req.header("x-internal-signup") !== INTERNAL_SIGNUP_SECRET) {
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

registerProjectRoutes(app, env);

// Unauthenticated liveness probe for monitoring / reverse-proxy checks.
app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

// ---------- First-run bootstrap (public) ----------
// Creates the initial SUPER_ADMIN. Only reachable while no super admin exists,
// so it is a secure one-time step: after the first admin is created it returns
// 409. Public sign-up is otherwise invitation-only, and the rate limit blocks
// brute-forcing this during setup.
// Tells the first-run setup page whether a super admin already exists.
registerOnboardingRoutes(app, env);


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

registerInvitationRoutes(app, env);




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






registerTransferRoutes(app, env);

// ---------- Sync an existing project from an edited JSON export ----------
// Project admins only. POST {data, options, apply}: apply=false (default)
// returns a preview of what would change; apply=true performs it.



app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  return app;
}
