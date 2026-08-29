# Cloudflare Migration Plan

Ticket Manager → Cloudflare Workers + D1

Status: **PLAN — no code changes done yet.**
Date: 2026-08-28

## 1. Why this is easier than it seems

The current stack was already built on the exact frameworks Cloudflare
supports natively:

| Current | Cloudflare equivalent | Effort |
| --- | --- | --- |
| Hono (`@hono/node-server`) | Hono on Workers | Near-zero (drop `node-server`, use Worker handler) |
| Drizzle ORM | Drizzle + `drizzle-orm/d1` | Small (swap adapter) |
| SQLite + SQL migrations | **D1** (also SQLite) | Small (migrations carry over verbatim) |
| better-auth (drizzle sqlite adapter) | better-auth on Workers | Small (same adapter, new runtime) |

The **frontend is the only large effort** (4.2k lines vanilla JS), and we are
**not** doing that now. We keep the current UI as static assets and migrate to
Vite + React + TS later, independently.

## 2. Recommended architecture

```
Browser (vanilla JS, static assets)
        │
        ▼
Cloudflare Worker  (the existing Hono app)
        │
        ├── D1  → SQLite database (current schema + SQL migrations)
        ├── R2  → file uploads (attachments), replaces local `uploads/`
        ├── Resend → transactional e-mail (already used)
        └── Cron Triggers → daily digest / weekly report / security scan
```

- **Compute:** Cloudflare **Workers** (not Pages). You already have a standalone
  Hono app; Pages adds a routing/Functions layer on top of Workers for no
  benefit here. Workers keeps `server/main.ts` structure.
- **DB:** D1 database. Same SQLite dialect, so the existing
  `WEB/migrations/0001..0009_*.sql` files apply to D1 with no edits.
- **Files:** R2 bucket for attachments (Workers has no persistent local
  filesystem). Local `WEB/data/uploads` → R2.
- **Email:** Resend transport only. The local `file` transport (writes to a
  `.mail-out/` folder) cannot run on Workers — remove or gate it from prod.
- **Scheduling:** Workers Cron Triggers replace the in-process `setInterval`
  scheduler (`WEB/src/cron/scheduler.ts`).

## 3. Optionally-kept pieces

- Vanilla JS frontend stays unchanged, served as **static assets** bound to the
  Worker. No framework rewrite now.
- The `.mail-out/` *folder transport* is kept for local dev only.

## 4. What has to change (the real work)

### 4.1 Database layer: `better-sqlite3` → D1
- `WEB/src/db/local.ts`: delete (node:fs + better-sqlite3). Replace with a
  Drizzle **D1** client:
  ```ts
  // src/db/d1.ts
  import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
  import * as schema from "./schema";
  export type AppDB = DrizzleD1Database<typeof schema> & { $client: D1Database };
  export const createD1Db = (d1: D1Database): AppDB => drizzle(d1, { schema });
  ```
- `WEB/src/db/client.ts`: keep `getDb()` helper, re-export type from `d1.ts`.
- **Migrations:** run on deploy. Options: (a) a small bootstrap script that
  executes the SQL files on first connect (like `migrate()` in `local.ts` but
  reading from built-in assets), or (b) pre-apply via `wrangler d1 execute
  --file WEB/migrations/0001_init.sql ...` (repeat for each). Recommend (b) for
  deterministic deploys, plus a `_migrations` table for repeatability.

### 4.2 Runtime entry: `server/main.ts`
- `@hono/node-server` `serve()` → export the Hono app as the Worker default:
  ```ts
  export default { fetch: app.fetch };
  ```
- `APP_URL`, `BETTER_AUTH_SECRET`, etc. come from Worker `env` bindings
  (runtime secrets via `wrangler secret put`), not `process.env`.
- Static files: replace `@hono/node-server/serve-static` with the Worker
  **static assets** binding (or `@hono/cloudflare-workers`/`@hono/node-server`
  swap). Simplest: let Cloudflare serve `client/` automatically via assets, and
  keep Hono for `/api/*` routes.

### 4.3 Uploads → R2
- `WEB/scripts/media-gc.ts` + upload handling: swap local filesystem for R2
  (`env.BUCKET.put()`, `.get()`, `.delete()`).
- Keep the 100 MB limit but note Workers request body limits — consider
  lowering or using direct-to-R2 signed uploads if needed.

### 4.4 Mail
- `WEB/src/lib/mail/index.ts`: keep `resend` transport. Remove the `file`
  branch or make it local-dev-only (guarded so `writeFileSync(node:fs)` is not
  imported in the Worker bundle).
- `WEB/src/lib/mail/resend.ts`: already HTTP-based → works on Workers.

### 4.5 Cron
- `WEB/src/cron/scheduler.ts` `setInterval` loop → remove from Worker.
- Define `[triggers]` in `wrangler.toml` (e.g. daily 00:00) calling a route or a
  cron handler that invokes `runJob(env, "daily")`, `"weekly"`, `"security"`
  with a secret-guarded endpoint.

### 4.6 bindings / config
```toml
# wrangler.toml
name = "ticket-manager"
main = "server/worker.ts"            # Worker entry
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "ticket-manager"
database_id = "<id>"                # from: wrangler d1 create

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "ticket-manager-uploads"

[assets]
directory = "client"                # serve current vanilla-JS frontend
```

## 5. Prerequisites / account steps (you must do these — auth required)

1. `wrangler login` (interactive) **or** set `CLOUDFLARE_API_TOKEN`.
2. `npx wrangler d1 create ticket-manager` → note the returned `database_id`.
3. `npx wrangler r2 bucket create ticket-manager-uploads`.
4. `npx wrangler secret put` → `BETTER_AUTH_SECRET`, `RESEND_API_KEY`.
5. Apply existing schema: `npx wrangler d1 execute ticket-manager --file migrations/0001_init.sql` … for each migration.

## 6. Rollout order (lowest risk first)

1. **Refactor DB layer** to D1 + Drizzle adapter (back-end only, no feature change).
2. **Move uploads to R2**, update `media-gc`.
3. **Convert `server/main.ts`** to Worker entry; serve static assets; wire Resend.
4. **Move cron to Triggers**; remove `setInterval`.
5. **Deploy to a Workers preview/env**, run migrations, verify with the existing
   test suite (adapt tests to D1 tests / Miniflare).
6. **Cut over** — point `APP_URL` to the Worker, deploy.

## 7. Later (separate project, do NOT bundle into this migration)

- Rewrite `WEB/client/*` (4.2k lines vanilla JS) into **Vite + React + TS**.
  It consumes the same Hono `/api` routes, so the backend needs no rework.
- Add a build step that produces static assets from `vite build` into the
  Worker's `[assets]` directory.

## 8. Risks / notes

- **`better-sqlite3` is a native module** — it will fail to bind on Workers.
  This is the only hard dependency change.
- **Local vs prod divergence:** keep `local.ts` for local dev (SQLite file);
  use `d1.ts` under Workers. Abstract behind the shared `AppDB` type so the
  rest of the code is unchanged.
- **D1 limits:** per-request SQLite; fine for an internal tool. Consider batch
  for bulk writes where relevant.
- **Test suite:** current tests use a local SQLite file (`tests/api.test.ts`).
  For CI against D1, run them under **Miniflare** with a D1 binding.
- **DO NOT** change `main` (docs-only). All migration work happens on `dev`.

## 9. Effort estimate

- Core backend migration (D1, R2, mail, cron, Worker entry): **a few focused
  sessions**, no frontend changes.
- Full Vite + React + TS frontend rewrite (later): **substantially larger**
  (multi-week), independent of this plan.

## 10. Progress (updated 2026-08-29)

### Live deployment

- **Production:** `https://ticket-manager.gnrdigital.workers.dev`
  (Worker `ticket-manager`, D1 `ticket-manager-prod`, cron daily/weekly/security)
- **Preview:** `https://ticket-manager-pre.gnrdigital.workers.dev`
  (Worker `ticket-manager-pre`, D1 `ticket-manager-preview`, no cron)
- Both use the **`gnrdigital`** account workers.dev subdomain (changed from
  `ekinefegnr`). Old workers `ticket-manager-production` / `ticket-manager-preview`
  were deleted after the rename.
- **R2 attachments disabled** for v1 (uploads return 503 until storage is
  provisioned) — no metered/billed storage.
- **First-run setup:** `/setup` bootstraps the initial SUPER_ADMIN; admin panel
  at `/admin` handles roles/memberships.

The backend migration to a Cloudflare-ready layout is **DONE on the `dev` /
`production` branches**:

- Single Hono app factory (`WEB/src/app.ts`) — the routes live here once.
- `server/main.ts` slimmed to a local Node bootstrap (`npm run dev`/`test`).
- D1 Drizzle adapter (`WEB/src/db/d1.ts`); local better-sqlite3 still works.
- R2 <-> filesystem media abstraction wired to `env.STORAGE`.
- Worker entry (`WEB/worker.ts`): fetch + scheduled handlers, cron routing.
- `wrangler.toml` with separate `[env.preview]` and `[env.production]`
  environments, each own D1 + R2 (non-inheritable bindings) + static assets.
- Verified: `tsc --noEmit` clean, 70/70 tests pass, `wrangler deploy --dry-run`
  clean for both envs. `nodejs_compat` enabled for better-auth.

Branch layout for deploys:
- `production` (app code)  -> Cloudflare PRODUCTION Worker
- `dev`          (app code)  -> Cloudflare PREVIEW Worker
- `main`          (docs only) -> untouched / not deployed

### Remaining — human/account steps (require `wrangler login`)

1. Create preview D1 + R2; paste ids into `env.preview`:
   - `npx wrangler d1 create ticket-manager-preview`
   - `npx wrangler r2 bucket create ticket-manager-uploads-preview`
2. Create prod D1 + R2; paste ids into `env.production`:
   - `npx wrangler d1 create ticket-manager-prod`
   - `npx wrangler r2 bucket create ticket-manager-uploads-prod`
3. Secrets (per env):
   - `npx wrangler secret put BETTER_AUTH_SECRET --env preview`
   - `npx wrangler secret put BETTER_AUTH_SECRET --env production`
   - `npx wrangler secret put RESEND_API_KEY --env preview`
   - `npx wrangler secret put RESEND_API_KEY --env production`
4. Apply the 9 migrations to BOTH D1 databases:
   - `npx wrangler d1 execute ticket-manager-preview --file migrations/0001_init.sql`
   - (repeat for 0002..0009, then same for `ticket-manager-prod`)
5. Connect GitHub in the dashboard to BOTH environment Workers
   (`ticket-manager` = production, `ticket-manager-pre` = preview); set branch
   controls and deploy commands with `--env production` / `--env preview` (see
   the Workers Builds "Advanced Setups" docs).
6. Deploy: `npx wrangler deploy --env preview` and
   `npx wrangler deploy --env production`.

Root directory: when connecting the repo, use root directory `WEB/` so wrangler
runs from the folder that owns `wrangler.toml` / `worker.ts` / `migrations/`.
