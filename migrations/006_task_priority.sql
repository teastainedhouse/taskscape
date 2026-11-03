-- 006_task_priority.sql — a task's priority: one of taskscape.config.json `priorities`, or NULL for none.
-- Like status, the allowed names live in the config, so a team changes them without a migration.

ALTER TABLE tasks ADD COLUMN priority TEXT;
