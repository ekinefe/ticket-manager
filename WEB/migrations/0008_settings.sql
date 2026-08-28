-- App-wide settings stored as key-value pairs. Only super admins may read
-- or modify these. Sensitive values (API keys, secrets) are stored encrypted
-- at rest in future; for now they are plain text — the DB file itself must
-- be protected.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed defaults from the environment so the settings page is pre-populated.
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('app_url',           COALESCE('http://localhost:8788', ''),                  strftime('%s','now') * 1000),
  ('better_auth_secret', COALESCE('', ''),                                      strftime('%s','now') * 1000),
  ('mail_transport',    COALESCE('file', ''),                                   strftime('%s','now') * 1000),
  ('mail_from',         COALESCE('Ticket Manager <no-reply@tickets.local>', ''), strftime('%s','now') * 1000),
  ('resend_api_key',    COALESCE('', ''),                                       strftime('%s','now') * 1000);
