# Ticket Manager

> **Development status: not production-ready.** This project is still in
> active development. Work is ongoing on the `dev` branch and has not yet
> reached a production release. Nothing here should be treated as stable or
> suitable for production use yet.

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

## CI

`.github/workflows/ci.yml` runs typecheck, the test suite and
`npm audit --audit-level=high` on every push.
