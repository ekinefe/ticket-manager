import { and, eq } from "drizzle-orm";
import { projects, projectMembers, user, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { requireSuperAdmin, requirePanelAccess, requireProjectRole, getProjectAccess, listAccessibleProjects, PROJECT_PERMISSIONS } from "../../access/index";
import { createDefaultSprint, listProjectSprints } from "../../sprints/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";

// Project lifecycle and the project detail view model (members, sprints, myPermissions).
export async function listMyProjects(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  return await listAccessibleProjects(ctx.db, u);
}

export async function createProject(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requirePanelAccess(u);

  const body = await input.body<{ name?: string; prefix?: string }>();
  const name = body.name?.trim();
  const prefix = body.prefix?.trim().toUpperCase();
  if (!name) throw new ApiError(400, "Project name is required");
  if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
    throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits (e.g. WCE)");
  }

  const id = crypto.randomUUID();
  const [project] = await ctx.db
    .insert(projects)
    .values({ id, name, prefix, currentTicketSequence: 0, createdAt: Date.now() })
    .returning();
  await ctx.db.insert(projectMembers).values({ projectId: id, userId: u.id, role: "ADMIN" });
  await createDefaultSprint(ctx, id, prefix);
  return project;
}

export async function getProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId);
  const access = await getProjectAccess(ctx.db, u, projectId);

  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");

  const members = await ctx.db
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      name: user.name,
      email: user.email,
    })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));

  const projectSprints = await listProjectSprints(ctx, projectId);

  const myPermissions = PROJECT_PERMISSIONS.filter((p) => access.can(p));

  return { ...project, members, sprints: projectSprints, myPermissions };
}

export async function updateProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId, "ADMIN");

  const body = await input.body<{ name?: string; prefix?: string; defaultAssigneeId?: string | null }>();
  if (!body.name && !body.prefix && body.defaultAssigneeId === undefined) throw new ApiError(400, "Nothing to update");

  const values: Partial<{ name: string; prefix: string; defaultAssigneeId: string | null }> = {};
  if (body.name) values.name = body.name.trim();
  if (body.prefix) {
    const prefix = body.prefix.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(prefix)) throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
    values.prefix = prefix;
  }
  if (body.defaultAssigneeId !== undefined) {
    if (body.defaultAssigneeId) {
      const [member] = await ctx.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, body.defaultAssigneeId)));
      if (!member) throw new ApiError(400, "Default assignee must be a member of this project");
      values.defaultAssigneeId = body.defaultAssigneeId;
    } else {
      values.defaultAssigneeId = null;
    }
  }

  const [updated] = await ctx.db.update(projects).set(values).where(eq(projects.id, projectId)).returning();
  if (!updated) throw new ApiError(404, "Project not found");
  return updated;
}

export async function deleteProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  requireSuperAdmin(u);

  const deleted = await ctx.db.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
  if (deleted.length === 0) throw new ApiError(404, "Project not found");
  return { ok: true };
}
