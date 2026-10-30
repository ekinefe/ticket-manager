import { and, asc, eq, ne, or, sql, gte, inArray, isNull, count, desc } from "drizzle-orm";
import { projects, projectMembers, tasks, user, activityLog, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { getProjectAccess, listAccessibleProjects, type Ctx } from "../../access/index";
import { buildReport, type Granularity } from "../reports";

type Query = (key: string) => string | undefined;

// GET /api/reports: performance, completed work and forecast. Covers projects where
// the caller can see every ticket (super admin, project admins, VIEW_ALL_TICKETS).
export async function getReports(ctx: Ctx, query: Query) {
  const u = ctx.user;
  const g = (query("granularity") || "weekly") as Granularity;
  if (!["daily", "weekly", "monthly"].includes(g)) throw new ApiError(400, "granularity must be daily, weekly or monthly");
  const wantedProject = (query("projectId") || "").trim();

  const accessible = await listAccessibleProjects(ctx.db, u);
  const visible: { id: string; name: string; prefix: string }[] = [];
  for (const p of accessible) {
    const access = await getProjectAccess(ctx.db, u, p.id);
    if (access.can("VIEW_ALL_TICKETS")) visible.push({ id: p.id, name: p.name, prefix: p.prefix });
  }
  const ids = wantedProject ? visible.filter((p) => p.id === wantedProject).map((p) => p.id) : visible.map((p) => p.id);

  let report = buildReport({ tasks: [], doneAt: new Map(), userNames: new Map(), granularity: g });
  if (ids.length > 0) {
    const rows = await ctx.db
      .select({
        id: tasks.id, ticketId: tasks.ticketId, title: tasks.title, status: tasks.status,
        assigneeId: tasks.assigneeId, projectPrefix: projects.prefix,
        createdAt: tasks.createdAt, updatedAt: tasks.updatedAt, dueDate: tasks.dueDate,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(inArray(tasks.projectId, ids));
    const events = rows.length === 0 ? [] : await ctx.db
      .select({ taskId: activityLog.taskId, at: sql<number>`max(${activityLog.createdAt})` })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .where(and(inArray(tasks.projectId, ids), eq(activityLog.eventType, "STATUS_CHANGED"), eq(activityLog.newStatus, "DONE")))
      .groupBy(activityLog.taskId);
    const people = await ctx.db.select({ id: user.id, name: user.name }).from(user);
    report = buildReport({
      tasks: rows, granularity: g,
      doneAt: new Map(events.map((e) => [e.taskId, Number(e.at)])),
      userNames: new Map(people.map((p) => [p.id, p.name])),
    });
  }
  return ({ ...report, projects: visible, projectId: wantedProject || null });
}

// GET /api/dashboard/stats: role-based, filterable (filters are super admin only).
export async function dashboardStats(ctx: Ctx, query: Query) {
  const u = ctx.user;
  const isSuper = u.role === "SUPER_ADMIN";
  const isAdmin = u.role === "ADMIN" || isSuper;

  // --- Parse filter query params (super admin only) ---
  const qProjectId = isSuper ? (query("projectId") || "").trim() : "";
  const qSprintId = isSuper ? (query("sprintId") || "").trim() : "";
  const qAssigneeId = isSuper ? (query("assigneeId") || "").trim() : "";
  const qStatus = isSuper ? (query("status") || "").trim() : "";
  const qPriority = isSuper ? (query("priority") || "").trim() : "";
  const qType = isSuper ? (query("type") || "").trim() : "";
  const qDays = isSuper ? Number(query("days") || 14) : 14;

  // Time range (applies ONLY to the time-based charts: daily/weekly/recent activity)
  const daysBack = Math.min(Math.max(qDays || 14, 7), 90);
  const timeCutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  // Projects the user can access (base RBAC)
  const accessibleProjectIds = isSuper
    ? (await ctx.db.select({ id: projects.id }).from(projects)).map((r) => r.id)
    : (await ctx.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, u.id))
        .orderBy(asc(projectMembers.projectId))
      ).map((r) => r.projectId);

  // Effective project filter: RBAC × optional filter
  let effectiveProjectIds = accessibleProjectIds;
  if (isSuper && qProjectId && accessibleProjectIds.includes(qProjectId)) {
    effectiveProjectIds = [qProjectId];
  }
  const projectFilter = effectiveProjectIds.length > 0
    ? inArray(tasks.projectId, effectiveProjectIds)
    : sql`1 = 0`;

  // Build additional WHERE clauses from filters (all filters applied to taskWhere)
  const extraConditions: ReturnType<typeof sql>[] = [];
  if (isSuper && qSprintId) extraConditions.push(eq(tasks.sprintId, qSprintId));
  if (isSuper && qAssigneeId) extraConditions.push(eq(tasks.assigneeId, qAssigneeId));
  if (isSuper && qStatus) extraConditions.push(sql`${tasks.status} = ${qStatus}`);
  if (isSuper && qPriority) extraConditions.push(sql`${tasks.priority} = ${qPriority}`);
  if (isSuper && qType) extraConditions.push(sql`${tasks.type} = ${qType}`);

  const taskWhere = extraConditions.length > 0
    ? and(projectFilter, ...extraConditions)
    : projectFilter;

  // --- Core counts (filtered) ---
  const [{ totalTickets }] = await ctx.db
    .select({ totalTickets: sql<number>`count(*)` })
    .from(tasks)
    .where(taskWhere);

  const myTickets = await ctx.db
    .select({
      id: tasks.id,
      ticketId: tasks.ticketId,
      title: tasks.title,
      status: tasks.status,
      type: tasks.type,
      priority: tasks.priority,
      projectId: tasks.projectId,
      projectPrefix: projects.prefix,
      projectName: projects.name,
      sprintId: tasks.sprintId,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(taskWhere, eq(tasks.assigneeId, u.id)))
    .orderBy(asc(tasks.updatedAt));

  const myProjects = await ctx.db
    .select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(
      effectiveProjectIds.length > 0
        ? inArray(projects.id, effectiveProjectIds)
        : sql`1 = 0`
    )
    .orderBy(asc(projects.name));

  // --- Status / priority / type breakdown (filtered) ---
  const statusRows = await ctx.db
    .select({ status: tasks.status, n: sql<number>`count(*)` })
    .from(tasks)
    .where(taskWhere)
    .groupBy(tasks.status);
  const statusCounts: Record<string, number> = {};
  for (const r of statusRows) statusCounts[r.status] = r.n;

  const priorityRows = await ctx.db
    .select({ priority: tasks.priority, n: sql<number>`count(*)` })
    .from(tasks)
    .where(taskWhere)
    .groupBy(tasks.priority);
  const priorityCounts: Record<string, number> = {};
  for (const r of priorityRows) priorityCounts[r.priority] = r.n;

  const typeRows = await ctx.db
    .select({ type: tasks.type, n: sql<number>`count(*)` })
    .from(tasks)
    .where(taskWhere)
    .groupBy(tasks.type);
  const typeCounts: Record<string, number> = {};
  for (const r of typeRows) typeCounts[r.type] = r.n;

  // --- Sprint stats (filtered) ---
  let sprintWhere = sql`1 = 1`;
  if (isSuper && qProjectId) sprintWhere = eq(sprints.projectId, qProjectId);
  else if (effectiveProjectIds.length > 0) sprintWhere = inArray(sprints.projectId, effectiveProjectIds);
  else sprintWhere = sql`1 = 0`;

  const sprintRows = await ctx.db
    .select({
      id: sprints.id,
      sprintId: sprints.sprintId,
      name: sprints.name,
      projectId: sprints.projectId,
      projectName: projects.name,
      projectPrefix: projects.prefix,
      total: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sql.raw('"sprints"."id"')} and ${taskWhere})`,
      done: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sql.raw('"sprints"."id"')} and ${tasks.status} = 'DONE' and ${taskWhere})`,
    })
    .from(sprints)
    .innerJoin(projects, eq(projects.id, sprints.projectId))
    .where(sprintWhere)
    .orderBy(asc(sprints.createdAt));

  // --- Daily stats (time-filtered) ---
  const dailyCreatedRows = await ctx.db
    .select({
      day: sql<string>`date(${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`,
      n: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(and(taskWhere, gte(tasks.createdAt, timeCutoffMs)))
    .groupBy(sql`date(${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`);

  // For activity-based completed stats: project + time + assignee/type/priority filters
  const activityExtra: ReturnType<typeof sql>[] = [eq(activityLog.newStatus, "DONE")];
  if (isSuper && qAssigneeId) activityExtra.push(eq(tasks.assigneeId, qAssigneeId));
  if (isSuper && qType) activityExtra.push(sql`${tasks.type} = ${qType}`);
  if (isSuper && qPriority) activityExtra.push(sql`${tasks.priority} = ${qPriority}`);

  const activityBase = and(projectFilter, ...activityExtra, gte(activityLog.createdAt, timeCutoffMs));

  const dailyCompletedRows = await ctx.db
    .select({
      day: sql<string>`date(${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`,
      n: sql<number>`count(*)`,
    })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .where(activityBase)
    .groupBy(sql`date(${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`);

  const dailyStats: { day: string; created: number; completed: number }[] = [];
  const dailyMap = new Map<string, { created: number; completed: number }>();
  for (const r of dailyCreatedRows) {
    const existing = dailyMap.get(r.day) || { created: 0, completed: 0 };
    existing.created = r.n;
    dailyMap.set(r.day, existing);
  }
  for (const r of dailyCompletedRows) {
    const existing = dailyMap.get(r.day) || { created: 0, completed: 0 };
    existing.completed = r.n;
    dailyMap.set(r.day, existing);
  }
  for (const [day, data] of dailyMap) dailyStats.push({ day, ...data });
  dailyStats.sort((a, b) => a.day.localeCompare(b.day));

  // --- Weekly stats ---
  const weeksBack = Math.min(Math.ceil(daysBack / 7), 12);
  const weeklyCutoffMs = Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000;

  const weeklyCreatedRows = await ctx.db
    .select({
      week: sql<string>`strftime('%Y-W%W', ${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`,
      n: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(and(extraConditions.length > 0 ? and(projectFilter, ...extraConditions) : projectFilter, gte(tasks.createdAt, weeklyCutoffMs)))
    .groupBy(sql`strftime('%Y-W%W', ${tasks.createdAt} / 1000, 'unixepoch', 'localtime')`);

  const weeklyActivityBase = and(projectFilter, ...activityExtra, gte(activityLog.createdAt, weeklyCutoffMs));

  const weeklyCompletedRows = await ctx.db
    .select({
      week: sql<string>`strftime('%Y-W%W', ${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`,
      n: sql<number>`count(*)`,
    })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .where(weeklyActivityBase)
    .groupBy(sql`strftime('%Y-W%W', ${activityLog.createdAt} / 1000, 'unixepoch', 'localtime')`);

  const weeklyStats: { week: string; created: number; completed: number }[] = [];
  const weeklyMap = new Map<string, { created: number; completed: number }>();
  for (const r of weeklyCreatedRows) {
    const existing = weeklyMap.get(r.week) || { created: 0, completed: 0 };
    existing.created = r.n;
    weeklyMap.set(r.week, existing);
  }
  for (const r of weeklyCompletedRows) {
    const existing = weeklyMap.get(r.week) || { created: 0, completed: 0 };
    existing.completed = r.n;
    weeklyMap.set(r.week, existing);
  }
  for (const [week, data] of weeklyMap) weeklyStats.push({ week, ...data });
  weeklyStats.sort((a, b) => a.week.localeCompare(b.week));

  // --- Recent activity (all filters applied) ---
  const activityTaskConditions: ReturnType<typeof sql>[] = [eq(activityLog.eventType, "STATUS_CHANGED")];
  if (isSuper && qSprintId) activityTaskConditions.push(eq(tasks.sprintId, qSprintId));
  if (isSuper && qAssigneeId) activityTaskConditions.push(eq(tasks.assigneeId, qAssigneeId));
  if (isSuper && qStatus) activityTaskConditions.push(sql`${tasks.status} != ${qStatus}`); // show transitions involving this status
  if (isSuper && qPriority) activityTaskConditions.push(sql`${tasks.priority} = ${qPriority}`);
  if (isSuper && qType) activityTaskConditions.push(sql`${tasks.type} = ${qType}`);
  if (isSuper) activityTaskConditions.push(gte(activityLog.createdAt, timeCutoffMs));

  const recentActivity = await ctx.db
    .select({
      id: activityLog.id,
      taskId: activityLog.taskId,
      ticketId: tasks.ticketId,
      taskTitle: tasks.title,
      projectId: tasks.projectId,
      projectName: projects.name,
      projectPrefix: projects.prefix,
      actorId: activityLog.actorId,
      actorName: user.name,
      oldStatus: activityLog.oldStatus,
      newStatus: activityLog.newStatus,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(user, eq(user.id, activityLog.actorId))
    .where(and(projectFilter, ...activityTaskConditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(10);

  // --- Team workload (ADMIN+, filtered) ---
  let teamWorkload: { userId: string; name: string; openCount: number; doneCount: number }[] = [];
  if (isAdmin && effectiveProjectIds.length > 0) {
    const workloadWhere = isSuper
      ? and(taskWhere, sql`${tasks.assigneeId} is not null`)
      : and(projectFilter, sql`${tasks.assigneeId} is not null`);

    const workloadRows = await ctx.db
      .select({
        userId: tasks.assigneeId,
        openCount: sql<number>`count(case when ${tasks.status} != 'DONE' then 1 end)`,
        doneCount: sql<number>`count(case when ${tasks.status} = 'DONE' then 1 end)`,
      })
      .from(tasks)
      .where(workloadWhere)
      .groupBy(tasks.assigneeId);

    for (const r of workloadRows) {
      const [uRow] = await ctx.db.select({ name: user.name }).from(user).where(eq(user.id, r.userId!));
      teamWorkload.push({
        userId: r.userId!,
        name: uRow?.name ?? "Unknown",
        openCount: r.openCount,
        doneCount: r.doneCount,
      });
    }
    teamWorkload.sort((a, b) => b.openCount - a.openCount);
  }

  // --- Super-admin-only stats (filtered) ---
  let totalProjects = 0;
  let totalUsers = 0;
  let projectStats: { id: string; name: string; prefix: string; total: number; done: number; overdue: number; lastActivity: number | null; members: number }[] = [];
  let topAssignees: { name: string; total: number }[] = [];
  let filterOptions: {
    projects: { id: string; name: string; prefix: string }[];
    sprints: { id: string; sprintId: string; name: string; projectId: string }[];
    users: { id: string; name: string; email: string }[];
  } | null = null;

  if (isSuper) {
    // Count projects that have at least one matching ticket (or all if no project filter)
    const projCountRow = await ctx.db
      .select({ n: sql<number>`count(distinct ${tasks.projectId})` })
      .from(tasks)
      .where(taskWhere);
    totalProjects = projCountRow[0]?.n ?? 0;

    // Count users who have at least one matching ticket
    const userCountRow = await ctx.db
      .select({ n: sql<number>`count(distinct ${tasks.assigneeId})` })
      .from(tasks)
      .where(and(taskWhere, sql`${tasks.assigneeId} is not null`));
    totalUsers = userCountRow[0]?.n ?? 0;

    // Per-project breakdown using taskWhere
    projectStats = await ctx.db
      .select({
        id: projects.id,
        name: projects.name,
        prefix: projects.prefix,
        total: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${sql.raw('"projects"."id"')} and ${taskWhere})`,
        done: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${sql.raw('"projects"."id"')} and ${tasks.status} = 'DONE' and ${taskWhere})`,
        overdue: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${sql.raw('"projects"."id"')} and ${tasks.status} != 'DONE' and ${tasks.dueDate} is not null and ${tasks.dueDate} < date('now', 'localtime') and ${taskWhere})`,
        lastActivity: sql<number | null>`(select max(${tasks.updatedAt}) from ${tasks} where ${tasks.projectId} = ${sql.raw('"projects"."id"')} and ${taskWhere})`,
        members: sql<number>`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${sql.raw('"projects"."id"')})`,
      })
      .from(projects)
      .where(effectiveProjectIds.length > 0 ? inArray(projects.id, effectiveProjectIds) : sql`1 = 1`)
      .orderBy(asc(projects.name));

    // Top assignees (all filters applied via taskWhere)
    const topRows = await ctx.db
      .select({
        name: user.name,
        total: sql<number>`count(*)`,
      })
      .from(tasks)
      .innerJoin(user, eq(user.id, tasks.assigneeId))
      .where(and(taskWhere, sql`${tasks.assigneeId} is not null`))
      .groupBy(tasks.assigneeId)
      .orderBy(sql`count(*) desc`)
      .limit(10);
    topAssignees = topRows;

    // Filter options for the UI dropdowns (always show all options)
    const allProjects = await ctx.db
      .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
      .from(projects)
      .orderBy(asc(projects.name));

    let sprintQuery = ctx.db
      .select({ id: sprints.id, sprintId: sprints.sprintId, name: sprints.name, projectId: sprints.projectId })
      .from(sprints)
      .orderBy(asc(sprints.createdAt));
    if (qProjectId) {
      sprintQuery = sprintQuery.where(eq(sprints.projectId, qProjectId)) as typeof sprintQuery;
    }
    const allSprints = await sprintQuery;

    const allUsers = await ctx.db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .orderBy(asc(user.name));

    filterOptions = { projects: allProjects, sprints: allSprints, users: allUsers };
  }

  return ({
    totalTickets,
    totalProjects,
    totalUsers,
    myTickets,
    myProjects,
    statusCounts,
    priorityCounts,
    typeCounts,
    sprintStats: sprintRows,
    dailyStats,
    weeklyStats,
    recentActivity,
    teamWorkload,
    projectStats,
    topAssignees,
    filterOptions,
  });
}
