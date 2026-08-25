# Production deployment

1. **Provision** a Linux host with Node.js >= 24.
2. **Install**: copy the repository to `/opt/ticket-manager`, then
   `cd WEB && npm ci`.
3. **Configure** `WEB/.env` (see the variable list in
   `deploy/ticket-manager.service`):
   - `APP_URL` – public base URL (also used in e-mail links)
   - `BETTER_AUTH_SECRET` – `openssl rand -base64 32`
   - `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM`
   - `OSV_PACKAGES` – JSON array of `"name@version"` for the weekly scan
4. **Service**: `cp deploy/ticket-manager.service /etc/systemd/system/ &&
   systemctl enable --now ticket-manager`.
5. **TLS**: terminate at nginx/Caddy (sample: `deploy/nginx.conf.sample`);
   keep the Node process on `127.0.0.1:8788`.
6. **Backups**: schedule `cd WEB && npm run backup` (cron recommended, e.g.
   nightly) and keep at least one copy on a different disk. A backup contains
   `ticket-manager.db` + the `uploads/` directory; restore = stop service,
   copy both back, start service.

First start applies pending SQL migrations automatically
(`WEB/migrations/*.sql`). For a fresh install, seed demo data with
`npm run db:seed` and sign in with the printed demo account, then create real
users via invitations.
