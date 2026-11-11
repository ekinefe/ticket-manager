import { and, eq, ne, notLike, sql } from "drizzle-orm";
import { projects, projectMembers, user, sprints, tasks } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { requireSuperAdmin, requirePanelAccess, requireProjectRole, getProjectAccess, listAccessibleProjects, PROJECT_PERMISSIONS } from "../../access/index";
import { createDefaultSprint, listProjectSprints } from "../../sprints/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";
import type { CreateProjectBody, UpdateProjectBody } from "../dto";

// Project lifecycle and the project detail view model (members, sprints, myPermissions).

// A key (prefix) names every ticket id (PLN-12), so two projects must never share one. The database
// enforces it too (UNIQUE), but its raw error is not something to show a person.
async function assertKeyFree(ctx: Ctx, prefix: string, exceptProjectId?: string) {
  const [taken] = await ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(exceptProjectId ? and(eq(projects.prefix, prefix), ne(projects.id, exceptProjectId)) : eq(projects.prefix, prefix));
  if (taken) throw new ApiError(409, `The key ${prefix} is already used by the project "${taken.name}". Pick another key.`);
}

export async function listMyProjects(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  return await listAccessibleProjects(ctx.db, u);
}

export async function createProject(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requirePanelAccess(u);

  const body = await input.body<CreateProjectBody>();
  const name = body.name?.trim();
  const prefix = body.prefix?.trim().toUpperCase();
  if (!name) throw new ApiError(400, "Project name is required");
  if (!prefix || !/^[A-Z0-9]{2,5}$/.test(prefix)) {
    throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits (e.g. WCE)");
  }

  await assertKeyFree(ctx, prefix);
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

// Every ticket id and sprint code of a project starts with its key (PLN-12, PLN-S1). When the key changes they
// are all renamed, number kept (PLN-12 -> PLC-12), so no ticket keeps naming a key the project no longer has.
// It looks at what each row starts with instead of at the old key, so saving the same key again also finishes
// a rename that was cut short (the statements are separate: neither D1 nor the local adapter runs them as one).
async function renameToKey(ctx: Ctx, projectId: string, prefix: string) {
  await ctx.db
    .update(tasks)
    .set({ ticketId: sql`${prefix} || substr(${tasks.ticketId}, instr(${tasks.ticketId}, '-'))` })
    .where(and(eq(tasks.projectId, projectId), notLike(tasks.ticketId, `${prefix}-%`)));
  await ctx.db
    .update(sprints)
    .set({ sprintId: sql`${prefix} || substr(${sprints.sprintId}, instr(${sprints.sprintId}, '-'))` })
    .where(and(eq(sprints.projectId, projectId), notLike(sprints.sprintId, `${prefix}-%`)));
}

export async function updateProject(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId, "ADMIN");

  const body = await input.body<UpdateProjectBody>();
  if (!body.name && !body.prefix && body.defaultAssigneeId === undefined) throw new ApiError(400, "Nothing to update");

  const values: Partial<{ name: string; prefix: string; defaultAssigneeId: string | null }> = {};
  if (body.name) values.name = body.name.trim();
  if (body.prefix) {
    const prefix = body.prefix.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(prefix)) throw new ApiError(400, "Prefix must be 2-5 uppercase letters/digits");
    await assertKeyFree(ctx, prefix, projectId);
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
  if (values.prefix) await renameToKey(ctx, projectId, values.prefix);
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
