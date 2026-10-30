import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/projects";

export function registerProjectRoutes(app: Hono, env: Env): void {
  app.get("/api/projects", (c) =>
    guard(c, async () => c.json(await a.listMyProjects(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects", (c) =>
    guard(c, async () => c.json(await a.createProject(await requestCtx(c, env), inputOf(c)), 201))
  );

  app.get("/api/projects/:id", (c) =>
    guard(c, async () => c.json(await a.getProject(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/projects/:id", (c) =>
    guard(c, async () => c.json(await a.updateProject(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/projects/:id", (c) =>
    guard(c, async () => c.json(await a.deleteProject(await requestCtx(c, env), inputOf(c))))
  );
}
