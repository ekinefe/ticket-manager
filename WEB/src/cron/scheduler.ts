import { runDailyDigest } from "./jobs/daily-digest";
import { runWeeklyReport } from "./jobs/weekly-report";
import { runSecurityScan } from "./jobs/security-scan";
import { runAdminSummary } from "./jobs/admin-summary";
import { trTime } from "./guard";

// The system-wide Super-Admin summary piggy-backs on the existing daily/
// weekly triggers rather than adding its own — the Workers Free plan caps
// cron triggers at 5 per account, and daily/weekly/security already use 3.
// Monthly rides the daily trigger too, firing only on the 1st of the month.
async function runDaily(env: Env, dateKey: string): Promise<void> {
  await runDailyDigest(env, dateKey);
  await runAdminSummary(env, "daily", dateKey);
  if (dateKey.endsWith("-01")) await runAdminSummary(env, "monthly", dateKey);
}

async function runWeekly(env: Env, dateKey: string): Promise<void> {
  await runWeeklyReport(env, dateKey);
  await runAdminSummary(env, "weekly", dateKey);
}

export async function runJob(env: Env, job: string): Promise<void> {
  const t = trTime(new Date());
  if (job === "daily") return runDaily(env, t.dateKey);
  if (job === "weekly") return runWeekly(env, t.dateKey);
  if (job === "security") return runSecurityScan(env, t.dateKey);
  throw new Error(`Unknown job: ${job}`);
}

export function startScheduler(env: Env): void {
  const tick = async () => {
    const t = trTime(new Date());
    try {
      if (t.hour === 0) await runDaily(env, t.dateKey);
      if (t.hour === 22 && t.weekday === "Sun") await runWeekly(env, t.dateKey);
      if (t.hour === 21 && t.weekday === "Sun") await runSecurityScan(env, t.dateKey);
    } catch (e) {
      console.error("scheduler error:", e);
    }
  };
  setInterval(tick, 60_000);
}
