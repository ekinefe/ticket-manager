import { asc, eq, sql } from "drizzle-orm";
import { sprints, tasks } from "../../../db/schema";
import type { Ctx } from "../../access/index";

export async function listProjectSprints(ctx: Pick<Ctx, "db">, projectId: string) {
  return ctx.db
    .select({
      id: sprints.id,
      sprintId: sprints.sprintId,
      name: sprints.name,
      createdAt: sprints.createdAt,
      ticketCount: sql<number>`(select count(*) from ${tasks} where ${tasks.sprintId} = ${sprints.id})`,
    })
    .from(sprints)
    .where(eq(sprints.projectId, projectId))
    .orderBy(asc(sprints.createdAt));
}

// Next human-visible sprint ID for a project: PREFIX-S<max+1>. Parses existing
// IDs rather than trusting a stored counter so manual/out-of-band IDs stay safe.
export async function nextSprintId(ctx: Pick<Ctx, "db">, projectId: string, prefix: string): Promise<string> {
  const rows = await ctx.db
    .select({ sprintId: sprints.sprintId })
    .from(sprints)
    .where(eq(sprints.projectId, projectId));
  let max = 0;
  for (const r of rows) {
    const m = /-S(\d+)$/.exec(r.sprintId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-S${max + 1}`;
}

export async function countProjectSprints(ctx: Pick<Ctx, "db">, projectId: string): Promise<number> {
  const [{ total }] = await ctx.db
    .select({ total: sql<number>`count(*)` })
    .from(sprints)
    .where(eq(sprints.projectId, projectId));
  return total;
}
