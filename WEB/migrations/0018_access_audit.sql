-- Who changed whose access, when. Names are copied in so history survives deletions.
CREATE TABLE access_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_name TEXT,
  project_id TEXT,
  project_prefix TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_access_audit_created ON access_audit(created_at);
