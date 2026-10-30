import { and, eq, sql, isNull, count, desc } from "drizzle-orm";
import { user, notifications } from "../../../db/schema";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";

// In-app notification inbox. Every query is scoped to the signed-in user.
export async function unreadCount(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)));
  return { count: n };
}

export async function listNotifications(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const limit = Math.min(Number(input.query("limit") || 30), 100);
  const offset = Number(input.query("offset") || 0);

  const rows = await ctx.db
    .select({
      id: notifications.id,
      type: notifications.type,
      taskId: notifications.taskId,
      projectId: notifications.projectId,
      message: notifications.message,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actorId: notifications.actorId,
      actorName: user.name,
    })
    .from(notifications)
    .leftJoin(user, eq(user.id, notifications.actorId))
    .where(eq(notifications.userId, u.id))
    .orderBy(sql`${notifications.createdAt} desc`)
    .limit(limit)
    .offset(offset);

  const [{ total }] = await ctx.db
    .select({ total: sql<number>`count(*)` })
    .from(notifications)
    .where(eq(notifications.userId, u.id));

  return { notifications: rows, total };
}

export async function markRead(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const id = input.p.id;
  await ctx.db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
  return { ok: true };
}

export async function markUnread(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const id = input.p.id;
  await ctx.db
    .update(notifications)
    .set({ readAt: null })
    .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
  return { ok: true };
}

export async function markAllRead(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  await ctx.db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)));
  return { ok: true };
}

export async function deleteNotification(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const id = input.p.id;
  await ctx.db
    .delete(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, u.id)));
  return { ok: true };
}
