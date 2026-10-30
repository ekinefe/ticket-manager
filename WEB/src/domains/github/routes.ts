import type { Hono } from "hono";
import { publicCtx, requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/github";

export function registerGithubRoutes(app: Hono, env: Env): void {
  app.post("/api/github/webhook", (c) =>
    guard(c, async () => c.json(await a.receiveWebhook(publicCtx(env), inputOf(c))))
  );

  app.patch("/api/projects/:id/github", (c) =>
    guard(c, async () => c.json(await a.setProjectRepo(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/projects/:id/tasks/:taskId/github", (c) =>
    guard(c, async () => c.json(await a.getTaskGithub(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/:id/tasks/:taskId/github/branch", (c) =>
    guard(c, async () => c.json(await a.createTaskBranch(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/projects/:id/github/graph", (c) =>
    guard(c, async () => c.json(await a.projectGraph(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/github/activity", (c) =>
    guard(c, async () => c.json(await a.githubActivity(await requestCtx(c, env), inputOf(c))))
  );
}
