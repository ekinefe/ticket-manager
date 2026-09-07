# Ticket Manager

Self-hosted, zero-cost Kanban work tracker for internal teams: projects,
unique ticket IDs (`PREFIX-1`), drag & drop boards, rich-text descriptions,
comments, attachments, invitation-only accounts, per-project roles, live
board updates (SSE), e-mail digests and a weekly dependency-security scan.

Full architecture and security documentation: [`DOC/main.tex`](DOC/main.tex)
(compiled PDF: `DOC/main.pdf`).

## Quickstart (development)

```bash
cd WEB
npm install
npm run db:seed     # demo data + demo accounts
npm run dev         # http://localhost:8788
```

Demo accounts (seeded): `ekin@plannedlost.dev / admin123!` (super admin),
`ayse@plannedlost.dev / member123!` (member).

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with watch + template compilation |
| `npm start` | Production entry point |
| `npm test` | Test suite (52 API/unit tests, `node:test`) |
| `npm run check` | TypeScript typecheck |
| `npm run backup` | Consistent DB snapshot + uploads copy → `WEB/backups/` |
| `npm run media:gc` | Remove unreferenced uploaded files (7-day grace) |
| `npm run db:seed` / `db:reset` | Seed demo data / wipe local data |

## Production

See [`WEB/deploy/README.md`](WEB/deploy/README.md): systemd unit, nginx TLS
sample and backup scheduling. Migrations apply automatically on server start
(`WEB/migrations/*.sql`). Required environment: `APP_URL`,
`BETTER_AUTH_SECRET`, `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM`.

## Backups & disaster recovery (Cloudflare / D1)

The live deployment's data lives entirely in D1 (`ticket-manager-prod`), which
Cloudflare backs up automatically via **Time Travel** point-in-time recovery
— no separate backup job is needed, and `WEB/scripts/backup.ts` /
`WEB/deploy/ticket-manager-backup.*` (sqlite file snapshots) only apply to
the old self-hosted/systemd deployment, not this one.

Retention is **7 days on the Workers Free plan** (30 days on Paid) — this
project is on Free (see the cron comment in `WEB/wrangler.toml`).

```sh
# See the current bookmark, or the bookmark for a specific past moment:
npx wrangler d1 time-travel info ticket-manager-prod
npx wrangler d1 time-travel info ticket-manager-prod --timestamp="2026-09-01T00:00:00Z"

# Restore the database to that point in time (destructive, overwrites in place,
# prompts for confirmation):
npx wrangler d1 time-travel restore ticket-manager-prod --timestamp=<unix-ts>
# or
npx wrangler d1 time-travel restore ticket-manager-prod --bookmark=<bookmark-id>
```

## CI

`.github/workflows/ci.yml` runs typecheck, the test suite and
`npm audit --audit-level=high` on every push.
