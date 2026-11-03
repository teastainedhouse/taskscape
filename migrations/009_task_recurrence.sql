-- 009_task_recurrence.sql — recurring tasks. `recurrence` is daily, weekly, monthly or yearly (NULL: no repeat).
-- When a PATCH moves a recurring task into a closed status, the same transaction creates the next copy
-- (api/lib/repo/tasks.js). `recurred_from` names the task a copy came from; `recurred_to` names the copy a
-- task produced, so reopening and closing it again never makes a second one. Both are set only by the API.

ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE tasks ADD COLUMN recurred_from TEXT;
ALTER TABLE tasks ADD COLUMN recurred_to TEXT;
