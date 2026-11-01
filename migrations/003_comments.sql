-- 003_comments.sql — guestbook comments on projects and tasks.
-- Dialect-neutral. A comment has no visibility of its own: it shows to whoever
-- can see its parent (api/lib/repo/visibility.js), and a trashed one only to
-- its author. Written by editors, never edited; trashed and restored by the
-- author with a compare-and-set on version; never hard-deleted.

CREATE TABLE comments (
  id           TEXT    PRIMARY KEY,
  item_type    TEXT    NOT NULL CHECK (item_type IN ('project', 'task')),
  item_id      TEXT    NOT NULL,                 -- the parent; the repo checks it exists and is visible
  author_id    TEXT    NOT NULL,
  author_name  TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT                              -- NULL = live; set = in the trash
);
CREATE INDEX idx_comments_item ON comments (item_type, item_id, created_at);
