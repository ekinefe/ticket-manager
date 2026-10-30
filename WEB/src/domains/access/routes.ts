import type { Hono } from "hono";
import { publicCtx, requestCtx } from "./ctx";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/admin";

export function registerAdminAccessRoutes(app: Hono, env: Env): void {
  app.get("/api/admin/users", (c) =>
    guard(c, async () => c.json(await a.listUsers(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/admin/users", (c) =>
    guard(c, async () => c.json(await a.createUser(await requestCtx(c, env), inputOf(c)), 201))
  );

  app.patch("/api/admin/users/:id", (c) =>
    guard(c, async () => c.json(await a.setUserRole(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/admin/users/:id/password", (c) =>
    guard(c, async () => c.json(await a.setUserPassword(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/admin/users/:id", (c) =>
    guard(c, async () => c.json(await a.deleteUser(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/admin/users/:id", (c) =>
    guard(c, async () => c.json(await a.getUser(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/admin/users/:id/projects", (c) =>
    guard(c, async () => c.json(await a.addUserToProject(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/admin/users/:id/projects/:projectId/permissions", (c) =>
    guard(c, async () => c.json(await a.setUserProjectPermissions(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/admin/users/:id/projects/:projectId", (c) =>
    guard(c, async () => c.json(await a.removeUserFromProject(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/admin/projects/:id/members", (c) =>
    guard(c, async () => c.json(await a.listProjectMembers(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/admin/projects/:id/members/:userId/permissions", (c) =>
    guard(c, async () => c.json(await a.setMemberPermissionsAdmin(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/admin/projects/:id/members", (c) =>
    guard(c, async () => c.json(await a.addProjectMember(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/admin/projects/:id/members/:userId", (c) =>
    guard(c, async () => c.json(await a.removeProjectMember(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/admin/audit", (c) =>
    guard(c, async () => c.json(await a.listAudit(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/admin/access", (c) =>
    guard(c, async () => c.json(await a.accessMatrix(await requestCtx(c, env), inputOf(c))))
  );
}
