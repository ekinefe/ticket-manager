import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, inputOf } from "../../shared/route";
import * as a from "./actions/notifications";

export function registerNotificationRoutes(app: Hono, env: Env): void {
  app.get("/api/notifications/unread-count", (c) =>
    guard(c, async () => c.json(await a.unreadCount(await requestCtx(c, env), inputOf(c))))
  );

  app.get("/api/notifications", (c) =>
    guard(c, async () => c.json(await a.listNotifications(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/notifications/:id/read", (c) =>
    guard(c, async () => c.json(await a.markRead(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/notifications/:id/unread", (c) =>
    guard(c, async () => c.json(await a.markUnread(await requestCtx(c, env), inputOf(c))))
  );

  app.patch("/api/notifications/read-all", (c) =>
    guard(c, async () => c.json(await a.markAllRead(await requestCtx(c, env), inputOf(c))))
  );

  app.delete("/api/notifications/:id", (c) =>
    guard(c, async () => c.json(await a.deleteNotification(await requestCtx(c, env), inputOf(c))))
  );
}
