-- 012_comment_mentions.sql — @mentions in comments.
-- Dialect-neutral. One row per person a comment names with @id, written in the
-- comment's own transaction. A mention grants nothing: who sees a comment is
-- decided at read time by its parent (api/lib/repo/visibility.js), so a person
-- who cannot see the item gets nothing from being named, not even a For you
-- entry. Never updated or deleted, like the comment it belongs to.

CREATE TABLE comment_mentions (
  comment_id   TEXT NOT NULL REFERENCES comments (id),
  person_id    TEXT NOT NULL,
  person_name  TEXT NOT NULL,                    -- the name when mentioned, like author_name
  PRIMARY KEY (comment_id, person_id)
);
CREATE INDEX idx_comment_mentions_person ON comment_mentions (person_id, comment_id);
