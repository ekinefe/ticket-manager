import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, inputOf, respond } from "../../shared/route";
import * as a from "./actions/cron";

export function registerCronRoutes(app: Hono, env: Env): void {
  app.post("/api/dev/cron/:job", (c) =>
    guard(c, async () => respond(c, await a.runCronJob(await requestCtx(c, env), inputOf(c))))
  );
}
