-- 011_feed_tokens.sql — the secrets in calendar and Atom feed links. Separate from mcp_tokens: a feed token can
-- only read the feeds. Like the auth tables, no version and no activity entries (docs/PLAN.md §2 rule 13).
-- Only the sha256 of a token is stored; its first characters are kept to tell links apart.

CREATE TABLE feed_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  user_name     TEXT NOT NULL,                 -- a snapshot, for the feed's title
  label         TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('mine', 'all')),
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX idx_feed_tokens_user ON feed_tokens (user_id);
