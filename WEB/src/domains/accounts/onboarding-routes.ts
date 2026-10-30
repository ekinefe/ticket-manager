import type { Hono } from "hono";
import { optionalCtx, publicCtx, requestCtx } from "../access/index";
import { guard, inputOf, respond } from "../../shared/route";
import { clientIp, rateLimit } from "../../shared/ratelimit";
import { inviteLimiter } from "../../shared/limiters";
import * as a from "./actions/onboarding";

export function registerOnboardingRoutes(app: Hono, env: Env): void {
  const setupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyFor: (c) => `setup:${clientIp(c)}`,
  });

  app.get("/api/setup/status", (c) =>
    guard(c, async () => respond(c, await a.setupStatus(publicCtx(env), inputOf(c))))
  );

  app.post("/api/setup/complete", setupLimiter, (c) =>
    guard(c, async () => respond(c, await a.completeSetup(publicCtx(env), inputOf(c)), 201))
  );

  app.post("/api/invitations/accept", (c) =>
    guard(c, async () => respond(c, await a.acceptInvitation(publicCtx(env), inputOf(c))))
  );

  app.post("/api/admin/invites", inviteLimiter, (c) =>
    guard(c, async () => respond(c, await a.inviteAccount(await requestCtx(c, env), inputOf(c)), 201))
  );
}
