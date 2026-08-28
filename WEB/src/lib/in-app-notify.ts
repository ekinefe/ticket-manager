import { eq, and, isNull, sql } from "drizzle-orm";
import { notifications, projectMembers, user, tasks, projects } from "../db/schema";
import { getDb, type AppDB } from "../db/client";

export type NotificationType =
  | "TICKET_CREATED"
  | "STATUS_CHANGED"
  | "ASSIGNED"
  | "MENTIONED"
  | "COMMENT_ADDED"
  | "SPRINT_CHANGED"
  | "PROJECT_INVITE"
  | "MEMBER_ADDED";

interface NotifySingle {
  db: AppDB;
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  taskId?: string | null;
  projectId: string;
  message: string;
}

interface NotifyProject {
  db: AppDB;
  projectId: string;
  actorId?: string | null;
  type: NotificationType;
  taskId?: string | null;
  message: string;
  excludeUserIds?: string[];
}

interface NotifyAdmins {
  db: AppDB;
  actorId?: string | null;
  type: NotificationType;
  taskId?: string | null;
  projectId: string;
  message: string;
  excludeUserIds?: string[];
}

interface NotifySuperAdmins {
  db: AppDB;
  actorId?: string | null;
  type: NotificationType;
  taskId?: string | null;
  projectId: string;
  message: string;
  excludeUserIds?: string[];
}

export async function createNotification({
  db,
  userId,
  actorId,
  type,
  taskId,
  projectId,
  message,
}: NotifySingle): Promise<void> {
  await getDb(db).insert(notifications).values({
    id: crypto.randomUUID(),
    userId,
    actorId: actorId ?? null,
    type,
    taskId: taskId ?? null,
    projectId,
    message,
    createdAt: Date.now(),
  });
}

export async function createProjectNotification({
  db,
  projectId,
  actorId,
  type,
  taskId,
  message,
  excludeUserIds = [],
}: NotifyProject): Promise<void> {
  const rows = await getDb(db)
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const recipients = rows
    .map((r) => r.userId)
    .filter((id) => id !== actorId && !excludeUserIds.includes(id));

  if (recipients.length === 0) return;

  const now = Date.now();
  await getDb(db).insert(notifications).values(
    recipients.map((userId) => ({
      id: crypto.randomUUID(),
      userId,
      actorId: actorId ?? null,
      type,
      taskId: taskId ?? null,
      projectId,
      message,
      createdAt: now,
    }))
  );
}

export async function createAdminNotification({
  db,
  actorId,
  type,
  taskId,
  projectId,
  message,
  excludeUserIds = [],
}: NotifyAdmins): Promise<void> {
  const rows = await getDb(db)
    .select({ id: user.id })
    .from(user)
    .where(sql`${user.role} in ('ADMIN', 'SUPER_ADMIN')`);

  const recipients = rows
    .map((r) => r.id)
    .filter((id) => id !== actorId && !excludeUserIds.includes(id));

  if (recipients.length === 0) return;

  const now = Date.now();
  await getDb(db).insert(notifications).values(
    recipients.map((userId) => ({
      id: crypto.randomUUID(),
      userId,
      actorId: actorId ?? null,
      type,
      taskId: taskId ?? null,
      projectId,
      message,
      createdAt: now,
    }))
  );
}

export async function createSuperAdminNotification({
  db,
  actorId,
  type,
  taskId,
  projectId,
  message,
  excludeUserIds = [],
}: NotifySuperAdmins): Promise<void> {
  const rows = await getDb(db)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "SUPER_ADMIN"));

  const recipients = rows
    .map((r) => r.id)
    .filter((id) => id !== actorId && !excludeUserIds.includes(id));

  if (recipients.length === 0) return;

  const now = Date.now();
  await getDb(db).insert(notifications).values(
    recipients.map((userId) => ({
      id: crypto.randomUUID(),
      userId,
      actorId: actorId ?? null,
      type,
      taskId: taskId ?? null,
      projectId,
      message,
      createdAt: now,
    }))
  );
}
