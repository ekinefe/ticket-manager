import { eq, sql } from "drizzle-orm";
import { projects } from "../db/schema";
import type { AppDB } from "../db/client";
import { getDb } from "../db/client";
import { ApiError } from "./http";

export async function allocateTicketId(db: AppDB, projectId: string): Promise<string> {
  const [project] = await db
    .select({ id: projects.id, prefix: projects.prefix })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");

  const [row] = await db
    .update(projects)
    .set({ currentTicketSequence: sql`${projects.currentTicketSequence} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ seq: projects.currentTicketSequence });

  return `${project.prefix}-${row.seq}`;
}
