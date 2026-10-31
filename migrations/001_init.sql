-- 001_init.sql — Taskscape v0.1 schema.
-- Dialect-neutral: runs unchanged on SQLite and PostgreSQL.
-- Timestamps are ISO-8601 UTC text; due_date is YYYY-MM-DD text; booleans are 0/1.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);

CREATE TABLE projects (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL,                 -- validated against the config, not a foreign key
  owner_id     TEXT    NOT NULL,
  owner_name   TEXT    NOT NULL,
  private      INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  hit_count    INTEGER NOT NULL DEFAULT 0,       -- page views; see POST /api/projects/:id/hit
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT                              -- NULL = live; set = in the trash
);
CREATE INDEX idx_projects_owner   ON projects (owner_id);
CREATE INDEX idx_projects_deleted ON projects (deleted_at);
CREATE INDEX idx_projects_updated ON projects (updated_at);

CREATE TABLE tasks (
  id           TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES projects (id),
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  owner_id     TEXT    NOT NULL,
  owner_name   TEXT    NOT NULL,
  private      INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  due_date     TEXT,                             -- 'YYYY-MM-DD' or NULL
  notes        TEXT    NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_owner   ON tasks (owner_id);
CREATE INDEX idx_tasks_deleted ON tasks (deleted_at);
CREATE INDEX idx_tasks_due     ON tasks (due_date);
CREATE INDEX idx_tasks_status  ON tasks (status);

CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,              -- lowercased and trimmed by the API
  color       TEXT NOT NULL,                     -- '#rrggbb'
  created_at  TEXT NOT NULL
);

CREATE TABLE project_tags (
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id)     ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);
CREATE INDEX idx_project_tags_tag ON project_tags (tag_id);

CREATE TABLE task_tags (
  task_id     TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX idx_task_tags_tag ON task_tags (tag_id);

CREATE TABLE activity (
  id           TEXT    PRIMARY KEY,
  created_at   TEXT    NOT NULL,
  actor_id     TEXT    NOT NULL,
  actor_name   TEXT    NOT NULL,
  via          TEXT    NOT NULL CHECK (via IN ('ui', 'mcp')),
  session_id   TEXT,                             -- MCP session id; NULL for the UI
  item_type    TEXT    NOT NULL CHECK (item_type IN ('project', 'task', 'tag')),
  item_id      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('create', 'update', 'trash', 'restore')),
  changes      TEXT    NOT NULL                  -- JSON: {"field": {"from": x, "to": y}, ...}
);
CREATE INDEX idx_activity_created ON activity (created_at, id);
CREATE INDEX idx_activity_item    ON activity (item_type, item_id);

CREATE TABLE mcp_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  user_name     TEXT NOT NULL,
  user_email    TEXT,
  label         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,            -- sha256 hex of the plaintext; plaintext is never stored
  token_prefix  TEXT NOT NULL,                   -- first 12 characters, for display only
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens (user_id);
