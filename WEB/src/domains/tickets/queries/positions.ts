import { and, asc, eq, ne } from "drizzle-orm";
import { tasks } from "../../../db/schema";
import type { Status } from "../status";
import type { Ctx } from "../../access/index";

export async function computePosition(ctx: Pick<Ctx, "db">, projectId: string, status: Status, beforeTaskId: string | undefined, movedTaskId: string): Promise<number> {
  const siblings = await ctx.db
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status), ne(tasks.id, movedTaskId)))
    .orderBy(asc(tasks.position));

  if (siblings.length === 0) return 1;
  if (!beforeTaskId) return siblings[siblings.length - 1].position + 1;
  const idx = siblings.findIndex((s) => s.id === beforeTaskId);
  if (idx === -1) return siblings[siblings.length - 1].position + 1;
  if (idx === 0) return siblings[0].position - 1;
  return (siblings[idx - 1].position + siblings[idx].position) / 2;
}
