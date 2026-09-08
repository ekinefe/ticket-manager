import { and, desc, eq, isNull } from "drizzle-orm";
import { activityLog } from "../db/schema";
import { getDb } from "../db/client";
import type { AppDB } from "../db/client";

export type ActivityEventType =
  | "CREATED"
  | "STATUS_CHANGED"
  | "TITLE_CHANGED"
  | "DESCRIPTION_CHANGED"
  | "ASSIGNEE_CHANGED"
  | "TYPE_CHANGED"
  | "PRIORITY_CHANGED"
  | "SPRINT_CHANGED";

export interface ActivityInput {
  taskId: string;
  actorId?: string | null;
  eventType: ActivityEventType;
  oldStatus?: string | null;
  newStatus?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  // When set, and the most recent log entry for this task+eventType+actor
  // was written within this many ms, that entry is updated in place
  // (newValue + timestamp bumped) instead of inserting a new row. Keeps
  // autosave-driven fields (title, description) from spamming the activity
  // feed with one row per debounce tick while someone is actively editing.
  coalesceWindowMs?: number;
}

export async function logActivity(
  db: AppDB,
  { taskId, actorId, eventType, oldStatus, newStatus, oldValue, newValue, coalesceWindowMs }: ActivityInput
): Promise<void> {
  const d = getDb(db);

  if (coalesceWindowMs) {
    const [last] = await d
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.taskId, taskId),
          eq(activityLog.eventType, eventType),
          actorId ? eq(activityLog.actorId, actorId) : isNull(activityLog.actorId)
        )
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);

    if (last && Date.now() - last.createdAt <= coalesceWindowMs) {
      await d
        .update(activityLog)
        .set({ newValue: newValue ?? null, newStatus: newStatus ?? null, createdAt: Date.now() })
        .where(eq(activityLog.id, last.id));
      return;
    }
  }

  await d.insert(activityLog).values({
    id: crypto.randomUUID(),
    taskId,
    actorId: actorId ?? null,
    eventType,
    oldStatus: oldStatus ?? null,
    newStatus: newStatus ?? null,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    createdAt: Date.now(),
  });
}
