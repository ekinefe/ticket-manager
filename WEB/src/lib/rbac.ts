import { and, asc, count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { AppDB } from "../db/client";
import { projectMemberPermissions, projectMembers, projects, tasks, user } from "../db/schema";
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

// Fine-grained capabilities a project MEMBER can be individually granted.
// ADMIN (project or global) always has every one of these implicitly; they
// only matter as opt-in extras/restrictions for plain MEMBER accounts (e.g.
// a freelancer who should only see their own tickets, or a trusted member
// who's allowed to manage sprints without being a full project admin).
export const PROJECT_PERMISSIONS = [
  "VIEW_ALL_TICKETS",
  "CREATE_TICKET",
  "COMMENT_ON_OTHERS_TICKETS",
  "MOVE_OTHERS_TICKETS",
  "DELETE_TICKET",
  "MANAGE_MEMBERS",
  "MANAGE_SPRINTS",
] as const;
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

// What a brand-new MEMBER is granted by default — matches the app's
// historical (pre-permissions) MEMBER behavior, so existing projects don't
// change behavior until an admin explicitly grants/restricts someone.
// Historically a MEMBER could view and comment on any ticket and create new
// ones, but could only edit/move a ticket they created or are assigned to
// (moving others' tickets required being a project admin) — so
// MOVE_OTHERS_TICKETS is a genuinely new, opt-in capability, not a default.
export const DEFAULT_MEMBER_PERMISSIONS: ProjectPermission[] = [
  "VIEW_ALL_TICKETS",
  "CREATE_TICKET",
  "COMMENT_ON_OTHERS_TICKETS",
];

export interface ProjectAccess {
  role: ProjectRole;
  can(permission: ProjectPermission): boolean;
}

/**
 * Resolves a user's effective access to a project: their role, and (for
 * MEMBERs only) which of PROJECT_PERMISSIONS they've been granted. Throws if
 * the user isn't a member at all. ADMIN (project or SUPER_ADMIN) always
 * reports every permission as granted, without needing a DB round-trip.
 */
export async function getProjectAccess(db: AppDB, u: SessionUser, projectId: string): Promise<ProjectAccess> {
  if (u.role === "SUPER_ADMIN") return { role: "ADMIN", can: () => true };

  const [membership] = await getDb(db)
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.id)));
  if (!membership) throw new ApiError(403, "You are not a member of this project");
  if (membership.role === "ADMIN") return { role: "ADMIN", can: () => true };

  const rows = await getDb(db)
    .select({ permission: projectMemberPermissions.permission })
    .from(projectMemberPermissions)
    .where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, u.id)));
  const granted = new Set(rows.map((r) => r.permission));
  return { role: "MEMBER", can: (p) => granted.has(p) };
}

export async function requireProjectPermission(
  db: AppDB,
  u: SessionUser,
  projectId: string,
  permission: ProjectPermission
): Promise<ProjectAccess> {
  const access = await getProjectAccess(db, u, projectId);
  if (!access.can(permission)) throw new ApiError(403, `Missing permission: ${permission}`);
  return access;
}

export async function getMemberPermissions(db: AppDB, projectId: string, userId: string): Promise<ProjectPermission[]> {
  const rows = await getDb(db)
    .select({ permission: projectMemberPermissions.permission })
    .from(projectMemberPermissions)
    .where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, userId)));
  return rows.map((r) => r.permission as ProjectPermission);
}

export async function setMemberPermissions(
  db: AppDB,
  projectId: string,
  userId: string,
  permissions: ProjectPermission[]
): Promise<void> {
  const valid = new Set(PROJECT_PERMISSIONS);
  const clean = [...new Set(permissions)].filter((p): p is ProjectPermission => valid.has(p as ProjectPermission));
  await getDb(db)
    .delete(projectMemberPermissions)
    .where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, userId)));
  if (clean.length > 0) {
    await getDb(db)
      .insert(projectMemberPermissions)
      .values(clean.map((permission) => ({ projectId, userId, permission })));
  }
}

/**
 * Seeds DEFAULT_MEMBER_PERMISSIONS for a MEMBER who currently has no
 * permission rows at all — covers a brand-new membership, and a demotion
 * from ADMIN (who never needed permission rows). Never touches a MEMBER who
 * already has rows, so an admin's earlier customization is never clobbered.
 */
export async function ensureDefaultMemberPermissions(
  db: AppDB,
  projectId: string,
  userId: string,
  role: ProjectRole
): Promise<void> {
  if (role !== "MEMBER") return;
  const existing = await getMemberPermissions(db, projectId, userId);
  if (existing.length === 0) await setMemberPermissions(db, projectId, userId, DEFAULT_MEMBER_PERMISSIONS);
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
