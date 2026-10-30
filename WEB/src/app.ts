import { Hono } from "hono";
import { createAuth } from "./auth/server";
import { internalSignupSecret } from "./shared/signup-secret";
import { clientIp, rateLimit } from "./shared/ratelimit";
import { registerAccountRoutes, registerOnboardingRoutes } from "./domains/accounts/index";
import { registerAdminAccessRoutes } from "./domains/access/index";
import { registerGithubRoutes } from "./domains/github/index";
import { registerNotificationRoutes } from "./domains/notifications/index";
import { registerInvitationRoutes, registerProjectRoutes, registerTransferRoutes } from "./domains/projects/index";
import { registerReportRoutes } from "./domains/reports/index";
import { registerCronRoutes, registerSettingsRoutes, loadGithubSettings } from "./domains/settings/index";
import { registerSprintRoutes } from "./domains/sprints/index";
import { registerMediaRoutes, registerStreamRoutes, registerTicketRoutes } from "./domains/tickets/index";

// Shared runtime-agnostic Hono application. This module only wires middleware
// and mounts each domain's routes (see DOC/adr/0001-modular-domains.md); all
// handlers bind to an `env` object supplied at construction time (either the
// local bootstrap or the Cloudflare Workers fetch handler). Static-file serving
// is intentionally NOT part of this module: workers uses the platform
// `[assets]` binding and the local dev server adds service of WEB/client itself.
export function createApp(env: Env): Hono {
  const app = new Hono();

  // Public sign-up is closed: accounts are created only through invitations.
  // The internal accept-invite flow passes the secret header when calling
  // auth.api.signUpEmail directly (bypasses HTTP, so it is unaffected anyway).
  app.use("/api/auth/sign-up/email", async (c, next) => {
    if (c.req.header("x-internal-signup") !== internalSignupSecret()) {
      return c.json({ error: "Sign-up is by invitation only" }, 403);
    }
    await next();
  });

  // Password reset, change and language: public routes must come before the
  // Better Auth catch-all below.
  registerAccountRoutes(app, env);

  app.all("/api/auth/*", (c) => createAuth(env).handler(c.req.raw));

  // General API rate limit (generous; per client IP).
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

  // Unauthenticated liveness probe for monitoring / reverse-proxy checks.
  app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

  registerProjectRoutes(app, env);
  registerOnboardingRoutes(app, env);
  registerTicketRoutes(app, env);
  registerStreamRoutes(app, env);
  registerSprintRoutes(app, env);
  registerAdminAccessRoutes(app, env);
  registerSettingsRoutes(app, env);
  registerReportRoutes(app, env);
  registerGithubRoutes(app, env);
  registerMediaRoutes(app, env);
  registerInvitationRoutes(app, env);
  registerCronRoutes(app, env);
  registerNotificationRoutes(app, env);
  registerTransferRoutes(app, env);

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  return app;
}
