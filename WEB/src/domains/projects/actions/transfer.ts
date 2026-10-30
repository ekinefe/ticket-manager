import { and, asc, eq, or, sql, inArray } from "drizzle-orm";
import { githubEvents, githubEventTasks, projects, projectMembers, tasks, user, activityLog, taskComments, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { publish } from "../../../shared/realtime";
import { sanitizeDescHtml } from "../../../shared/sanitize";
import { logActivity, allocateTicketId, isStatus, type Status, normalizeLabels, parseLabels, TASK_TYPES, PRIORITIES, isValidDueDate } from "../../tickets/index";
import { getProjectAccess, requireProjectPermission, requirePanelAccess } from "../../access/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";
import { planSync, buildEditInstructions, DEFAULT_SYNC_OPTIONS, type SyncOptions, type SprintTarget } from "../project-sync";
import { createDefaultSprint, nextSprintId } from "../../sprints/index";

function csvCell(v: unknown): string {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function plainText(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .trim();
}

// Project export (JSON/CSV/XML), "Update from JSON" sync and import.
export async function exportProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  // A full-project export doesn't make sense as a partial dump, so a
  // restricted member (no VIEW_ALL_TICKETS) can't use it at all.
  await requireProjectPermission(ctx.db, u, projectId, "VIEW_ALL_TICKETS");
  const format = (input.query("format") || "json").toLowerCase();
  if (format !== "json" && format !== "csv") throw new ApiError(400, "format must be json or csv");

  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");

  const projectSprints = await ctx.db
    .select()
    .from(sprints)
    .where(eq(sprints.projectId, projectId))
    .orderBy(asc(sprints.createdAt));

  const projectTasks = await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.position));

  const members = await ctx.db
    .select({ userId: projectMembers.userId, role: projectMembers.role, name: user.name })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  const nameById = new Map(members.map((m) => [m.userId, m.name]));
  // Former members can still be an assignee / creator of old tickets.
  const extraIds = [...new Set(projectTasks.flatMap((t) => [t.assigneeId, t.createdBy]).filter((id): id is string => !!id && !nameById.has(id)))];
  for (let i = 0; i < extraIds.length; i += 50) {
    const rows = await ctx.db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, extraIds.slice(i, i + 50)));
    for (const r of rows) nameById.set(r.id, r.name);
  }

  // Join through tasks (not an id list) to stay under D1's bound-variable limit.
  const commentRows = await ctx.db
    .select({ taskId: taskComments.taskId, body: taskComments.body, createdAt: taskComments.createdAt, authorName: user.name })
    .from(taskComments)
    .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
    .leftJoin(user, eq(user.id, taskComments.authorId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(taskComments.createdAt));
  const activityRows = await ctx.db
    .select({
      taskId: activityLog.taskId, type: activityLog.eventType, oldStatus: activityLog.oldStatus,
      newStatus: activityLog.newStatus, oldValue: activityLog.oldValue, newValue: activityLog.newValue,
      createdAt: activityLog.createdAt, actorName: user.name,
    })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .leftJoin(user, eq(user.id, activityLog.actorId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(activityLog.createdAt));
  const linkRows = await ctx.db
    .select({
      taskId: githubEventTasks.taskId, kind: githubEvents.kind, ref: githubEvents.ref, title: githubEvents.title,
      url: githubEvents.url, state: githubEvents.state, author: githubEvents.author, branch: githubEvents.branch,
    })
    .from(githubEventTasks)
    .innerJoin(githubEvents, eq(githubEvents.id, githubEventTasks.eventId))
    .where(eq(githubEvents.projectId, projectId));

  const by = <T extends { taskId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.taskId) ?? m.set(r.taskId, []).get(r.taskId)!).push(r);
    return m;
  };
  const commentsBy = by(commentRows);
  const activityBy = by(activityRows);
  const linksBy = by(linkRows);

  const sprintById = new Map(projectSprints.map((sp, i) => [sp.id, { index: i, sprintId: sp.sprintId, name: sp.name }]));
  const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
  const branchOf = (t: { ticketId: string; type: string }) => `${t.type === "BUG" ? "hotfix" : "feature"}/${t.ticketId}`;

  if (format === "csv") {
    const header = [
      "Ticket ID", "Title", "Status", "Type", "Priority", "Labels", "Due date", "Sprint ID", "Sprint", "Assignee", "Created by",
      "Created", "Updated", "Branch", "Comments", "Linked commits/PRs", "Description",
    ];
    const lines = [header.map(csvCell).join(",")];
    // ?ids=GNR-1,GNR-2 limits the CSV to those tickets (the board's filtered view)
    const only = (input.query("ids") || "").split(",").map((x) => x.trim()).filter(Boolean);
    const wanted = only.length ? new Set(only) : null;
    for (const t of projectTasks) {
      if (wanted && !wanted.has(t.ticketId)) continue;
      const sp = t.sprintId ? sprintById.get(t.sprintId) : undefined;
      const links = (linksBy.get(t.id) ?? []).map((l) => (l.kind === "PR" ? `PR #${l.ref}` : l.ref.slice(0, 7))).join("; ");
      lines.push([
        t.ticketId, t.title, t.status, t.type, t.priority, parseLabels(t.labels).join("; "), t.dueDate ?? "", sp?.sprintId ?? "", sp?.name ?? "Backlog",
        t.assigneeId ? nameById.get(t.assigneeId) ?? "" : "", t.createdBy ? nameById.get(t.createdBy) ?? "" : "",
        iso(t.createdAt), iso(t.updatedAt), branchOf(t), (commentsBy.get(t.id) ?? []).length, links, plainText(t.description),
      ].map(csvCell).join(","));
    }
    return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${project.prefix}-export.csv"`,
      },
    });
  }

  const statusCounts: Record<string, number> = {};
  for (const t of projectTasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;

  return {
    exportVersion: 3,
    instructions: buildEditInstructions({
      prefix: project.prefix,
      sprints: projectSprints.map((sp) => ({ sprintId: sp.sprintId, name: sp.name })),
      members: members.map((m) => m.name),
    }),
    exportedAt: new Date().toISOString(),
    exportedBy: u.name,
    project: {
      name: project.name,
      prefix: project.prefix,
      id: project.id,
      createdAt: iso(project.createdAt),
      githubRepo: project.githubRepo ?? null,
      defaultAssignee: project.defaultAssigneeId ? nameById.get(project.defaultAssigneeId) ?? null : null,
      lastTicketNumber: project.currentTicketSequence,
    },
    summary: { tickets: projectTasks.length, sprints: projectSprints.length, byStatus: statusCounts },
    members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    sprints: projectSprints.map((sp) => ({
      name: sp.name,
      sprintId: sp.sprintId,
      id: sp.id,
      createdAt: iso(sp.createdAt),
      ticketCount: projectTasks.filter((t) => t.sprintId === sp.id).length,
    })),
    tasks: projectTasks.map((t) => {
      const sp = t.sprintId ? sprintById.get(t.sprintId) : undefined;
      return {
        ticketId: t.ticketId,
        id: t.id,
        title: t.title,
        description: t.description || undefined,
        status: t.status,
        type: t.type,
        priority: t.priority,
        sprint: sp ? sp.index : null,
        sprintId: sp?.sprintId ?? null,
        labels: parseLabels(t.labels),
        dueDate: t.dueDate ?? null,
        sprintName: sp?.name ?? null,
        assigneeId: t.assigneeId || undefined,
        assignee: t.assigneeId ? nameById.get(t.assigneeId) ?? null : null,
        createdBy: t.createdBy ? nameById.get(t.createdBy) ?? null : null,
        createdAt: iso(t.createdAt),
        updatedAt: iso(t.updatedAt),
        position: t.position,
        branch: branchOf(t),
        comments: (commentsBy.get(t.id) ?? []).map((cm) => ({ author: cm.authorName, createdAt: iso(cm.createdAt), body: cm.body })),
        activity: (activityBy.get(t.id) ?? []).map((a) => ({
          type: a.type, actor: a.actorName, createdAt: iso(a.createdAt),
          oldStatus: a.oldStatus, newStatus: a.newStatus, oldValue: a.oldValue, newValue: a.newValue,
        })),
        github: (linksBy.get(t.id) ?? []).map((l) => ({
          kind: l.kind, ref: l.ref, title: l.title, url: l.url, state: l.state, author: l.author, branch: l.branch,
        })),
      };
    }),
  };
}

// Sync an existing project from an edited JSON export. Project admins only.
// POST {data, options, apply}: apply=false (default) returns a preview of what
// would change; apply=true performs it.
export async function syncProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);
  if (access.role !== "ADMIN") throw new ApiError(403, "Project admin role required");

  const body = await input.body<{ data?: unknown; options?: Partial<SyncOptions> & { fields?: Partial<SyncOptions["fields"]> }; apply?: boolean }>();
  const fileTasks = (body.data as { tasks?: unknown } | undefined)?.tasks;
  if (!Array.isArray(fileTasks)) throw new ApiError(400, "The JSON must contain a \"tasks\" list");
  if (fileTasks.length > 3000) throw new ApiError(400, "Too many tickets in one file (max 3000)");
  const options: SyncOptions = {
    create: body.options?.create ?? DEFAULT_SYNC_OPTIONS.create,
    update: body.options?.update ?? DEFAULT_SYNC_OPTIONS.update,
    remove: body.options?.remove ?? DEFAULT_SYNC_OPTIONS.remove,
    fields: { ...DEFAULT_SYNC_OPTIONS.fields, ...(body.options?.fields ?? {}) },
  };

  const [project] = await ctx.db.select({ id: projects.id, prefix: projects.prefix }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");
  const [rows, sprintRows, memberRows] = await Promise.all([
    ctx.db.select().from(tasks).where(eq(tasks.projectId, projectId)),
    ctx.db.select({ id: sprints.id, sprintId: sprints.sprintId, name: sprints.name }).from(sprints).where(eq(sprints.projectId, projectId)),
    ctx.db.select({ userId: projectMembers.userId, name: user.name, email: user.email })
      .from(projectMembers).innerJoin(user, eq(user.id, projectMembers.userId)).where(eq(projectMembers.projectId, projectId)),
  ]);

  const plan = planSync({
    file: body.data, options, sprints: sprintRows, members: memberRows,
    tasks: rows.map((t) => ({
      id: t.id, ticketId: t.ticketId, title: t.title, description: t.description, status: t.status,
      type: t.type, priority: t.priority, sprintId: t.sprintId, assigneeId: t.assigneeId,
      labels: parseLabels(t.labels), dueDate: t.dueDate ?? null, position: t.position,
    })),
  });

  const summary = {
    creates: plan.creates.map((t) => ({ title: t.title, status: t.status, sourceTicketId: t.sourceTicketId })),
    updates: plan.updates.slice(0, 500).map((x) => ({ ticketId: x.ticketId, title: x.title, changes: x.changes })),
    updateCount: plan.updates.length,
    missing: plan.missing.slice(0, 500),
    missingCount: plan.missing.length,
    deleteCount: plan.deletes.length,
    sprintsToCreate: plan.sprintsToCreate,
    unchanged: plan.unchanged,
    warnings: plan.warnings.slice(0, 100),
  };
  if (!body.apply) return { applied: false, plan: summary };

  // ---- apply ----
  const now = Date.now();
  const sprintIdByName = new Map<string, string>();
  for (const name of plan.sprintsToCreate) {
    const code = await nextSprintId({ db: ctx.db }, projectId, project.prefix);
    const id = crypto.randomUUID();
    await ctx.db.insert(sprints).values({ id, projectId, sprintId: code, name, createdAt: now });
    sprintIdByName.set(name.trim().toLowerCase(), id);
  }
  const targetId = (t: SprintTarget): string | null =>
    t.kind === "backlog" ? null : t.kind === "id" ? t.id : (sprintIdByName.get(t.name.trim().toLowerCase()) ?? null);
  const sprintCode = new Map(sprintRows.map((s) => [s.id, s.sprintId]));
  const label = (id: string | null) => (id ? (sprintCode.get(id) ?? id) : "Backlog");
  const nameOf = (id: string | null) => (id ? (memberRows.find((m) => m.userId === id)?.name ?? id) : null);
  const endOf = async (status: string) => {
    const [{ maxPos }] = await ctx.db
      .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
      .from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)));
    return Number(maxPos) + 1;
  };

  for (const upd of plan.updates) {
    const before = rows.find((r) => r.id === upd.id)!;
    const p = upd.patch;
    const values: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
    if (p.title !== undefined) values.title = p.title;
    if (p.description !== undefined) values.description = p.description;
    if (p.type !== undefined) values.type = p.type as "TASK" | "BUG";
    if (p.priority !== undefined) values.priority = p.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    if (p.status !== undefined) values.status = p.status;
    if (p.position === null && p.status !== undefined) values.position = await endOf(p.status);
    else if (typeof p.position === "number") values.position = p.position;
    if (p.sprint !== undefined) values.sprintId = targetId(p.sprint);
    if (p.assigneeId !== undefined) values.assigneeId = p.assigneeId;
    if (p.labels !== undefined) values.labels = p.labels.length ? JSON.stringify(p.labels) : null;
    if (p.dueDate !== undefined) values.dueDate = p.dueDate;
    await ctx.db.update(tasks).set(values).where(and(eq(tasks.id, upd.id), eq(tasks.projectId, projectId)));

    const log = (eventType: Parameters<typeof logActivity>[1]["eventType"], extra: { oldStatus?: string; newStatus?: string; oldValue?: string | null; newValue?: string | null } = {}) =>
      logActivity(ctx.db, { taskId: upd.id, actorId: u.id, eventType, ...extra });
    if (p.status !== undefined) await log("STATUS_CHANGED", { oldStatus: before.status, newStatus: p.status });
    if (p.title !== undefined) await log("TITLE_CHANGED", { oldValue: before.title, newValue: p.title });
    if (p.description !== undefined) await log("DESCRIPTION_CHANGED", { newValue: plainText(p.description ?? "").slice(0, 200) });
    if (p.type !== undefined) await log("TYPE_CHANGED", { oldValue: before.type, newValue: p.type });
    if (p.priority !== undefined) await log("PRIORITY_CHANGED", { oldValue: before.priority, newValue: p.priority });
    if (p.assigneeId !== undefined) await log("ASSIGNEE_CHANGED", { oldValue: nameOf(before.assigneeId), newValue: nameOf(p.assigneeId) });
    if (p.sprint !== undefined) await log("SPRINT_CHANGED", { oldValue: label(before.sprintId), newValue: label(targetId(p.sprint)) });
  }

  let created = 0;
  for (const cr of plan.creates) {
    const ticketId = await allocateTicketId(ctx.db, projectId);
    const [task] = await ctx.db.insert(tasks).values({
      id: crypto.randomUUID(), projectId, ticketId, title: cr.title, description: cr.description,
      status: cr.status, type: cr.type as "TASK" | "BUG", priority: cr.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
      assigneeId: cr.assigneeId, sprintId: targetId(cr.sprint),
      labels: cr.labels.length ? JSON.stringify(cr.labels) : null, dueDate: cr.dueDate,
      createdBy: u.id, position: await endOf(cr.status), createdAt: now, updatedAt: now,
    }).returning();
    await logActivity(ctx.db, { taskId: task.id, actorId: u.id, eventType: "CREATED", newStatus: cr.status });
    created++;
  }

  let deleted = 0;
  const ids = plan.deletes.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await ctx.db.delete(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, chunk))).returning({ id: tasks.id });
    deleted += res.length;
  }

  publish(projectId, { type: "synced", actorId: u.id });
  return { applied: true, plan: summary, result: { created, updated: plan.updates.length, deleted, sprintsCreated: plan.sprintsToCreate.length } };
}

export async function importProject(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requirePanelAccess(u);

  const body = await input.body<{
    project?: { name?: string; prefix?: string };
    sprints?: { name?: string }[];
    tasks?: {
      title?: string;
      description?: string;
      status?: string;
      type?: string;
      priority?: string;
      sprint?: number | null;
      assigneeId?: string;
      labels?: string[];
      dueDate?: string | null;
    }[];
  }>();

  const projectName = body.project?.name?.trim();
  const prefix = body.project?.prefix?.trim().toUpperCase();
  if (!projectName) throw new ApiError(400, "Project name is required");
  if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
    throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
  }
  if (!body.sprints?.length && !body.tasks?.length) throw new ApiError(400, "At least one sprint or ticket is required");
  const sprintList = body.sprints ?? [];

  const [taken] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.prefix, prefix));
  if (taken) throw new ApiError(409, `The prefix ${prefix} is already used by another project`);
  // Exports carry user ids from the instance they came from; keep only the ones that exist here.
  const knownUsers = new Set((await ctx.db.select({ id: user.id }).from(user)).map((r) => r.id));

  const projectId = crypto.randomUUID();
  const now = Date.now();

  const createdSprints: { id: string; sprintId: string; name: string; createdAt: number }[] = [];
  const createdTaskIds: string[] = [];

  // NOTE: previously wrapped in a single DB transaction. better-sqlite3
  // (local) requires a synchronous transaction callback while D1 (Workers)
  // requires an async one, so a shared transaction callback cannot serve
  // both runtimes. All statements below are independent (no DB reads), so
  // they run sequentially on ctx.db instead, which is correct on both.
  await ctx.db.insert(projects).values({
    id: projectId,
    name: projectName,
    prefix,
    currentTicketSequence: 0,
    createdAt: now,
  }).run();

  await ctx.db.insert(projectMembers).values({
    projectId,
    userId: u.id,
    role: "ADMIN",
  }).run();

  for (let i = 0; i < sprintList.length; i++) {
    const s = sprintList[i];
    const sprintIdStr = `${prefix}-S${i + 1}`;
    const sprintUuid = crypto.randomUUID();
    await ctx.db.insert(sprints).values({
      id: sprintUuid,
      projectId,
      sprintId: sprintIdStr,
      name: s.name?.trim() || `Sprint ${i + 1}`,
      createdAt: now,
    }).run();
    createdSprints.push({ id: sprintUuid, sprintId: sprintIdStr, name: s.name?.trim() || `Sprint ${i + 1}`, createdAt: now });
  }

  let ticketSeq = 0;
  for (const t of body.tasks || []) {
    const title = t.title?.trim();
    if (!title) continue;

    ticketSeq++;
    const ticketId = `${prefix}-${ticketSeq}`;
    const status = t.status && isStatus(t.status) ? t.status : "TODO";
    const type = t.type && TASK_TYPES.includes(t.type) ? t.type : "TASK";
    const priority = t.priority && PRIORITIES.includes(t.priority) ? t.priority : "MEDIUM";

    let sprintUuid: string | null = null;
    if (t.sprint != null && t.sprint >= 0 && t.sprint < createdSprints.length) {
      sprintUuid = createdSprints[t.sprint].id;
    }

    // Imported files may carry odd labels; drop them rather than fail the whole import.
    let importLabels: string[] = [];
    try { importLabels = t.labels === undefined ? [] : normalizeLabels(t.labels); } catch { /* ignore */ }

    const taskUuid = crypto.randomUUID();
    await ctx.db.insert(tasks).values({
      id: taskUuid,
      projectId,
      ticketId,
      title,
      description: sanitizeDescHtml(t.description ?? "") || null,
      status,
      type: type as "TASK" | "BUG",
      priority: priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
      assigneeId: t.assigneeId && knownUsers.has(t.assigneeId) ? t.assigneeId : null,
      sprintId: sprintUuid,
      createdBy: u.id,
      labels: importLabels.length ? JSON.stringify(importLabels) : null,
      dueDate: t.dueDate && isValidDueDate(t.dueDate) ? t.dueDate : null,
      position: ticketSeq,
      createdAt: now,
      updatedAt: now,
    }).run();
    createdTaskIds.push(taskUuid);
  }

  await ctx.db.update(projects)
    .set({ currentTicketSequence: ticketSeq })
    .where(eq(projects.id, projectId))
    .run();

  publish(projectId, { type: "imported", actorId: u.id });

  return {
    ok: true,
    projectId,
    sprintsCreated: createdSprints.length,
    tasksCreated: createdTaskIds.length,
  };
}
