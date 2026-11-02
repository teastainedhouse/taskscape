-- 008_task_checklist.sql — checklist items on a task: lightweight subtasks.
-- Dialect-neutral. An item has no visibility of its own: it shows exactly when its task does. Writes are a
-- compare-and-set on the parent task's version with an activity entry (api/lib/repo/checklist.js). Removing an
-- item trashes it (deleted_at); nothing hard-deletes one.

CREATE TABLE task_checklist_items (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  text        TEXT NOT NULL,                              -- one line, at most 500 characters, checked by the API
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  position    INTEGER NOT NULL,                           -- 0-based order among the task's live items
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_task_checklist_task ON task_checklist_items (task_id, position);
