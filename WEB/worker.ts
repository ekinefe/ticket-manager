import type { D1Database, R2Bucket, ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./src/app";
import { createD1Db } from "./src/db/d1";
import { createR2Storage } from "./src/lib/media";
import { runJob } from "./src/cron/scheduler";

// Raw bindings wrangler injects from wrangler.toml ([d1_databases] DB,
// [r2_buckets] BUCKET) plus runtime env vars / secrets.
interface WorkerEnv {
  DB: D1Database;
  BUCKET?: R2Bucket;
  APP_URL?: string;
  MAIL_FROM?: string;
  MAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  BETTER_AUTH_SECRET?: string;
  OSV_PACKAGES?: string;
  CRON_JOB?: string;
}

function buildEnv(raw: WorkerEnv): Env {
  if (!raw.DB) throw new Error("D1 binding `DB` is missing");
  if (!raw.BUCKET) throw new Error("R2 binding `BUCKET` is missing");
  return {
    DB: createD1Db(raw.DB),
    BUCKET: raw.BUCKET,
    STORAGE: createR2Storage(raw.BUCKET),
    APP_URL: raw.APP_URL ?? "http://localhost:8788",
    MAIL_FROM: raw.MAIL_FROM ?? "Ticket Manager <no-reply@tickets.local>",
    MAIL_TRANSPORT: (raw.MAIL_TRANSPORT as Env["MAIL_TRANSPORT"]) ?? "resend",
    RESEND_API_KEY: raw.RESEND_API_KEY,
    BETTER_AUTH_SECRET: raw.BETTER_AUTH_SECRET,
    OSV_PACKAGES: raw.OSV_PACKAGES,
  };
}

// Map cron triggers to the job they run. Any number of [triggers] entries can
// point here; each resolves to one of the runnable jobs.
function jobForCron(cron: string): string | null {
  switch (cron) {
    case "0 0 * * *":
      return "daily";
    case "0 22 * * 0":
      return "weekly";
    case "0 21 * * 0":
      return "security";
    default:
      return null;
  }
}

export default {
  async fetch(request: Request, rawEnv: WorkerEnv, ctx: ExecutionContext) {
    const env = buildEnv(rawEnv);
    return createApp(env).fetch(request, rawEnv as never, ctx);
  },

  async scheduled(event: ScheduledEvent, rawEnv: WorkerEnv, ctx: ExecutionContext) {
    const env = buildEnv(rawEnv);
    const job = rawEnv.CRON_JOB ?? jobForCron(event.cron);
    if (!job) return;
    try {
      await runJob(env, job);
    } catch (e) {
      console.error(`[cron:${job}] failed:`, e);
    }
  },
};
