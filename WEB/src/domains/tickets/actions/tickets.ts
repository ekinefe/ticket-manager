import { and, asc, eq, or, sql } from "drizzle-orm";
import { projects, tasks, user, activityLog, taskComments, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { publish } from "../../../shared/realtime";
import { sanitizeDescHtml } from "../../../shared/sanitize";
import { logActivity } from "../activity";
import { allocateTicketId } from "../ticket-id";
import { searchAll } from "../search";
import { isStatus } from "../status";
import { normalizeLabels, withLabelArrays, withoutShareToken } from "../labels";
import { newShareToken } from "../share-token";
import { assertTaskVisible } from "../visibility";
import { getProjectAccess, requireProjectRole, requireProjectPermission, requireSuperAdmin, listAssignedTickets, listUnassignedTickets, listAllTickets, type SessionUser } from "../../access/index";
import { createNotification, createProjectNotification, notifyMentionedUsers } from "../../notifications/index";
import { TASK_TYPES, PRIORITIES, isValidDueDate, applyTaskUpdate, type TaskUpdateBody } from "./update";
import type { Ctx, OptionalCtx } from "../../access/index";
import type { Input } from "../../../shared/route";

// Ticket use cases: lists, create/update/delete, bulk edits, comments, activity, sharing.
export async function myTickets(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  return withLabelArrays(await listAssignedTickets(ctx.db, u));
}

export async function myUnassignedTickets(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  return withLabelArrays(await listUnassignedTickets(ctx.db, u));
}

export async function allTickets(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requireSuperAdmin(u);
  const assigneeId = (input.query("assigneeId") || "").trim() || undefined;
  return withLabelArrays(await listAllTickets(ctx.db, assigneeId));
}

export async function searchEverything(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const q = (input.query("q") || "").trim();
  if (q.length < 1) return { tickets: [], projects: [], users: [], suggested: false };
  return await searchAll(ctx.db, u, q);
}

export async function listTasks(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);

  // Optional pagination (?page=&perPage= or &limit=&offset=); the board
  // client fetches everything (no params) since it needs the full set.
  const page = Number(input.query("page") ?? 0);
  const perPage = Math.min(Number(input.query("perPage") ?? 50), 200);
  const limit = Number(input.query("limit") ?? 0);
  const offset = Number(input.query("offset") ?? 0);

  // A MEMBER without VIEW_ALL_TICKETS (e.g. a restricted freelancer) only
  // sees tickets they created or are assigned to.
  const scope = access.can("VIEW_ALL_TICKETS")
    ? eq(tasks.projectId, projectId)
    : and(eq(tasks.projectId, projectId), or(eq(tasks.assigneeId, u.id), eq(tasks.createdBy, u.id)));

  let query = ctx.db.select().from(tasks).where(scope).$dynamic();
  if (page >= 1) {
    query = query.limit(perPage).offset((page - 1) * perPage);
  } else if (limit > 0) {
    query = query.limit(limit).offset(offset);
  }
  const rows = await query.orderBy(asc(tasks.status), asc(tasks.position));
  return rows.map(withoutShareToken);
}

export async function createTask(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectPermission(ctx.db, u, projectId, "CREATE_TICKET");

  const body = await input.body<{ title?: string; description?: string; status?: string; assigneeId?: string; type?: string; priority?: string; sprintId?: string | null; labels?: string[]; dueDate?: string | null }>();
  const title = body.title?.trim();
  if (!title) throw new ApiError(400, "Title is required");
  // Members may pick the initial assignee of a NEW ticket; reassigning later is admin-only.
  const status = body.status ? (isStatus(body.status) ? body.status : (() => { throw new ApiError(400, `Invalid status`); })()) : "TODO";
  if (body.type !== undefined && !TASK_TYPES.includes(body.type)) throw new ApiError(400, `Invalid type: ${String(body.type)}`);
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) throw new ApiError(400, `Invalid priority: ${String(body.priority)}`);
  // If a sprintId is provided, verify it belongs to this project.
  if (body.sprintId) {
    const [sprint] = await ctx.db.select({ id: sprints.id }).from(sprints).where(and(eq(sprints.id, body.sprintId), eq(sprints.projectId, projectId)));
    if (!sprint) throw new ApiError(400, "Invalid sprint for this project");
  }

  const ticketId = await allocateTicketId(ctx.db, projectId);
  const [{ maxPos }] = await ctx.db
    .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)));

  // A ticket left unassigned falls back to the project's configured
  // default assignee (admin-set), if any.
  let assigneeId = body.assigneeId || null;
  if (!assigneeId) {
    const [proj] = await ctx.db.select({ defaultAssigneeId: projects.defaultAssigneeId }).from(projects).where(eq(projects.id, projectId));
    assigneeId = proj?.defaultAssigneeId ?? null;
  }

  const now = Date.now();
  const [task] = await ctx.db
    .insert(tasks)
    .values({
      id: crypto.randomUUID(),
      projectId,
      ticketId,
      title,
      description: sanitizeDescHtml(body.description ?? "") || null,
      status,
      type: (body.type ?? "TASK") as "TASK" | "BUG",
      priority: (body.priority ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
      assigneeId,
      sprintId: body.sprintId || null,
      labels: body.labels !== undefined && normalizeLabels(body.labels).length ? JSON.stringify(normalizeLabels(body.labels)) : null,
      dueDate: body.dueDate && isValidDueDate(body.dueDate) ? body.dueDate : null,
      createdBy: u.id,
      position: Number(maxPos) + 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await logActivity(ctx.db, { taskId: task.id, actorId: u.id, eventType: "CREATED", newStatus: status });
  publish(projectId, { type: "created", ticketId, taskId: task.id, actorId: u.id });

  if (body.assigneeId) {
    await createNotification({
      db: ctx.db,
      userId: body.assigneeId,
      actorId: u.id,
      type: "TICKET_CREATED",
      taskId: task.id,
      projectId,
      message: `${u.name} assigned you ${ticketId}: ${title}`,
    }).catch((e) => console.error("notification failed:", e));
  } else {
    await createProjectNotification({
      db: ctx.db,
      projectId,
      actorId: u.id,
      type: "TICKET_CREATED",
      taskId: task.id,
      message: `${u.name} created ${ticketId}: ${title}`,
    }).catch((e) => console.error("notification failed:", e));
  }

  if (body.description) {
    await notifyMentionedUsers({
      db: ctx.db,
      text: body.description,
      actorId: u.id,
      taskId: task.id,
      projectId,
      messagePrefix: `${u.name} on ${ticketId}`,
    });
  }

  return withoutShareToken(task);
}

export async function updateTask(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const body = await input.body<TaskUpdateBody>();
  const updated = await applyTaskUpdate(ctx, taskId, body, projectId);
  return withoutShareToken(updated);
}

export async function bulkUpdateTasks(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const body = await input.body<{ taskIds?: string[]; update?: TaskUpdateBody }>();
  const taskIds = Array.isArray(body.taskIds) ? [...new Set(body.taskIds)] : [];
  if (taskIds.length === 0) throw new ApiError(400, "taskIds is required");
  if (taskIds.length > 200) throw new ApiError(400, "Too many tickets selected (max 200)");
  const update = body.update ?? {};
  if (Object.keys(update).length === 0) throw new ApiError(400, "update is required");

  const updated: string[] = [];
  const skipped: { taskId: string; reason: string }[] = [];
  for (const taskId of taskIds) {
    try {
      const task = await applyTaskUpdate(ctx, taskId, update);
      updated.push(task.id);
    } catch (e) {
      skipped.push({ taskId, reason: e instanceof ApiError ? e.message : "Update failed" });
    }
  }
  return { updated, skipped };
}

export async function bulkDeleteTasks(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const body = await input.body<{ taskIds?: string[] }>();
  const taskIds = Array.isArray(body.taskIds) ? [...new Set(body.taskIds)] : [];
  if (taskIds.length === 0) throw new ApiError(400, "taskIds is required");
  if (taskIds.length > 200) throw new ApiError(400, "Too many tickets selected (max 200)");

  const deleted: string[] = [];
  const skipped: { taskId: string; ticketId: string | null; reason: string }[] = [];
  for (const taskId of taskIds) {
    const [task] = await ctx.db
      .select({ id: tasks.id, projectId: tasks.projectId, ticketId: tasks.ticketId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    if (!task) {
      skipped.push({ taskId, ticketId: null, reason: "Ticket not found" });
      continue;
    }
    try {
      await requireProjectPermission(ctx.db, u, task.projectId, "DELETE_TICKET");
    } catch (e) {
      skipped.push({ taskId, ticketId: task.ticketId, reason: e instanceof ApiError ? e.message : "Not allowed" });
      continue;
    }
    await ctx.db.delete(tasks).where(eq(tasks.id, taskId));
    publish(task.projectId, { type: "deleted", taskId, actorId: u.id });
    deleted.push(taskId);
  }
  return { deleted, skipped };
}

export async function deleteTask(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  await requireProjectPermission(ctx.db, u, projectId, "DELETE_TICKET");

  const deleted = await ctx.db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .returning({ id: tasks.id });
  if (deleted.length === 0) throw new ApiError(404, "Task not found");
  publish(projectId, { type: "deleted", taskId, actorId: u.id });
  return { ok: true };
}

export async function listComments(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);

  const [task] = await ctx.db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");
  assertTaskVisible(access, u, task);

  const rows = await ctx.db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      authorId: taskComments.authorId,
      authorName: user.name,
    })
    .from(taskComments)
    .leftJoin(user, eq(user.id, taskComments.authorId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(sql`task_comments.rowid`))
    .limit(500);
  return rows;
}

export async function addComment(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);

  const rawBody = (await input.body<{ body?: string }>()).body?.trim();
  if (!rawBody) throw new ApiError(400, "Comment cannot be empty");
  if (rawBody.length > 4000) throw new ApiError(400, "Comment is too long (max 4000 characters)");
  // Comments use the same rich-text editor as ticket descriptions, so they
  // get the same server-side allowlist sanitization: the client's denylist
  // filter (renderCommentBody) is not trusted, since it can be bypassed by
  // posting directly to this endpoint (e.g. a `javascript:` href).
  const body = sanitizeDescHtml(rawBody);
  if (!body) throw new ApiError(400, "Comment cannot be empty");

  const [taskRow] = await ctx.db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy, ticketId: tasks.ticketId, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!taskRow) throw new ApiError(404, "Task not found");
  assertTaskVisible(access, u, taskRow);
  const isOwnTicket = taskRow.assigneeId === u.id || taskRow.createdBy === u.id;
  if (access.role !== "ADMIN" && !isOwnTicket && !access.can("COMMENT_ON_OTHERS_TICKETS")) {
    throw new ApiError(403, "You don't have permission to comment on this ticket");
  }

  const [row] = await ctx.db
    .insert(taskComments)
    .values({ id: crypto.randomUUID(), taskId, authorId: u.id, body, createdAt: Date.now() })
    .returning();

  if (taskRow) {
    const commentNotifyUsers = [taskRow.createdBy, taskRow.assigneeId].filter((v): v is string => Boolean(v) && v !== u.id);
    for (const uid of commentNotifyUsers) {
      await createNotification({
        db: ctx.db,
        userId: uid,
        actorId: u.id,
        type: "COMMENT_ADDED",
        taskId,
        projectId,
        message: `${u.name} commented on ${taskRow.ticketId}: ${taskRow.title}`,
      }).catch((e) => console.error("notification failed:", e));
    }
    await notifyMentionedUsers({
      db: ctx.db,
      text: body,
      actorId: u.id,
      taskId,
      projectId,
      messagePrefix: `${u.name} on ${taskRow.ticketId}`,
    });
  }

  return { ...row, authorName: u.name };
}

export async function taskEvents(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);

  const [task] = await ctx.db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");
  assertTaskVisible(access, u, task);

  const perPage = Math.min(Number(input.query("perPage") ?? 500), 500);
  const page = Math.max(Number(input.query("page") ?? 1), 1);
  const rows = await ctx.db
    .select({
      id: activityLog.id,
      type: activityLog.eventType,
      oldStatus: activityLog.oldStatus,
      newStatus: activityLog.newStatus,
      oldValue: activityLog.oldValue,
      newValue: activityLog.newValue,
      createdAt: activityLog.createdAt,
      actorId: activityLog.actorId,
      actorName: user.name,
    })
    .from(activityLog)
    .leftJoin(user, eq(user.id, activityLog.actorId))
    .where(eq(activityLog.taskId, taskId))
    .orderBy(asc(activityLog.createdAt), asc(sql`activity_log.rowid`))
    .limit(perPage)
    .offset((page - 1) * perPage);

  // Resolve assignee user ids into display names.
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.type === "ASSIGNEE_CHANGED") {
      if (r.oldValue) ids.add(r.oldValue);
      if (r.newValue) ids.add(r.newValue);
    }
  }
  const nameById = new Map<string, string>();
  for (const id of ids) {
    const [row] = await ctx.db.select({ name: user.name }).from(user).where(eq(user.id, id));
    if (row) nameById.set(id, row.name);
  }

  return rows.map((r) =>
      r.type === "ASSIGNEE_CHANGED"
        ? {
            ...r,
            oldValue: r.oldValue ? nameById.get(r.oldValue) ?? null : null,
            newValue: r.newValue ? nameById.get(r.newValue) ?? null : null,
          }
        : r
  );
}

export async function getTaskShare(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId, "ADMIN");
  const [task] = await ctx.db
    .select({ shareMode: tasks.shareMode, shareToken: tasks.shareToken })
    .from(tasks)
    .where(and(eq(tasks.id, input.p.taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");
  return { mode: task.shareMode, token: task.shareToken };
}

export async function setTaskShare(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId, "ADMIN");
  const body = await input.body<{ mode?: string; regenerate?: boolean }>();
  if (body.mode !== "OFF" && body.mode !== "ACCOUNT" && body.mode !== "LINK") {
    throw new ApiError(400, "mode must be OFF, ACCOUNT or LINK");
  }
  const [task] = await ctx.db
    .select({ shareToken: tasks.shareToken })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");

  const token = body.mode === "OFF" ? null : body.regenerate || !task.shareToken ? newShareToken() : task.shareToken;
  await ctx.db.update(tasks).set({ shareMode: body.mode, shareToken: token }).where(eq(tasks.id, taskId));
  return { mode: body.mode, token };
}

export async function viewSharedTicket(ctx: OptionalCtx, input: Input) {
  const token = input.p.token;
  const [task] = await ctx.db
    .select({
      id: tasks.id,
      ticketId: tasks.ticketId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      type: tasks.type,
      priority: tasks.priority,
      shareMode: tasks.shareMode,
      assigneeId: tasks.assigneeId,
      createdBy: tasks.createdBy,
      projectId: tasks.projectId,
      projectName: projects.name,
      projectPrefix: projects.prefix,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.shareToken, token), sql`${tasks.shareMode} != 'OFF'`));
  if (!task) throw new ApiError(404, "This link is invalid or sharing has been turned off");

  let viewer: SessionUser | null = null;
  try {
    viewer = ctx.user;
  } catch {
    viewer = null;
  }
  if (task.shareMode === "ACCOUNT" && !viewer) throw new ApiError(401, "Sign in to view this ticket");

  const nameOf = async (id: string | null) => {
    if (!id) return null;
    const [row] = await ctx.db.select({ name: user.name }).from(user).where(eq(user.id, id));
    return row?.name ?? null;
  };

  const comments = await ctx.db
    .select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, authorName: user.name })
    .from(taskComments)
    .leftJoin(user, eq(user.id, taskComments.authorId))
    .where(eq(taskComments.taskId, task.id))
    .orderBy(asc(taskComments.createdAt), asc(sql`task_comments.rowid`))
    .limit(500);

  const events = await ctx.db
    .select({
      id: activityLog.id,
      type: activityLog.eventType,
      oldStatus: activityLog.oldStatus,
      newStatus: activityLog.newStatus,
      oldValue: activityLog.oldValue,
      newValue: activityLog.newValue,
      createdAt: activityLog.createdAt,
      actorName: user.name,
    })
    .from(activityLog)
    .leftJoin(user, eq(user.id, activityLog.actorId))
    .where(eq(activityLog.taskId, task.id))
    .orderBy(asc(activityLog.createdAt), asc(sql`activity_log.rowid`))
    .limit(500);
  const activity = [];
  for (const e of events) {
    activity.push(
      e.type === "ASSIGNEE_CHANGED"
        ? { ...e, oldValue: await nameOf(e.oldValue), newValue: await nameOf(e.newValue) }
        : e
    );
  }

  // Lets a member jump to the real board; never used to grant any access.
  let isMember = false;
  if (viewer) {
    try {
      await getProjectAccess(ctx.db, viewer, task.projectId);
      isMember = true;
    } catch {
      isMember = false;
    }
  }

  return {
    ticket: {
      ticketId: task.ticketId,
      title: task.title,
      description: task.description,
      status: task.status,
      type: task.type,
      priority: task.priority,
      projectName: task.projectName,
      projectPrefix: task.projectPrefix,
      assigneeName: await nameOf(task.assigneeId),
      createdByName: await nameOf(task.createdBy),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    comments,
    activity,
    viewer: { signedIn: !!viewer, isMember },
    projectId: isMember ? task.projectId : undefined,
    taskId: isMember ? task.id : undefined,
  };
}
