import type { Hono } from "hono";
import { publicCtx, requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import { clientIp, rateLimit } from "../../shared/ratelimit";
import * as a from "./actions/accounts";

export function registerAccountRoutes(app: Hono, env: Env): void {
  const passwordResetRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyFor: (c) => `pwreq:${clientIp(c)}`,
  });
  const passwordResetApplyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFor: (c) => `pwapply:${clientIp(c)}`,
  });

  app.post("/api/auth/request-password-reset", passwordResetRequestLimiter, (c) =>
    guard(c, async () => c.json(await a.requestPasswordReset(publicCtx(env), inputOf(c))))
  );

  app.post("/api/auth/reset-password", passwordResetApplyLimiter, (c) =>
    guard(c, async () => c.json(await a.resetPassword(publicCtx(env), inputOf(c))))
  );

  app.post("/api/auth/change-password", (c) =>
    guard(c, async () => c.json(await a.changeOwnPassword(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/me/language", (c) =>
    guard(c, async () => c.json(await a.setLanguage(await requestCtx(c, env), inputOf(c))))
  );
}
