import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/settings";

export function registerSettingsRoutes(app: Hono, env: Env): void {
  app.get("/api/admin/settings", (c) =>
    guard(c, async () => c.json(await a.getSettings(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/admin/settings", (c) =>
    guard(c, async () => c.json(await a.updateSettings(await requestCtx(c, env), inputOf(c))))
  );
}
