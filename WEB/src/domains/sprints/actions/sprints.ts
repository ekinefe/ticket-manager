import { and, eq } from "drizzle-orm";
import { projects, sprints } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { requireProjectPermission, type Ctx } from "../../access/index";
import { countProjectSprints, nextSprintId } from "../queries/sprints";

// Every project starts with "Sprint 1" (PREFIX-S1); further sprints continue
// the sequence. The UNIQUE constraint on sprint_id is the race backstop.
export async function createDefaultSprint(ctx: Pick<Ctx, "db">, projectId: string, prefix: string): Promise<void> {
  await ctx.db.insert(sprints).values({
    id: crypto.randomUUID(),
    projectId,
    sprintId: `${prefix}-S1`,
    name: "Sprint 1",
    createdAt: Date.now(),
  }).onConflictDoNothing();
}

export async function createSprint(ctx: Ctx, projectId: string, rawName?: string) {
  await requireProjectPermission(ctx.db, ctx.user, projectId, "MANAGE_SPRINTS");
  const [project] = await ctx.db
    .select({ prefix: projects.prefix })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");

  const sprintId = await nextSprintId(ctx, projectId, project.prefix);
  const number = Number(sprintId.split("-S")[1]);
  const name = rawName?.trim() || `Sprint ${number}`;
  const [created] = await ctx.db
    .insert(sprints)
    .values({ id: crypto.randomUUID(), projectId, sprintId, name, createdAt: Date.now() })
    .returning();
  return created;
}

export async function renameSprint(ctx: Ctx, projectId: string, sprintRowId: string, rawName?: string) {
  await requireProjectPermission(ctx.db, ctx.user, projectId, "MANAGE_SPRINTS");
  const name = rawName?.trim();
  if (!name) throw new ApiError(400, "Sprint name is required");

  const [updated] = await ctx.db
    .update(sprints)
    .set({ name })
    .where(and(eq(sprints.id, sprintRowId), eq(sprints.projectId, projectId)))
    .returning();
  if (!updated) throw new ApiError(404, "Sprint not found");
  return updated;
}

export async function deleteSprint(ctx: Ctx, projectId: string, sprintRowId: string): Promise<void> {
  await requireProjectPermission(ctx.db, ctx.user, projectId, "MANAGE_SPRINTS");
  if ((await countProjectSprints(ctx, projectId)) <= 1) {
    throw new ApiError(400, "A project must always have at least one sprint");
  }
  const deleted = await ctx.db
    .delete(sprints)
    .where(and(eq(sprints.id, sprintRowId), eq(sprints.projectId, projectId)))
    .returning({ id: sprints.id });
  if (deleted.length === 0) throw new ApiError(404, "Sprint not found");
}
