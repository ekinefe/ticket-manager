import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createLocalDb, PROJECT_ROOT, DATA_DIR } from "../src/db/local";
import { createApp, loadSettings } from "../src/app";
import { createFsStorage } from "../src/lib/media-fs";
import { createFileTransport } from "../src/lib/mail/file";
import { registerFileTransport } from "../src/lib/mail";
import { startScheduler } from "../src/cron/scheduler";

// Register the node:fs-backed ".mail-out" transport for local dev. This import
// must only ever live in a Node entry (never in worker.ts) so node:fs /
// better-sqlite3 stay out of the Worker bundle.
registerFileTransport(createFileTransport);

// ---------------------------------------------------------------------------
// Local development bootstrap.
//
// This is the ONLY place that depends on Node/runtime-specific behavior
// (better-sqlite3, filesystem media, @hono/node-server, setInterval cron).
// It builds a local `env` and hands it to the shared `createApp(env)` factory
// from src/app.ts, then adds static-asset serving on top for local dev.
// The Cloudflare Worker uses WEB/worker.ts instead — this file is for `npm run
// dev`, `npm run start`, and the test suite.
// ---------------------------------------------------------------------------

export const env: Env = {
  DB: createLocalDb(process.env.TM_DB_FILE || undefined),
  STORAGE: createFsStorage(join(DATA_DIR, "uploads")),
  APP_URL: process.env.APP_URL ?? "http://localhost:8788",
  MAIL_FROM: process.env.MAIL_FROM ?? "Ticket Manager <no-reply@tickets.local>",
  MAIL_TRANSPORT: (process.env.MAIL_TRANSPORT as Env["MAIL_TRANSPORT"]) ?? "file",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-change-me",
  OSV_PACKAGES:
    process.env.OSV_PACKAGES ?? '["drizzle-orm@0.45.2","better-auth@1.7.1"]',
};

export const app = createApp(env);

// Pre-populate the runtime env from DB-backed settings (same as before).
await loadSettings(env);

// ---------- Static client assets (local dev only; Workers uses [assets]) ----------
async function serveHtml(c: import("hono").Context, file: string): Promise<Response> {
  try {
    const html = await readFile(file, "utf8");
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  } catch {
    return c.text("Frontend assets are missing.", 500);
  }
}

// Local dev: always revalidate client assets so JS/CSS edits show up on refresh.
const noCache = async (c: import("hono").Context, next: () => Promise<void>) => {
  await next();
  c.header("Cache-Control", "no-cache");
};
app.use("/js/*", noCache);
app.use("/css/*", noCache);

const CLIENT_INDEX = join(PROJECT_ROOT, "client", "index.html");

app.use("*", serveStatic({ root: "./client" }));
app.get("*", (c) => serveHtml(c, CLIENT_INDEX));

// Only boot the HTTP listener and the in-process scheduler when this file is
// the process entry point; tests import { app, env } without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({ fetch: app.fetch, port: 8788 }, (info) => {
    console.log(`Ticket Manager  ->  http://localhost:${info.port}`);
    console.log(`App:   http://localhost:${info.port}`);
    console.log(`Demo login: ekin@plannedlost.dev / admin123!`);
  });
  startScheduler(env);
}
