import { and, eq } from "drizzle-orm";
import { accessAudit, projectMembers, projects, user } from "../../db/schema";
import type { Ctx } from "./ctx";

export type AccessAction = "ROLE_CHANGED" | "MEMBER_ADDED" | "MEMBER_ROLE_CHANGED" | "MEMBER_REMOVED" | "PERMISSIONS_CHANGED" | "ACCOUNT_DELETED";

// Best-effort: an audit failure must never block the access change itself.
export async function recordAccess(
  ctx: Ctx,
  e: { action: AccessAction; targetUserId: string; projectId?: string; detail?: Record<string, unknown> }
): Promise<void> {
  try {
    const [target] = await ctx.db.select({ name: user.name }).from(user).where(eq(user.id, e.targetUserId));
    const [proj] = e.projectId
      ? await ctx.db.select({ prefix: projects.prefix }).from(projects).where(eq(projects.id, e.projectId))
      : [];
    await ctx.db.insert(accessAudit).values({
      id: crypto.randomUUID(),
      actorId: ctx.user.id,
      actorName: ctx.user.name,
      action: e.action,
      targetUserId: e.targetUserId,
      targetName: target?.name ?? null,
      projectId: e.projectId ?? null,
      projectPrefix: proj?.prefix ?? null,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("access audit failed:", err);
  }
}

// Only log when the set actually changed (the admin UI re-sends it on every save).
export async function recordPermissionChange(ctx: Ctx, userId: string, projectId: string, before: string[], after: string[]): Promise<void> {
  const b = [...before].sort().join(",");
  const a = [...after].sort().join(",");
  if (a === b) return;
  await recordAccess(ctx, { action: "PERMISSIONS_CHANGED", targetUserId: userId, projectId, detail: { from: [...before].sort(), to: [...after].sort() } });
}

export async function currentMemberRole(ctx: Pick<Ctx, "db">, projectId: string, userId: string): Promise<string | null> {
  const [m] = await ctx.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return m?.role ?? null;
}
