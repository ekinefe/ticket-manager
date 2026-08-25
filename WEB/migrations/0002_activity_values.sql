-- Store previous/new values for field-level ticket history (title, description, assignee).
ALTER TABLE activity_log ADD COLUMN old_value TEXT;
ALTER TABLE activity_log ADD COLUMN new_value TEXT;

-- Backfill CREATED events for tickets created before this migration (e.g. seeded rows),
-- so every ticket has a starting point in its history.
INSERT INTO activity_log (id, task_id, actor_id, event_type, new_status, created_at)
SELECT lower(hex(randomblob(16))), id, created_by, 'CREATED', status, created_at
FROM tasks
WHERE id NOT IN (SELECT task_id FROM activity_log WHERE event_type = 'CREATED');
