-- 002_password_auth.sql — users and sign-in sessions for the built-in password provider.
-- Dialect-neutral. Auth tables like mcp_tokens: no version column, no activity entries.
-- Only used when auth.provider is "password"; empty otherwise.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,                -- the principal id; becomes owner_id on items
  name           TEXT NOT NULL,
  email          TEXT,
  groups         TEXT NOT NULL DEFAULT '[]',      -- JSON array of group names
  password_hash  TEXT NOT NULL,                   -- scrypt$N$r$p$salt$hash; see api/lib/auth/passwords.js
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  disabled_at    TEXT                             -- NULL = may sign in
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  token_hash    TEXT NOT NULL UNIQUE,             -- sha256 hex of the cookie value; the value is never stored
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                    -- fixed at creation; never extended
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
