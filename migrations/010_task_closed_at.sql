-- 010_task_closed_at.sql — when a task last moved into a closed status (NULL while open). Set by the API on create
-- and on a status change, never by a client; "finished in the last 7 days" on the Today page reads it.

ALTER TABLE tasks ADD COLUMN closed_at TEXT;
