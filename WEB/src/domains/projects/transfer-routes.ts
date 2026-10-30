import type { Hono } from "hono";
import { optionalCtx, publicCtx, requestCtx } from "../access/index";
import { guard, inputOf, respond } from "../../shared/route";
import * as a from "./actions/transfer";

export function registerTransferRoutes(app: Hono, env: Env): void {
  app.get("/api/projects/:id/export", (c) =>
    guard(c, async () => respond(c, await a.exportProject(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/:id/sync", (c) =>
    guard(c, async () => respond(c, await a.syncProject(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/import", (c) =>
    guard(c, async () => respond(c, await a.importProject(await requestCtx(c, env), inputOf(c)), 201))
  );
}
