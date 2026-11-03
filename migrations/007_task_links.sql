-- 007_task_links.sql — labelled web links on a task.
-- Dialect-neutral. A link has no visibility of its own: it shows exactly when its task does. Writes are a
-- compare-and-set on the parent task's version with an activity entry (api/lib/repo/links.js). Removing a
-- link trashes it (deleted_at); nothing hard-deletes one. The server never fetches a URL.

CREATE TABLE task_links (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  url         TEXT NOT NULL,                -- http: or https: only, checked by the API
  label       TEXT,                         -- NULL: show the URL
  position    INTEGER NOT NULL,             -- 0-based order among the task's live links
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_task_links_task ON task_links (task_id, position);
