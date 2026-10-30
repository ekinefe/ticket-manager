import { user } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { requireSuperAdmin } from "../../access/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";
import { runJob } from "../../../cron/scheduler";

// Manual trigger for the scheduled jobs (super admin).
export async function runCronJob(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requireSuperAdmin(u);
  const job = input.p.job;
  if (!["daily", "weekly", "security"].includes(job)) throw new ApiError(404, "Unknown job");
  await runJob(ctx.env, job);
  return { ok: true, job };
}
