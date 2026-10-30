import type { Hono } from "hono";
import { optionalCtx, publicCtx, requestCtx } from "../access/index";
import { guard, inputOf, respond } from "../../shared/route";
import { inviteLimiter } from "../../shared/limiters";
import * as a from "./actions/invitations";

export function registerInvitationRoutes(app: Hono, env: Env): void {
  app.get("/api/projects/:id/invitations", (c) =>
    guard(c, async () => respond(c, await a.listInvitations(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/:id/invitations", inviteLimiter, (c) =>
    guard(c, async () => respond(c, await a.inviteToProject(await requestCtx(c, env), inputOf(c)), 201))
  );
}
