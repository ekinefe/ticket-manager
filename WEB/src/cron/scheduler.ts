import { runDailyDigest } from "./jobs/daily-digest";
import { runWeeklyReport } from "./jobs/weekly-report";
import { runSecurityScan } from "./jobs/security-scan";
import { trTime } from "./guard";

export async function runJob(env: Env, job: string): Promise<void> {
  const t = trTime(new Date());
  if (job === "daily") return runDailyDigest(env, t.dateKey);
  if (job === "weekly") return runWeeklyReport(env, t.dateKey);
  if (job === "security") return runSecurityScan(env, t.dateKey);
  throw new Error(`Unknown job: ${job}`);
}

export function startScheduler(env: Env): void {
  const tick = async () => {
    const t = trTime(new Date());
    try {
      if (t.hour === 0) await runDailyDigest(env, t.dateKey);
      if (t.hour === 22 && t.weekday === "Sun") await runWeeklyReport(env, t.dateKey);
      if (t.hour === 21 && t.weekday === "Sun") await runSecurityScan(env, t.dateKey);
    } catch (e) {
      console.error("scheduler error:", e);
    }
  };
  setInterval(tick, 60_000);
}
