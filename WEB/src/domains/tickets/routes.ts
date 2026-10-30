import type { Hono } from "hono";
import { optionalCtx, requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/tickets";

export function registerTicketRoutes(app: Hono, env: Env): void {
  app.get("/api/my-tickets", (c) =>
    guard(c, async () => c.json(await a.myTickets(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/my-tickets/unassigned", (c) =>
    guard(c, async () => c.json(await a.myUnassignedTickets(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/all-tickets", (c) =>
    guard(c, async () => c.json(await a.allTickets(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/search", (c) =>
    guard(c, async () => c.json(await a.searchEverything(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/projects/:id/tasks", (c) =>
    guard(c, async () => c.json(await a.listTasks(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/:id/tasks", (c) =>
    guard(c, async () => c.json(await a.createTask(await requestCtx(c, env), inputOf(c)), 201))
  );

  app.patch("/api/projects/:id/tasks/:taskId", (c) =>
    guard(c, async () => c.json(await a.updateTask(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/tasks/bulk", (c) =>
    guard(c, async () => c.json(await a.bulkUpdateTasks(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/tasks/bulk-delete", (c) =>
    guard(c, async () => c.json(await a.bulkDeleteTasks(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/projects/:id/tasks/:taskId", (c) =>
    guard(c, async () => c.json(await a.deleteTask(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/projects/:id/tasks/:taskId/comments", (c) =>
    guard(c, async () => c.json(await a.listComments(await requestCtx(c, env), inputOf(c))))
  );

  app.post("/api/projects/:id/tasks/:taskId/comments", (c) =>
    guard(c, async () => c.json(await a.addComment(await requestCtx(c, env), inputOf(c)), 201))
  );

  app.get("/api/projects/:id/tasks/:taskId/events", (c) =>
    guard(c, async () => c.json(await a.taskEvents(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/projects/:id/tasks/:taskId/share", (c) =>
    guard(c, async () => c.json(await a.getTaskShare(await requestCtx(c, env), inputOf(c))))
  );

  app.put("/api/projects/:id/tasks/:taskId/share", (c) =>
    guard(c, async () => c.json(await a.setTaskShare(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/share/:token", (c) =>
    guard(c, async () => c.json(await a.viewSharedTicket(await optionalCtx(c, env), inputOf(c))))
  );
}
