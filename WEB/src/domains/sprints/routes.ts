import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, readBody } from "../../shared/route";
import { createSprint, deleteSprint, renameSprint } from "./actions/sprints";

// Only project admins (MANAGE_SPRINTS) may create, rename or delete sprints.
// A project must always keep at least one sprint.
export function registerSprintRoutes(app: Hono, env: Env): void {
  app.post("/api/projects/:id/sprints", (c) =>
    guard(c, async () => {
      const ctx = await requestCtx(c, env);
      const body = await readBody<{ name?: string }>(c);
      return c.json(await createSprint(ctx, c.req.param("id"), body.name), 201);
    })
  );

  app.patch("/api/projects/:id/sprints/:sid", (c) =>
    guard(c, async () => {
      const ctx = await requestCtx(c, env);
      const body = await readBody<{ name?: string }>(c);
      return c.json(await renameSprint(ctx, c.req.param("id"), c.req.param("sid"), body.name));
    })
  );

  app.delete("/api/projects/:id/sprints/:sid", (c) =>
    guard(c, async () => {
      const ctx = await requestCtx(c, env);
      await deleteSprint(ctx, c.req.param("id"), c.req.param("sid"));
      return c.json({ ok: true });
    })
  );
}
