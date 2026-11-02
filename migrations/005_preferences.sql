-- 005_preferences.sql — personal preferences, one row per principal id under any provider.
-- Like the auth tables: no version column and no activity entries (docs/PLAN.md §2 rule 13).
-- A NULL column means "the site default" from taskscape.config.json.

CREATE TABLE preferences (
  user_id         TEXT PRIMARY KEY,               -- the principal id (owner_id on items); no foreign key, since only the password provider has a users table
  theme           TEXT,                           -- one of the configured themes
  comments_label  TEXT,                           -- 'Comments' or 'Guestbook'
  shortcuts       INTEGER CHECK (shortcuts IN (0, 1)),  -- single-key keyboard shortcuts on (1) or off (0)
  time_zone       TEXT,                           -- an IANA time zone name
  updated_at      TEXT NOT NULL
);
