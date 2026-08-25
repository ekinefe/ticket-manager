import { jobRuns } from "../db/schema";

export async function runOnce(env: Env, jobName: string, periodKey: string): Promise<boolean> {
  const res = await env.DB.insert(jobRuns)
    .values({ jobName, periodKey, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function weekBounds(dateKey: string): { start: number; end: number } {
  const end = Date.parse(`${dateKey}T23:59:59.999Z`) + 1;
  const start = end - 7 * 86_400_000;
  return { start, end };
}

export interface TrTime {
  hour: number;
  weekday: string;
  dateKey: string;
}

export function trTime(now: Date): TrTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    hour: Number(get("hour")),
    weekday: get("weekday"),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}
