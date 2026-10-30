// Report aggregation: performance, throughput and completion forecasts.
// Pure functions (no DB access) so they can be unit-tested.

export type Granularity = "daily" | "weekly" | "monthly";

export interface ReportTask {
  id: string;
  ticketId: string;
  title: string;
  status: string;
  assigneeId: string | null;
  projectPrefix: string;
  createdAt: number;
  updatedAt: number;
  dueDate: string | null;
}

export interface ReportInput {
  tasks: ReportTask[];
  /** taskId -> timestamp of the latest move into DONE */
  doneAt: Map<string, number>;
  userNames: Map<string, string>;
  granularity: Granularity;
  periods?: number;
  now?: number;
}

const DAY = 86_400_000;
const DEFAULT_PERIODS: Record<Granularity, number> = { daily: 30, weekly: 12, monthly: 12 };
const IN_PROGRESS = new Set(["IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST"]);

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Start (UTC midnight, ms) of the bucket containing `ms`. Weeks start on Monday. */
export function bucketStart(ms: number, g: Granularity): number {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (g === "daily") return day;
  if (g === "weekly") return day - ((d.getUTCDay() + 6) % 7) * DAY;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextBucket(start: number, g: Granularity): number {
  if (g === "daily") return start + DAY;
  if (g === "weekly") return start + 7 * DAY;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface Scenario {
  /** tickets completed per period */
  velocity: number;
  /** periods until everything open is done (null = never at this pace) */
  periodsNeeded: number | null;
  finishDate: string | null;
  /** cumulative completed at each future period start */
  points: number[];
}

export interface Forecast {
  remaining: number;
  horizon: number;
  futureLabels: string[];
  optimistic: Scenario;
  realistic: Scenario;
  pessimistic: Scenario;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Three scenarios from recent throughput (assumes scope stays as it is):
 *  - realistic: average of the recent periods
 *  - optimistic: average of the best half
 *  - pessimistic: average of the worst half
 */
export function buildForecast(
  recentCompleted: number[], cumCompletedNow: number, scope: number,
  lastStart: number, g: Granularity, maxHorizon = 12
): Forecast {
  const remaining = Math.max(0, scope - cumCompletedNow);
  const sorted = [...recentCompleted].sort((a, b) => a - b);
  const half = Math.max(1, Math.ceil(sorted.length / 2));
  const velocities = {
    pessimistic: mean(sorted.slice(0, half)),
    realistic: mean(sorted),
    optimistic: mean(sorted.slice(sorted.length - half)),
  };
  const needed = (v: number) => (remaining === 0 ? 0 : v > 0 ? Math.ceil(remaining / v) : null);
  const periodStarts = (n: number) => {
    const out: number[] = [];
    let s = lastStart;
    for (let i = 0; i < n; i++) { s = nextBucket(s, g); out.push(s); }
    return out;
  };
  const nObs = [velocities.optimistic, velocities.realistic, velocities.pessimistic].map(needed);
  const finite = nObs.filter((n): n is number => n !== null);
  const horizon = Math.min(maxHorizon, Math.max(1, ...finite));
  const starts = periodStarts(horizon);
  const make = (v: number): Scenario => {
    const n = needed(v);
    const finishStarts = n !== null && n > 0 ? periodStarts(n) : [];
    return {
      velocity: Math.round(v * 100) / 100,
      periodsNeeded: n,
      finishDate: n === 0 ? isoDay(lastStart) : n !== null ? isoDay(finishStarts[n - 1]) : null,
      points: starts.map((_, i) => Math.min(scope, Math.round((cumCompletedNow + v * (i + 1)) * 10) / 10)),
    };
  };
  return {
    remaining,
    horizon,
    futureLabels: starts.map(isoDay),
    optimistic: make(velocities.optimistic),
    realistic: make(velocities.realistic),
    pessimistic: make(velocities.pessimistic),
  };
}

export function buildReport(input: ReportInput) {
  const { tasks, doneAt, userNames, granularity: g } = input;
  const now = input.now ?? Date.now();
  const periods = input.periods ?? DEFAULT_PERIODS[g];

  const completedAt = (t: ReportTask): number | null =>
    t.status === "DONE" ? (doneAt.get(t.id) ?? t.updatedAt) : null;

  // History buckets: `periods` buckets ending with the current one.
  const currentStart = bucketStart(now, g);
  const starts: number[] = [currentStart];
  for (let i = 1; i < periods; i++) {
    const prev = starts[0];
    starts.unshift(g === "daily" ? prev - DAY : g === "weekly" ? prev - 7 * DAY
      : Date.UTC(new Date(prev).getUTCFullYear(), new Date(prev).getUTCMonth() - 1, 1));
  }
  const idx = (ms: number) => {
    const s = bucketStart(ms, g);
    return starts.indexOf(s);
  };

  const created = new Array(periods).fill(0);
  const completed = new Array(periods).fill(0);
  let createdBefore = 0;
  let completedBefore = 0;
  for (const t of tasks) {
    if (t.createdAt < starts[0]) createdBefore++; else { const i = idx(t.createdAt); if (i >= 0) created[i]++; }
    const c = completedAt(t);
    if (c !== null) {
      if (c < starts[0]) completedBefore++; else { const i = idx(c); if (i >= 0) completed[i]++; }
    }
  }
  let cc = createdBefore, cd = completedBefore;
  const series = starts.map((s, i) => {
    cc += created[i]; cd += completed[i];
    return { start: isoDay(s), created: created[i], completed: completed[i], cumCreated: cc, cumCompleted: cd };
  });

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "DONE").length;
  const today = isoDay(now);
  const overdue = tasks.filter((t) => t.status !== "DONE" && t.dueDate && t.dueDate < today).length;
  const cycleDays = (t: ReportTask) => {
    const c = completedAt(t);
    return c === null ? null : Math.max(0, (c - t.createdAt) / DAY);
  };
  const cycles = tasks.map(cycleDays).filter((x): x is number => x !== null);
  const round1 = (x: number) => Math.round(x * 10) / 10;

  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  // Per-assignee performance
  const people = new Map<string, { name: string; assigned: number; completed: number; overdue: number; cycles: number[] }>();
  for (const t of tasks) {
    const key = t.assigneeId ?? "";
    const p = people.get(key) ?? { name: key ? (userNames.get(key) ?? "?") : "", assigned: 0, completed: 0, overdue: 0, cycles: [] };
    p.assigned++;
    if (t.status === "DONE") { p.completed++; const c = cycleDays(t); if (c !== null) p.cycles.push(c); }
    else if (t.dueDate && t.dueDate < today) p.overdue++;
    people.set(key, p);
  }
  const assignees = [...people.entries()].map(([id, p]) => ({
    userId: id || null, name: p.name, assigned: p.assigned, completed: p.completed,
    open: p.assigned - p.completed, overdue: p.overdue,
    avgCycleDays: p.cycles.length ? round1(mean(p.cycles)) : null,
  })).sort((a, b) => b.completed - a.completed || b.assigned - a.assigned);

  const completedList = tasks
    .map((t) => ({ t, c: completedAt(t) }))
    .filter((x): x is { t: ReportTask; c: number } => x.c !== null)
    .sort((a, b) => b.c - a.c)
    .slice(0, 15)
    .map(({ t, c }) => ({
      ticketId: t.ticketId, title: t.title, project: t.projectPrefix,
      assignee: t.assigneeId ? (userNames.get(t.assigneeId) ?? "?") : null,
      completedAt: c, cycleDays: round1(cycleDays(t) ?? 0),
    }));

  // Forecast from the last full periods (the current one is still in progress).
  const full = series.length > 2 ? series.slice(0, -1) : series;
  const recent = full.slice(-6).map((s) => s.completed);
  const last = series[series.length - 1];
  const forecast = buildForecast(recent, last.cumCompleted, last.cumCreated, currentStart, g);

  return {
    granularity: g,
    kpis: {
      total, done, open: total - done,
      inProgress: tasks.filter((t) => IN_PROGRESS.has(t.status)).length,
      overdue,
      completionRate: total ? Math.round((done / total) * 100) : 0,
      avgCycleDays: cycles.length ? round1(mean(cycles)) : null,
      throughput: forecast.realistic.velocity,
    },
    series, byStatus, assignees, completedList, forecast,
  };
}
