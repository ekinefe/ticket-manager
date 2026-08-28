-- Sprints: per-project iterations with human-visible IDs (PREFIX-S1).
CREATE TABLE IF NOT EXISTS sprints (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sprint_id  TEXT NOT NULL UNIQUE,            -- e.g. PLN-S1
  name       TEXT NOT NULL,                   -- e.g. Sprint 1
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);

-- Tickets optionally belong to a sprint; deleting a sprint leaves tickets
-- in place (sprint becomes NULL), it never deletes work.
ALTER TABLE tasks ADD COLUMN sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL;

-- Backfill: every existing project gets the default first sprint.
INSERT INTO sprints (id, project_id, sprint_id, name, created_at)
SELECT lower(hex(randomblob(16))), p.id, p.prefix || '-S1', 'Sprint 1', strftime('%s','now') * 1000
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM sprints s WHERE s.project_id = p.id);
