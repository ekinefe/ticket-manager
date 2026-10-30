import { and, eq, or } from "drizzle-orm";
import { tasks, user, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { publish } from "../../../shared/realtime";
import { sanitizeDescHtml } from "../../../shared/sanitize";
import { logActivity } from "../activity";
import { canTransition, isStatus, type Status } from "../status";
import { normalizeLabels } from "../labels";
import { computePosition } from "../queries/positions";
import { getProjectAccess } from "../../access/index";
import { createNotification, notifyMentionedUsers, isStatusMailEnabled, notifyStatusChanged } from "../../notifications/index";
import type { Ctx } from "../../access/index";

export const TASK_TYPES = ["TASK", "BUG"];
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
// Consecutive title/description autosaves by the same actor within this
// window are folded into one activity-log entry instead of a new row each.
export const ACTIVITY_COALESCE_MS = 5 * 60 * 1000;

// Short plain-text preview of a description for the activity log.
export const descPreview = (html: string | null | undefined): string => {
  const text = String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
};

export function isValidDueDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface TaskUpdateBody {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  status?: string;
  beforeTaskId?: string;
  type?: string;
  priority?: string;
  sprintId?: string | null;
  labels?: string[];
  dueDate?: string | null;
}

// Shared by the single-ticket PATCH route and the bulk-update endpoint.
// `expectedProjectId` lets the single-ticket route keep its URL-scoped
// 404-on-mismatch behavior; the bulk endpoint (not project-scoped in its
// URL) omits it and trusts each task's own projectId.
export async function applyTaskUpdate(
  ctx: Ctx,
  taskId: string,
  body: TaskUpdateBody,
  expectedProjectId?: string
): Promise<typeof tasks.$inferSelect> {
  const u = ctx.user;
    const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task || (expectedProjectId && task.projectId !== expectedProjectId)) {
      throw new ApiError(404, "Task not found");
    }
    const projectId = task.projectId;
    const access = await getProjectAccess(ctx.db, u, projectId);
    const myRole = access.role;

    // Members may only modify tickets they are assigned to or created,
    // unless explicitly granted MOVE_OTHERS_TICKETS; project admins and
    // super admins can modify anything.
    const isOwnTicket = task.assigneeId === u.id || task.createdBy === u.id;
    if (myRole !== "ADMIN" && !isOwnTicket && !access.can("MOVE_OTHERS_TICKETS")) {
      throw new ApiError(403, "Only the assignee, the ticket creator, a project admin, or someone granted MOVE_OTHERS_TICKETS can modify this ticket");
    }

    const oldTitle = task.title;
    const oldDescription = task.description;
    const oldAssigneeId = task.assigneeId;
    const oldType = task.type;
    const oldPriority = task.priority;
    const oldSprintId = task.sprintId;

    const values: Partial<typeof tasks.$inferInsert> = {};
    if (body.title !== undefined) values.title = body.title.trim();
    if (body.description !== undefined) values.description = sanitizeDescHtml(body.description ?? "") || null;
    if (body.type !== undefined) {
      // Changing the ticket type (and therefore its branch prefix) is admin-only.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can change the ticket type");
      if (!TASK_TYPES.includes(body.type)) throw new ApiError(400, `Invalid type: ${String(body.type)}`);
      values.type = body.type as "TASK" | "BUG";
    }
    if (body.priority !== undefined) {
      // Priority changes are admin-only.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can change the priority");
      if (!PRIORITIES.includes(body.priority)) throw new ApiError(400, `Invalid priority: ${String(body.priority)}`);
      values.priority = body.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    }
    if (body.sprintId !== undefined) {
      if (body.sprintId) {
        const [sprint] = await ctx.db.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.id, body.sprintId), eq(sprints.projectId, projectId)));
        if (!sprint) throw new ApiError(400, "Invalid sprint for this project");
      }
      values.sprintId = body.sprintId || null;
    }
    if (body.labels !== undefined) {
      const labels = normalizeLabels(body.labels);
      values.labels = labels.length ? JSON.stringify(labels) : null;
    }
    if (body.dueDate !== undefined) {
      if (body.dueDate && !isValidDueDate(body.dueDate)) throw new ApiError(400, "Due date must be a valid YYYY-MM-DD date");
      values.dueDate = body.dueDate || null;
    }
    if (body.assigneeId !== undefined) {
      // Assignment is an admin-only action; members cannot reassign even their own tickets.
      if (myRole !== "ADMIN") throw new ApiError(403, "Only project admins can reassign tickets");
      values.assigneeId = body.assigneeId || null;
    }

    let oldStatus: Status | null = null;
    let newStatus: Status | null = null;

    if (body.status !== undefined) {
      if (!isStatus(body.status)) throw new ApiError(400, `Invalid status: ${String(body.status)}`);
      oldStatus = task.status as Status;
      newStatus = body.status;
      // Same-status PATCH is a column reorder (drag & drop); only reject illegal cross-status moves.
      if (oldStatus !== newStatus && !canTransition(oldStatus, newStatus)) {
        throw new ApiError(400, `Illegal transition ${oldStatus} -> ${newStatus}`);
      }
      values.status = newStatus;
      values.position = await computePosition(ctx, projectId, newStatus, body.beforeTaskId, taskId);
    }

    if (Object.keys(values).length === 0) throw new ApiError(400, "Nothing to update");
    values.updatedAt = Date.now();

    const [updated] = await ctx.db.update(tasks).set(values).where(eq(tasks.id, taskId)).returning();

    if (oldStatus && newStatus && oldStatus !== newStatus) {
      await logActivity(ctx.db, {
        taskId,
        actorId: u.id,
        eventType: "STATUS_CHANGED",
        oldStatus,
        newStatus,
      });
      publish(projectId, { type: "status", ticketId: updated.ticketId, taskId, actorId: u.id });

      if (await isStatusMailEnabled(ctx.env, newStatus)) {
        const [actor] = await ctx.db.select({ name: user.name }).from(user).where(eq(user.id, u.id));
        await notifyStatusChanged(ctx.env, {
          projectId,
          taskId,
          ticketId: updated.ticketId,
          taskTitle: updated.title,
          oldStatus,
          newStatus,
          actorName: actor?.name ?? u.name,
        }).catch((e) => console.error("notify failed:", e));
      }

      const notifyUserIds = [task.createdBy, task.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
      for (const uid of notifyUserIds) {
        await createNotification({
          db: ctx.db,
          userId: uid,
          actorId: u.id,
          type: "STATUS_CHANGED",
          taskId,
          projectId,
          message: `${u.name} moved ${updated.ticketId} to ${newStatus}`,
        }).catch((e) => console.error("notification failed:", e));
      }
    }

    // Field-level history entries (in addition to the status entry above).
    // Title and description autosave on a short debounce as the user types,
    // so consecutive edits within ACTIVITY_COALESCE_MS are folded into the
    // same log row instead of creating one entry per debounce tick.
    if (values.title !== undefined && values.title !== oldTitle) {
      await logActivity(ctx.db, {
        taskId,
        actorId: u.id,
        eventType: "TITLE_CHANGED",
        oldValue: oldTitle,
        newValue: values.title,
        coalesceWindowMs: ACTIVITY_COALESCE_MS,
      });
    }
    if (values.description !== undefined && (values.description ?? null) !== (oldDescription ?? null)) {
      await logActivity(ctx.db, {
        taskId,
        actorId: u.id,
        eventType: "DESCRIPTION_CHANGED",
        oldValue: descPreview(oldDescription),
        newValue: descPreview(values.description),
        coalesceWindowMs: ACTIVITY_COALESCE_MS,
      });
      if (values.description) {
        await notifyMentionedUsers({
          db: ctx.db,
          text: values.description,
          actorId: u.id,
          taskId,
          projectId,
          messagePrefix: `${u.name} on ${updated.ticketId}`,
        });
      }
    }
    if (body.assigneeId !== undefined && (values.assigneeId ?? null) !== (oldAssigneeId ?? null)) {
      await logActivity(ctx.db, {
        taskId,
        actorId: u.id,
        eventType: "ASSIGNEE_CHANGED",
        oldValue: oldAssigneeId,
        newValue: values.assigneeId ?? null,
      });
      if (values.assigneeId) {
        await createNotification({
          db: ctx.db,
          userId: values.assigneeId,
          actorId: u.id,
          type: "ASSIGNED",
          taskId,
          projectId,
          message: `${u.name} assigned you ${updated.ticketId}: ${updated.title}`,
        }).catch((e) => console.error("notification failed:", e));
      }
    }
    if (values.type !== undefined && values.type !== oldType) {
      await logActivity(ctx.db, { taskId, actorId: u.id, eventType: "TYPE_CHANGED", oldValue: oldType, newValue: values.type });
    }
    if (values.priority !== undefined && values.priority !== oldPriority) {
      await logActivity(ctx.db, { taskId, actorId: u.id, eventType: "PRIORITY_CHANGED", oldValue: oldPriority, newValue: values.priority });
    }
    if (values.sprintId !== undefined && (values.sprintId ?? null) !== (oldSprintId ?? null)) {
      // Resolve sprint internal IDs to human-readable IDs for the activity log.
      const resolveSprint = async (sid: string | null): Promise<string | null> => {
        if (!sid) return null;
        const [s] = await ctx.db.select({ sprintId: sprints.sprintId }).from(sprints).where(eq(sprints.id, sid));
        return s?.sprintId ?? null;
      };
      await logActivity(ctx.db, {
        taskId,
        actorId: u.id,
        eventType: "SPRINT_CHANGED",
        oldValue: await resolveSprint(oldSprintId),
        newValue: await resolveSprint(values.sprintId),
      });
      const sprintNotifyUsers = [task.createdBy, task.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
      for (const uid of sprintNotifyUsers) {
        await createNotification({
          db: ctx.db,
          userId: uid,
          actorId: u.id,
          type: "SPRINT_CHANGED",
          taskId,
          projectId,
          message: `${u.name} moved ${updated.ticketId} to sprint ${await resolveSprint(values.sprintId) ?? "None"}`,
        }).catch((e) => console.error("notification failed:", e));
      }
    }

    // Non-status edits also nudge open boards (status changes published above).
    if (!(oldStatus && newStatus && oldStatus !== newStatus) &&
        Object.keys(values).some((k) => k !== "updatedAt")) {
      publish(projectId, { type: "updated", ticketId: updated.ticketId, taskId, actorId: u.id });
    }

    return updated;
}
