-- Per-ticket sharing: share_mode OFF (default) | ACCOUNT (any signed-in user) | LINK (anyone with the link).
-- share_token is the unguessable URL secret; clearing it revokes the link instantly.
ALTER TABLE tasks ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE tasks ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_tasks_share_token ON tasks(share_token) WHERE share_token IS NOT NULL;
