-- GitHub integration: one private repo per project ("owner/name", lower-cased),
-- plus commits / pull requests received via the GitHub App webhook.
ALTER TABLE projects ADD COLUMN github_repo TEXT;
CREATE UNIQUE INDEX idx_projects_github_repo ON projects(github_repo) WHERE github_repo IS NOT NULL;

CREATE TABLE github_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- COMMIT | PR
  ref TEXT NOT NULL,             -- commit sha, or PR number
  title TEXT NOT NULL,
  url TEXT,
  author TEXT,                   -- GitHub display name / login, never an e-mail
  state TEXT,                    -- PR: open | draft | closed | merged
  branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, kind, ref)
);
CREATE INDEX idx_github_events_project ON github_events(project_id, updated_at);

CREATE TABLE github_event_tasks (
  event_id TEXT NOT NULL REFERENCES github_events(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, task_id)
);
CREATE INDEX idx_github_event_tasks_task ON github_event_tasks(task_id);
