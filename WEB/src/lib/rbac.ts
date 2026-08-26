import { and, asc, count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { AppDB } from "../db/client";
import { projectMembers, projects, tasks, user } from "../db/schema";
import { getDb } from "../db/client";
import { createAuth } from "../auth/server";
import { ApiError } from "./http";
import { STATUSES, type Status } from "./status";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "SUPER_ADMIN" | "ADMIN" | "USER";
}

export async function getSessionUser(request: Request, env: Env): Promise<SessionUser> {
  const auth = createAuth(env);
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) throw new ApiError(401, "Unauthorized");
  const u = result.user as SessionUser;
  return u;
}

export function requireSuperAdmin(u: SessionUser): void {
  if (u.role !== "SUPER_ADMIN") throw new ApiError(403, "Super admin only");
}

export function requirePanelAccess(u: SessionUser): void {
  if (u.role === "USER") throw new ApiError(403, "Admin access required");
}

export type ProjectRole = "ADMIN" | "MEMBER";

export async function requireProjectRole(
  db: AppDB,
  u: SessionUser,
  projectId: string,
  minRole: ProjectRole = "MEMBER"
): Promise<ProjectRole> {
  // Strict model (v1.5): only SUPER_ADMIN has implicit access to every
  // project; global ADMINs need an explicit membership like everyone else.
  if (u.role === "SUPER_ADMIN") return "ADMIN";

  const [membership] = await getDb(db)
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.id)));

  if (!membership) throw new ApiError(403, "You are not a member of this project");
  if (minRole === "ADMIN" && membership.role !== "ADMIN") {
    throw new ApiError(403, "Project admin role required");
  }
  return membership.role;
}

export async function listAccessibleProjects(db: AppDB, u: SessionUser) {
  // SUPER_ADMIN sees everything; ADMIN and USER see their memberships.
  const rows = u.role === "SUPER_ADMIN"
    ? await db.select({ ...getTableColumns(projects) }).from(projects).orderBy(projects.name)
    : await db
        .select({ ...getTableColumns(projects), role: projectMembers.role })
        .from(projects)
        .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(eq(projectMembers.userId, u.id))
        .orderBy(projects.name);

  const statusRows = await db
    .select({ projectId: tasks.projectId, status: tasks.status, n: count(tasks.id) })
    .from(tasks)
    .groupBy(tasks.projectId, tasks.status);

  return rows.map((p) => {
    const counts = statusRows.filter((r) => r.projectId === p.id);
    const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const r of counts) {
      const s = STATUSES.find((x) => x === r.status);
      if (s) statusCounts[s] = r.n;
    }
    return { ...p, ticketCount: counts.reduce((sum, r) => sum + r.n, 0), statusCounts };
  });
}

export async function listAssignedTickets(db: AppDB, u: SessionUser) {
  const accessible = await listAccessibleProjects(db, u);
  if (accessible.length === 0) return [];
  return db
    .select({
      id: tasks.id,
      ticketId: tasks.ticketId,
      title: tasks.title,
      status: tasks.status,
      type: tasks.type,
      priority: tasks.priority,
      position: tasks.position,
      projectId: tasks.projectId,
      projectName: projects.name,
      projectPrefix: projects.prefix,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(tasks.assigneeId, u.id),
      inArray(tasks.projectId, accessible.map((p) => p.id))
    ))
    .orderBy(asc(projects.name), asc(tasks.position));
}

export async function listMemberEmails(db: AppDB, projectId: string): Promise<string[]> {
  const rows = await getDb(db)
    .select({ email: user.email })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  return rows.map((r) => r.email);
}

export async function listAdminEmails(db: AppDB, projectId: string): Promise<string[]> {
  const rows = await getDb(db)
    .select({ email: user.email })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "ADMIN")));
  return rows.map((r) => r.email);
}

export async function listSuperAdminEmails(db: AppDB): Promise<string[]> {
  const rows = await getDb(db).select({ email: user.email }).from(user).where(eq(user.role, "SUPER_ADMIN"));
  return rows.map((r) => r.email);
}
