ALTER TABLE projects ADD COLUMN default_assignee_id TEXT REFERENCES user(id) ON DELETE SET NULL;
