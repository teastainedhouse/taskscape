-- 004_activity_comment_type.sqlite.sql — 'comment' becomes an activity item type.
-- SQLite cannot change a CHECK in place, so activity is rebuilt with the wider
-- CHECK: same columns, rows, and indexes. Nothing references activity, so the
-- drop needs no foreign-key dance. 004_activity_comment_type.postgres.sql does
-- the same with DROP/ADD CONSTRAINT.

CREATE TABLE activity_new (
  id           TEXT    PRIMARY KEY,
  created_at   TEXT    NOT NULL,
  actor_id     TEXT    NOT NULL,
  actor_name   TEXT    NOT NULL,
  via          TEXT    NOT NULL CHECK (via IN ('ui', 'mcp')),
  session_id   TEXT,                             -- MCP session id; NULL for the UI
  item_type    TEXT    NOT NULL CHECK (item_type IN ('project', 'task', 'tag', 'comment')),
  item_id      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('create', 'update', 'trash', 'restore')),
  changes      TEXT    NOT NULL                  -- JSON: {"field": {"from": x, "to": y}, ...}
);
INSERT INTO activity_new (id, created_at, actor_id, actor_name, via, session_id, item_type, item_id, action, changes)
  SELECT id, created_at, actor_id, actor_name, via, session_id, item_type, item_id, action, changes FROM activity;
DROP TABLE activity;
ALTER TABLE activity_new RENAME TO activity;
CREATE INDEX idx_activity_created ON activity (created_at, id);
CREATE INDEX idx_activity_item    ON activity (item_type, item_id);
