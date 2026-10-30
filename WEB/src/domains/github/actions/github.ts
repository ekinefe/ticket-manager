import { and, eq, or, sql, inArray, desc } from "drizzle-orm";
import { githubEvents, githubEventTasks, projects, tasks, user } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { assertTaskVisible } from "../../tickets/index";
import { getProjectAccess, requireProjectRole, listAccessibleProjects } from "../../access/index";
import type { Ctx, PublicCtx } from "../../access/index";
import type { Input } from "../../../shared/route";
import { REPO_RE, createBranch, fetchCommitGraph, extractTicketIds, githubConfigured, handleGithubEvent, ticketBranchName, verifyWebhookSignature } from "../github";

// GitHub App integration: one private repo per project; webhook is HMAC-verified.
export async function receiveWebhook(ctx: PublicCtx, input: Input) {
  const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, "GitHub webhook secret is not configured");
  const raw = await input.text();
  if (!(await verifyWebhookSignature(secret, raw, input.header("x-hub-signature-256")))) {
    throw new ApiError(401, "Invalid signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  const result = await handleGithubEvent(ctx.env, input.header("x-github-event") || "", payload);
  return { ok: true, ...result };
}

export async function setProjectRepo(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId, "ADMIN");
  const body = await input.body<{ repo?: string | null }>();
  const raw = (body.repo ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (raw && !REPO_RE.test(raw)) throw new ApiError(400, 'Repository must look like "owner/name"');
  const repo = raw ? raw.toLowerCase() : null;
  if (repo) {
    const [taken] = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.githubRepo, repo), sql`${projects.id} != ${projectId}`));
    if (taken) throw new ApiError(409, "That repository is already linked to another project");
  }
  await ctx.db.update(projects).set({ githubRepo: repo }).where(eq(projects.id, projectId));
  return { repo };
}

export async function getTaskGithub(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);
  const [task] = await ctx.db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy, ticketId: tasks.ticketId, type: tasks.type })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");
  assertTaskVisible(access, u, task);
  const [project] = await ctx.db.select({ githubRepo: projects.githubRepo }).from(projects).where(eq(projects.id, projectId));

  const events = await ctx.db
    .select({
      kind: githubEvents.kind, ref: githubEvents.ref, title: githubEvents.title, url: githubEvents.url,
      author: githubEvents.author, state: githubEvents.state, branch: githubEvents.branch, updatedAt: githubEvents.updatedAt,
    })
    .from(githubEventTasks)
    .innerJoin(githubEvents, eq(githubEvents.id, githubEventTasks.eventId))
    .where(eq(githubEventTasks.taskId, taskId))
    .orderBy(desc(githubEvents.updatedAt))
    .limit(50);

  const canBranch = access.role === "ADMIN" || task.assigneeId === u.id || task.createdBy === u.id;
  return {
    repo: project?.githubRepo ?? null,
    events,
    branchEnabled: !!ctx.env.GITHUB_BRANCH_CREATE && githubConfigured(ctx.env) && !!project?.githubRepo && canBranch,
    branchName: ticketBranchName(task),
  };
}

export async function createTaskBranch(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const taskId = input.p.taskId;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);
  if (!ctx.env.GITHUB_BRANCH_CREATE) throw new ApiError(403, "Branch creation is turned off by the administrator");
  if (!githubConfigured(ctx.env)) throw new ApiError(400, "GitHub App is not configured");
  const [task] = await ctx.db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy, ticketId: tasks.ticketId, type: tasks.type })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new ApiError(404, "Task not found");
  assertTaskVisible(access, u, task);
  if (!(access.role === "ADMIN" || task.assigneeId === u.id || task.createdBy === u.id)) {
    throw new ApiError(403, "Only the assignee, the creator or a project admin can create the branch");
  }
  const [project] = await ctx.db.select({ githubRepo: projects.githubRepo }).from(projects).where(eq(projects.id, projectId));
  if (!project?.githubRepo) throw new ApiError(400, "This project has no GitHub repository linked");
  const branch = ticketBranchName(task);
  const result = await createBranch(ctx.env, project.githubRepo, branch);
  return { branch, ...result };
}

// Commit tree of the project's repo (read live from GitHub through the App).
export async function projectGraph(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  const access = await getProjectAccess(ctx.db, u, projectId);
  if (!access.can("VIEW_ALL_TICKETS")) throw new ApiError(403, "Missing permission: VIEW_ALL_TICKETS");
  if (!githubConfigured(ctx.env)) throw new ApiError(400, "GitHub App is not configured");
  const [project] = await ctx.db
    .select({ githubRepo: projects.githubRepo, prefix: projects.prefix })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project?.githubRepo) throw new ApiError(400, "This project has no GitHub repository linked");
  const graph = await fetchCommitGraph(ctx.env, project.githubRepo);
  return {
    repo: project.githubRepo,
    branches: graph.branches,
    commits: graph.commits.map((cm) => ({ ...cm, tickets: extractTicketIds(project.prefix, cm.message) })),
    pulls: graph.pulls.map((pl) => ({ ...pl, tickets: extractTicketIds(project.prefix, pl.title, pl.head) })),
  };
}

// Recent repo activity for the dashboard, limited to projects the viewer belongs to.
export async function githubActivity(ctx: Ctx, _input: Input) {
  const u = ctx.user;
  const accessible = await listAccessibleProjects(ctx.db, u);
  const ids = accessible.filter((p) => p.githubRepo).map((p) => p.id);
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({
      kind: githubEvents.kind, ref: githubEvents.ref, title: githubEvents.title, url: githubEvents.url,
      author: githubEvents.author, state: githubEvents.state, branch: githubEvents.branch, updatedAt: githubEvents.updatedAt,
      projectName: projects.name, projectPrefix: projects.prefix,
    })
    .from(githubEvents)
    .innerJoin(projects, eq(projects.id, githubEvents.projectId))
    .where(inArray(githubEvents.projectId, ids))
    .orderBy(desc(githubEvents.updatedAt))
    .limit(15);
  return rows;
}
