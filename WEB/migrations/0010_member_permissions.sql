CREATE TABLE IF NOT EXISTS project_member_permissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_project_member_permissions_member
  ON project_member_permissions(project_id, user_id);

-- Backfill: every existing MEMBER keeps today's behavior (unrestricted view,
-- can create tickets, can comment on any ticket, but can only edit/move a
-- ticket they created or are assigned to — moving OTHERS' tickets stays
-- admin-only unless explicitly granted). ADMIN rows need no rows here —
-- admins always have full access, checked in code.
INSERT INTO project_member_permissions (project_id, user_id, permission)
SELECT project_id, user_id, 'VIEW_ALL_TICKETS' FROM project_members WHERE role = 'MEMBER';

INSERT INTO project_member_permissions (project_id, user_id, permission)
SELECT project_id, user_id, 'CREATE_TICKET' FROM project_members WHERE role = 'MEMBER';

INSERT INTO project_member_permissions (project_id, user_id, permission)
SELECT project_id, user_id, 'COMMENT_ON_OTHERS_TICKETS' FROM project_members WHERE role = 'MEMBER';
