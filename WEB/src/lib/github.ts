import { and, eq, inArray } from "drizzle-orm";
import { githubEventTasks, githubEvents, projects, tasks } from "../db/schema";
import { getDb } from "../db/client";
import { logActivity } from "./activity";
import { notifyStatusChanged } from "./notify";
import { publish } from "./realtime";
import { INSTANT_NOTIFY_STATUSES, type Status } from "./status";
import { ApiError } from "./http";

// ---------- Pure helpers ----------

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Ticket ids ("PLN-12") of the given project prefix mentioned anywhere in the texts. */
export function extractTicketIds(prefix: string, ...texts: (string | null | undefined)[]): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${prefix.replace(/[^A-Za-z0-9]/g, "")}-(\\d+)(?!\\d)`, "gi");
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) found.add(`${prefix}-${m[1]}`);
  }
  return [...found];
}

/** Branch name used by the "create branch from ticket" button (matches the board's suggestion). */
export function ticketBranchName(t: { ticketId: string; type: string }): string {
  return `${t.type === "BUG" ? "hotfix" : "feature"}/${t.ticketId}`;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verifies GitHub's X-Hub-Signature-256 header (constant-time compare). */
export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined | null): Promise<boolean> {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------- Webhook event handling ----------

interface ProjectRef {
  id: string;
  prefix: string;
}

async function projectForRepo(env: Env, fullName: string | undefined): Promise<ProjectRef | null> {
  if (!fullName) return null;
  const [p] = await getDb(env.DB)
    .select({ id: projects.id, prefix: projects.prefix })
    .from(projects)
    .where(eq(projects.githubRepo, fullName.toLowerCase()));
  return p ?? null;
}

async function upsertEvent(
  env: Env,
  project: ProjectRef,
  ev: { kind: "COMMIT" | "PR"; ref: string; title: string; url?: string | null; author?: string | null; state?: string | null; branch?: string | null; at: number },
  ticketIds: string[]
): Promise<string[]> {
  const db = getDb(env.DB);
  const now = Date.now();
  const [existing] = await db
    .select({ id: githubEvents.id })
    .from(githubEvents)
    .where(and(eq(githubEvents.projectId, project.id), eq(githubEvents.kind, ev.kind), eq(githubEvents.ref, ev.ref)));
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db
      .update(githubEvents)
      .set({ title: ev.title, url: ev.url ?? null, author: ev.author ?? null, state: ev.state ?? null, branch: ev.branch ?? null, updatedAt: now })
      .where(eq(githubEvents.id, id));
  } else {
    await db.insert(githubEvents).values({
      id, projectId: project.id, kind: ev.kind, ref: ev.ref, title: ev.title, url: ev.url ?? null,
      author: ev.author ?? null, state: ev.state ?? null, branch: ev.branch ?? null, createdAt: ev.at, updatedAt: now,
    });
  }
  if (ticketIds.length === 0) return [];
  const found = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), inArray(tasks.ticketId, ticketIds)));
  for (const t of found) {
    await db.insert(githubEventTasks).values({ eventId: id, taskId: t.id }).onConflictDoNothing();
  }
  return found.map((t) => t.id);
}

/** Moves a ticket because of GitHub activity; only ever forwards, never overwrites a later status. */
async function autoMove(env: Env, taskId: string, to: Status, from: readonly Status[], who: string): Promise<void> {
  const db = getDb(env.DB);
  const [task] = await db
    .select({ projectId: tasks.projectId, ticketId: tasks.ticketId, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task || task.status === to || !(from as readonly string[]).includes(task.status)) return;
  await db.update(tasks).set({ status: to, updatedAt: Date.now() }).where(eq(tasks.id, taskId));
  await logActivity(env.DB, { taskId, actorId: null, eventType: "STATUS_CHANGED", oldStatus: task.status, newStatus: to });
  publish(task.projectId, { type: "status", ticketId: task.ticketId, taskId, actorId: "github" });
  if (INSTANT_NOTIFY_STATUSES.has(to)) {
    await notifyStatusChanged(env, {
      projectId: task.projectId, taskId, ticketId: task.ticketId, taskTitle: task.title,
      oldStatus: task.status as Status, newStatus: to, actorName: `${who} (GitHub)`,
    }).catch((e) => console.error("github notify failed:", e));
  }
}

const OPEN_FROM: readonly Status[] = ["TODO", "IN_PROGRESS"];
const MERGE_FROM: readonly Status[] = ["TODO", "IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST"];

export async function handleGithubEvent(env: Env, event: string, payload: any): Promise<{ handled: boolean; detail?: string }> {
  if (event === "ping") return { handled: true, detail: "pong" };

  const project = await projectForRepo(env, payload?.repository?.full_name);
  if (!project) return { handled: false, detail: "repository is not linked to a project" };

  if (event === "push") {
    if (payload.deleted || !Array.isArray(payload.commits)) return { handled: true, detail: "no commits" };
    const branch = String(payload.ref || "").replace(/^refs\/heads\//, "");
    const branchIds = extractTicketIds(project.prefix, branch);
    let linked = 0;
    for (const c of payload.commits.slice(0, 50)) {
      const message = String(c.message || "");
      const ids = [...new Set([...extractTicketIds(project.prefix, message), ...branchIds])];
      const hit = await upsertEvent(env, project, {
        kind: "COMMIT", ref: String(c.id), title: message.split("\n")[0].slice(0, 300), url: c.url,
        author: c.author?.name || c.author?.username || null, branch, at: Date.parse(c.timestamp) || Date.now(),
      }, ids);
      linked += hit.length;
    }
    return { handled: true, detail: `${payload.commits.length} commit(s), ${linked} ticket link(s)` };
  }

  if (event === "pull_request") {
    const pr = payload.pull_request;
    if (!pr) return { handled: false, detail: "no pull_request" };
    const merged = !!pr.merged;
    const state = merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
    const ids = extractTicketIds(project.prefix, pr.title, pr.body, pr.head?.ref);
    const who = pr.user?.login || "GitHub";
    const taskIds = await upsertEvent(env, project, {
      kind: "PR", ref: String(pr.number), title: String(pr.title || "").slice(0, 300), url: pr.html_url,
      author: pr.user?.login ?? null, state, branch: pr.head?.ref ?? null, at: Date.parse(pr.created_at) || Date.now(),
    }, ids);

    for (const taskId of taskIds) {
      if (state === "open") await autoMove(env, taskId, "UNDER_REVIEW", OPEN_FROM, who);
      else if (state === "merged") await autoMove(env, taskId, "DONE", MERGE_FROM, who);
    }
    return { handled: true, detail: `PR #${pr.number} ${state}, ${taskIds.length} ticket(s)` };
  }

  return { handled: false, detail: `event "${event}" ignored` };
}

// ---------- GitHub API (App authentication) ----------

function b64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function githubConfigured(env: Env): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

/** Short-lived App JWT (RS256). The private key must be PKCS#8 PEM ("BEGIN PRIVATE KEY"). */
async function appJwt(env: Env): Promise<string> {
  const pem = String(env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new ApiError(500, 'GitHub private key is PKCS#1. Convert it: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem');
  }
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  } catch {
    throw new ApiError(500, "GitHub private key is not valid PEM");
  }
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(env.GITHUB_APP_ID) }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "ticket-manager",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

async function installationToken(env: Env, repo: string): Promise<string> {
  const jwt = await appJwt(env);
  const inst = await gh(`/repos/${repo}/installation`, jwt);
  if (inst.status === 404) throw new ApiError(400, "The GitHub App is not installed on this repository");
  if (!inst.ok) throw new ApiError(502, `GitHub error (${inst.status}) while looking up the installation`);
  const { id } = (await inst.json()) as { id: number };
  const tok = await gh(`/app/installations/${id}/access_tokens`, jwt, { method: "POST" });
  if (!tok.ok) throw new ApiError(502, `GitHub error (${tok.status}) while creating an access token`);
  return ((await tok.json()) as { token: string }).token;
}

/** Creates `branch` from the repo's default branch. Returns the branch URL. Idempotent-ish: 422 → already exists. */
export async function createBranch(env: Env, repo: string, branch: string): Promise<{ url: string; created: boolean }> {
  const token = await installationToken(env, repo);
  const info = await gh(`/repos/${repo}`, token);
  if (!info.ok) throw new ApiError(502, `GitHub error (${info.status}) reading the repository`);
  const { default_branch } = (await info.json()) as { default_branch: string };
  const head = await gh(`/repos/${repo}/git/ref/heads/${default_branch}`, token);
  if (!head.ok) throw new ApiError(502, `GitHub error (${head.status}) reading ${default_branch}`);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const url = `https://github.com/${repo}/tree/${branch}`;
  const res = await gh(`/repos/${repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (res.status === 422) return { url, created: false };
  if (!res.ok) throw new ApiError(502, `GitHub error (${res.status}) creating the branch`);
  return { url, created: true };
}

// ---------- Commit graph (fetched live from GitHub, cached briefly) ----------

export interface GraphCommit {
  sha: string;
  parents: string[];
  message: string;
  author: string | null;
  date: number;
  url: string;
}
export interface CommitGraph {
  branches: { name: string; sha: string; isDefault: boolean }[];
  commits: GraphCommit[];
}

const MAX_BRANCHES = 8;
const COMMITS_PER_BRANCH = 40;
const GRAPH_TTL_MS = 60_000;
const graphCache = new Map<string, { at: number; data: CommitGraph }>();

export function clearGraphCache(): void {
  graphCache.clear();
}

/**
 * Recent history across the repo's branches (default branch first, max 8
 * branches x 40 commits, to stay well inside Workers' subrequest limit).
 * Author e-mails are never read.
 */
export async function fetchCommitGraph(env: Env, repo: string): Promise<CommitGraph> {
  const hit = graphCache.get(repo);
  if (hit && Date.now() - hit.at < GRAPH_TTL_MS) return hit.data;

  const token = await installationToken(env, repo);
  const info = await gh(`/repos/${repo}`, token);
  if (!info.ok) throw new ApiError(502, `GitHub error (${info.status}) reading the repository`);
  const defaultBranch = ((await info.json()) as { default_branch: string }).default_branch;

  const br = await gh(`/repos/${repo}/branches?per_page=30`, token);
  if (!br.ok) throw new ApiError(502, `GitHub error (${br.status}) listing branches`);
  const all = ((await br.json()) as { name: string; commit: { sha: string } }[]).map((b) => ({
    name: b.name, sha: b.commit.sha, isDefault: b.name === defaultBranch,
  }));
  all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const branches = all.slice(0, MAX_BRANCHES);

  const bySha = new Map<string, GraphCommit>();
  const lists = await Promise.all(
    branches.map(async (b) => {
      const r = await gh(`/repos/${repo}/commits?sha=${encodeURIComponent(b.name)}&per_page=${COMMITS_PER_BRANCH}`, token);
      return r.ok ? ((await r.json()) as any[]) : [];
    })
  );
  for (const list of lists) {
    for (const c of list) {
      if (bySha.has(c.sha)) continue;
      bySha.set(c.sha, {
        sha: c.sha,
        parents: (c.parents || []).map((p: { sha: string }) => p.sha),
        message: String(c.commit?.message || "").split("\n")[0].slice(0, 200),
        author: c.commit?.author?.name ?? c.author?.login ?? null,
        date: Date.parse(c.commit?.author?.date || c.commit?.committer?.date) || 0,
        url: c.html_url,
      });
    }
  }
  const commits = [...bySha.values()].sort((a, b) => b.date - a.date);
  const data = { branches, commits };
  graphCache.set(repo, { at: Date.now(), data });
  return data;
}
