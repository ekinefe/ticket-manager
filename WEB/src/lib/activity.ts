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
}

export async function logActivity(
  db: AppDB,
  { taskId, actorId, eventType, oldStatus, newStatus, oldValue, newValue }: ActivityInput
): Promise<void> {
  await getDb(db).insert(activityLog).values({
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
