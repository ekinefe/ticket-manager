-- Ticket classification: TASK vs BUG (drives default branch naming) and priority.
ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'TASK';
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'MEDIUM';
