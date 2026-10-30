import { and, asc, eq, sql, count, desc } from "drizzle-orm";
import { projects, projectMembers, projectMemberPermissions, user, accessAudit } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { createAuth } from "../../../auth/server";
import { INTERNAL_SIGNUP_SECRET } from "../../../shared/signup-secret";
import { EMAIL_RE } from "../../../shared/validate";
import { requireSuperAdmin, requirePanelAccess, getMemberPermissions, setMemberPermissions, ensureDefaultMemberPermissions, PROJECT_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, type ProjectPermission } from "../rbac";
import { recordAccess, recordPermissionChange, currentMemberRole } from "../audit";
import { applyPasswordReset } from "../../accounts/index";
import type { Ctx } from "../ctx";
import type { Input } from "../../../shared/route";

// Super-admin panel API: user accounts, project membership, access audit and matrix.
export async function listUsers(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requirePanelAccess(u);

  // Optional pagination: without ?page the full array is returned
  // (backwards compatible with the admin UI).
  const page = Number(input.query("page") ?? 0);
  const perPage = Math.min(Number(input.query("perPage") ?? 25), 100);
  if (!page || page < 1) {
    const rows = await ctx.db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
      .from(user)
      .orderBy(asc(user.name));
    return rows;
  }

  const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)` }).from(user);
  const rows = await ctx.db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .orderBy(asc(user.name))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { data: rows, total, page, perPage };
}

// Creates an account directly (name/e-mail/password set by the admin), no
// invite token and no e-mail sent. Mirrors setup's use of the internal sign-up
// header, just without the "no super admin yet" gate.
export async function createUser(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);

  const body = await input.body<{ name?: string; email?: string; password?: string; role?: string }>();
  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  const password = body.password ?? "";
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid e-mail address is required");
  if (!name) throw new ApiError(400, "Name is required");
  if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");
  const role = body.role ?? "USER";
  if (role !== "SUPER_ADMIN" && role !== "ADMIN" && role !== "USER") throw new ApiError(400, "Invalid role");

  const [existingUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existingUser) throw new ApiError(409, "An account with this e-mail already exists");

  const auth = createAuth(ctx.env);
  const internalHeaders = new Headers({ "x-internal-signup": INTERNAL_SIGNUP_SECRET });
  let userId: string;
  try {
    const result = await auth.api.signUpEmail({ headers: internalHeaders, body: { email, name, password } });
    userId = result.user.id;
  } catch (e) {
    // The e-mail-uniqueness case is already handled above, so a failure
    // here is an unexpected error (bad DB state, etc.) — surface it
    // instead of a hardcoded, likely-wrong guess.
    console.error("admin user creation failed:", e);
    throw new ApiError(500, `Could not create account: ${e instanceof Error ? e.message : "unknown error"}`);
  }

  // Admin-set password: force a change on first login.
  await ctx.db
    .update(user)
    .set({ mustChangePassword: true, ...(role !== "USER" ? { role } : {}), updatedAt: new Date() })
    .where(eq(user.id, userId));

  const [created] = await ctx.db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, userId));
  return created;
}

export async function setUserRole(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  // Lockout protection: a super admin cannot change their own role.
  if (id === actor.id) throw new ApiError(400, "You cannot change your own role");

  const body = await input.body<{ role?: string }>();
  if (body.role !== "SUPER_ADMIN" && body.role !== "ADMIN" && body.role !== "USER") throw new ApiError(400, "Invalid role");
  const [before] = await ctx.db.select({ role: user.role }).from(user).where(eq(user.id, id));

  const [updated] = await ctx.db
    .update(user)
    .set({ role: body.role, updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning({ id: user.id, email: user.email, role: user.role });
  if (!updated) throw new ApiError(404, "User not found");
  if (before?.role !== updated.role) await recordAccess(ctx, { action: "ROLE_CHANGED", targetUserId: id, detail: { from: before?.role, to: updated.role } });
  return updated;
}

export async function setUserPassword(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  const body = await input.body<{ password?: string }>();
  if (!body.password || body.password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }
  // Reset the target's password and revoke their sessions (forces re-login).
  await applyPasswordReset(ctx.db, id, body.password);
  // Admin-set password: force a change on next login.
  await ctx.db.update(user).set({ mustChangePassword: true, updatedAt: new Date() }).where(eq(user.id, id));
  return { ok: true };
}

export async function deleteUser(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  // Lockout protection: a super admin cannot delete their own account.
  if (id === actor.id) throw new ApiError(400, "You cannot delete your own account");

  await recordAccess(ctx, { action: "ACCOUNT_DELETED", targetUserId: id });
  // Sessions and memberships cascade; tickets fall back to "Unassigned".
  const deleted = await ctx.db
    .delete(user)
    .where(eq(user.id, id))
    .returning({ id: user.id, email: user.email });
  if (deleted.length === 0) throw new ApiError(404, "User not found");
  return { ok: true };
}

export async function getUser(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  const [u] = await ctx.db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, id));
  if (!u) throw new ApiError(404, "User not found");
  const memberships = await ctx.db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, id));
  const permRows = await ctx.db
    .select({ projectId: projectMemberPermissions.projectId, permission: projectMemberPermissions.permission })
    .from(projectMemberPermissions)
    .where(eq(projectMemberPermissions.userId, id));
  const permsByProject = new Map<string, string[]>();
  for (const r of permRows) permsByProject.set(r.projectId, [...(permsByProject.get(r.projectId) ?? []), r.permission]);
  return {
    ...u,
    projects: memberships.map((m) => ({
      ...m,
      permissions: m.role === "ADMIN" ? [...PROJECT_PERMISSIONS] : permsByProject.get(m.projectId) ?? [],
    })),
    availablePermissions: PROJECT_PERMISSIONS,
  };
}

export async function addUserToProject(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  const body = await input.body<{ projectId?: string; role?: string }>();
  if (!body.projectId) throw new ApiError(400, "projectId is required");
  const memberRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";

  const [target] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!target) throw new ApiError(404, "User not found");
  const previousRole = await currentMemberRole(ctx, body.projectId, id);

  await ctx.db
    .insert(projectMembers)
    .values({ projectId: body.projectId, userId: id, role: memberRole })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: memberRole },
    });
  await ensureDefaultMemberPermissions(ctx.db, body.projectId, id, memberRole);
  if (previousRole !== memberRole) {
    await recordAccess(ctx, { action: previousRole ? "MEMBER_ROLE_CHANGED" : "MEMBER_ADDED", targetUserId: id, projectId: body.projectId, detail: { from: previousRole, to: memberRole } });
  }
  return { ok: true };
}

export async function setUserProjectPermissions(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const id = input.p.id;
  const projectId = input.p.projectId;

  const [membership] = await ctx.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, id)));
  if (!membership) throw new ApiError(404, "This user is not a member of this project");
  if (membership.role === "ADMIN") {
    throw new ApiError(400, "Project admins already have full access; permissions only apply to members");
  }

  const body = await input.body<{ permissions?: string[] }>();
  if (!Array.isArray(body.permissions)) throw new ApiError(400, "permissions must be an array");
  const valid = new Set<string>(PROJECT_PERMISSIONS);
  const invalid = body.permissions.filter((p) => !valid.has(p));
  if (invalid.length > 0) throw new ApiError(400, `Unknown permission(s): ${invalid.join(", ")}`);

  const beforePerms = await getMemberPermissions(ctx.db, projectId, id);
  await setMemberPermissions(ctx.db, projectId, id, body.permissions as ProjectPermission[]);
  await recordPermissionChange(ctx, id, projectId, beforePerms, body.permissions);
  return { ok: true, permissions: body.permissions };
}

export async function removeUserFromProject(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const userId = input.p.id;
  const projectId = input.p.projectId;
  const hadRole = await currentMemberRole(ctx, projectId, userId);
  if (hadRole) await recordAccess(ctx, { action: "MEMBER_REMOVED", targetUserId: userId, projectId, detail: { from: hadRole } });
  await ctx.db.delete(projectMembers).where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)));
  await ctx.db.delete(projectMemberPermissions).where(and(eq(projectMemberPermissions.userId, userId), eq(projectMemberPermissions.projectId, projectId)));
  // A removed member can no longer be the project's default assignee.
  await ctx.db.update(projects).set({ defaultAssigneeId: null }).where(and(eq(projects.id, projectId), eq(projects.defaultAssigneeId, userId)));
  return { ok: true };
}

// Project-side view of the same memberships (kept in sync by design: both
// editors write to the project_members table).
export async function listProjectMembers(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const projectId = input.p.id;
  const [project] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");
  const members = await ctx.db
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      name: user.name,
      email: user.email,
      globalRole: user.role,
    })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));

  const permRows = await ctx.db
    .select({ userId: projectMemberPermissions.userId, permission: projectMemberPermissions.permission })
    .from(projectMemberPermissions)
    .where(eq(projectMemberPermissions.projectId, projectId));
  const permsByUser = new Map<string, string[]>();
  for (const r of permRows) permsByUser.set(r.userId, [...(permsByUser.get(r.userId) ?? []), r.permission]);

  return {
    members: members.map((m) => ({ ...m, permissions: m.role === "ADMIN" ? [...PROJECT_PERMISSIONS] : permsByUser.get(m.userId) ?? [] })),
    availablePermissions: PROJECT_PERMISSIONS,
  };
}

export async function setMemberPermissionsAdmin(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const projectId = input.p.id;
  const userId = input.p.userId;

  const [membership] = await ctx.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!membership) throw new ApiError(404, "This user is not a member of this project");
  if (membership.role === "ADMIN") {
    throw new ApiError(400, "Project admins already have full access; permissions only apply to members");
  }

  const body = await input.body<{ permissions?: string[] }>();
  if (!Array.isArray(body.permissions)) throw new ApiError(400, "permissions must be an array");
  const valid = new Set<string>(PROJECT_PERMISSIONS);
  const invalid = body.permissions.filter((p) => !valid.has(p));
  if (invalid.length > 0) throw new ApiError(400, `Unknown permission(s): ${invalid.join(", ")}`);

  const beforePerms = await getMemberPermissions(ctx.db, projectId, userId);
  await setMemberPermissions(ctx.db, projectId, userId, body.permissions as ProjectPermission[]);
  await recordPermissionChange(ctx, userId, projectId, beforePerms, body.permissions);
  return { ok: true, permissions: body.permissions };
}

export async function addProjectMember(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const projectId = input.p.id;
  const body = await input.body<{ userId?: string; role?: string }>();
  if (!body.userId) throw new ApiError(400, "userId is required");
  const memberRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";

  const [project] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");
  const [target] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.id, body.userId));
  if (!target) throw new ApiError(404, "User not found");
  const previousRole = await currentMemberRole(ctx, projectId, body.userId);

  await ctx.db
    .insert(projectMembers)
    .values({ projectId, userId: body.userId, role: memberRole })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: memberRole },
    });
  await ensureDefaultMemberPermissions(ctx.db, projectId, body.userId, memberRole);
  if (previousRole !== memberRole) {
    await recordAccess(ctx, { action: previousRole ? "MEMBER_ROLE_CHANGED" : "MEMBER_ADDED", targetUserId: body.userId, projectId, detail: { from: previousRole, to: memberRole } });
  }
  return { ok: true };
}

export async function removeProjectMember(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const projectId = input.p.id;
  const userId = input.p.userId;
  const hadRole = await currentMemberRole(ctx, projectId, userId);
  if (hadRole) await recordAccess(ctx, { action: "MEMBER_REMOVED", targetUserId: userId, projectId, detail: { from: hadRole } });
  await ctx.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  await ctx.db.delete(projectMemberPermissions).where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, userId)));
  // A removed member can no longer be the project's default assignee.
  await ctx.db.update(projects).set({ defaultAssigneeId: null }).where(and(eq(projects.id, projectId), eq(projects.defaultAssigneeId, userId)));
  return { ok: true };
}

export async function listAudit(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const limit = Math.min(Math.max(Number(input.query("limit")) || 100, 1), 500);
  const rows = await ctx.db.select().from(accessAudit).orderBy(desc(accessAudit.createdAt)).limit(limit);
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

// Users x projects matrix: who has which role / permissions where.
export async function accessMatrix(ctx: Ctx, _input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const [users, projectRows, members, perms] = await Promise.all([
    ctx.db.select({ id: user.id, name: user.name, email: user.email, role: user.role }).from(user).orderBy(asc(user.name)),
    ctx.db.select({ id: projects.id, name: projects.name, prefix: projects.prefix }).from(projects).orderBy(asc(projects.name)),
    ctx.db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId, role: projectMembers.role }).from(projectMembers),
    ctx.db.select().from(projectMemberPermissions),
  ]);
  const permMap = new Map<string, string[]>();
  for (const p of perms) {
    const k = `${p.projectId}:${p.userId}`;
    permMap.set(k, [...(permMap.get(k) ?? []), p.permission]);
  }
  return {
    users, projects: projectRows,
    memberships: members.map((m) => ({ ...m, permissions: m.role === "ADMIN" ? [...PROJECT_PERMISSIONS] : (permMap.get(`${m.projectId}:${m.userId}`) ?? []) })),
  };
}
