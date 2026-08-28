import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { AppDB } from "../db/client";
import { projects, tasks, user, sprints } from "../db/schema";
import { listAccessibleProjects, type SessionUser } from "./rbac";

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Bounded Levenshtein distance; 99 is a "way too far" sentinel so callers can
// filter with a small threshold without collisions.
function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return 99;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let best = i;
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return 99;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function bestTokenDistance(query: string, text: string): number {
  let best = Infinity;
  for (const token of text.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    if (token.startsWith(query)) return 0;
    const allowed = token.length >= 5 ? 2 : 1;
    const d = levenshtein(query, token, allowed);
    if (d < best) best = d;
  }
  return best;
}

interface TicketHit {
  id: string;
  ticketId: string;
  title: string;
  status: string;
  projectId: string;
  projectPrefix: string;
}

export async function searchAll(db: AppDB, u: SessionUser, rawQuery: string) {
  const q = rawQuery.trim();
  const qlc = q.toLowerCase();
  const qNorm = normalizeQuery(q);
  const empty = { tickets: [], projects: [], users: [], sprints: [], suggested: false };
  if (qNorm.length === 0) return empty;
  // Single-character queries: match ticket IDs and project prefixes only,
  // otherwise a lone letter would match half the database.
  const single = qNorm.length === 1;

  const accessible = await listAccessibleProjects(db, u);
  const ids = accessible.map((p) => p.id);

  const projectHits = accessible
    .filter((p) => single
      ? p.prefix.toLowerCase().includes(qlc)
      : p.name.toLowerCase().includes(qlc) || p.prefix.toLowerCase().includes(qlc))
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, prefix: p.prefix }));

  const normTicketId = sql`replace(lower(${tasks.ticketId}), '-', '')`;

  // Fast path: normalized ticket-ID match or plain word match in title/description
  let tickets: TicketHit[] = [];
  if (ids.length > 0) {
    tickets = await db
      .select({
        id: tasks.id,
        ticketId: tasks.ticketId,
        title: tasks.title,
        status: tasks.status,
        projectId: tasks.projectId,
        projectPrefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(
        inArray(tasks.projectId, ids),
        single
          ? like(normTicketId, `%${qNorm}%`)
          : or(
              like(normTicketId, `%${qNorm}%`),
              like(tasks.title, `%${q}%`),
              like(tasks.description, `%${q}%`)
            )
      ))
      .orderBy(asc(tasks.ticketId))
      .limit(8);
  }

  // Fuzzy fallback: rank the accessible pool by edit distance so typos and
  // glued queries ("pln2" -> PLN-2) still surface as suggestions.
  let suggested = false;
  if (!single && tickets.length === 0 && ids.length > 0) {
    const pool = await db
      .select({
        id: tasks.id,
        ticketId: tasks.ticketId,
        title: tasks.title,
        projectId: tasks.projectId,
        projectPrefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(inArray(tasks.projectId, ids))
      .limit(500);

    // Longer queries must be closer matches; short ones get more slack.
    const maxScore = qNorm.length >= 5 ? 1 : 2;
    const scored = pool
      .map((t) => {
        const tid = normalizeQuery(t.ticketId);
        let score = Infinity;
        if (qNorm.length >= 2 && tid.includes(qNorm)) score = 0;
        else score = Math.min(levenshtein(qNorm, tid, 2), bestTokenDistance(qNorm, t.title.toLowerCase()));
        return { t, score };
      })
      .filter((x) => x.score <= maxScore)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);

    if (scored.length > 0) {
      tickets = scored.map((x) => ({ ...x.t, status: "" }));
      suggested = true;
    }
  }

  const users = u.role === "USER" || single
    ? []
    : await db
        .select({ id: user.id, name: user.name, email: user.email, role: user.role })
        .from(user)
        .where(or(like(user.name, `%${q}%`), like(user.email, `%${q}%`)))
        .orderBy(asc(user.name))
        .limit(6);

  // Sprints: searchable by their human ID (PREFIX-S1) or display name, scoped
  // to projects the user may access. Single-character queries are skipped to
  // avoid flooding the dropdown with every "S"-prefixed ID.
  const sprintHits = !single && ids.length > 0
    ? await db
        .select({
          id: sprints.id,
          sprintId: sprints.sprintId,
          name: sprints.name,
          projectId: sprints.projectId,
          projectName: projects.name,
          projectPrefix: projects.prefix,
        })
        .from(sprints)
        .innerJoin(projects, eq(projects.id, sprints.projectId))
        .where(and(
          inArray(sprints.projectId, ids),
          or(like(sprints.sprintId, `%${q}%`), like(sprints.name, `%${q}%`))
        ))
        .orderBy(asc(sprints.sprintId))
        .limit(5)
    : [];

  return { tickets, projects: projectHits, users, sprints: sprintHits, suggested };
}
