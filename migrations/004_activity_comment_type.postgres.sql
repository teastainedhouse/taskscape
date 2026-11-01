-- 004_activity_comment_type.postgres.sql — 'comment' becomes an activity item type.
-- 001's inline CHECK on activity.item_type has PostgreSQL's default name,
-- activity_item_type_check; dropping it by name fails loudly if it differs.
-- The guard at the end refuses to commit unless exactly one CHECK on activity
-- mentions item_type and it allows 'comment' (a stray second CHECK would
-- otherwise make every comment's activity insert fail at run time).
-- The ALTERs lock activity, which every write touches: give up after 5s
-- rather than queue behind a long reader (a pg_dump, say). Before deploying:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'activity'::regclass AND contype = 'c';

SET LOCAL lock_timeout = '5s';

ALTER TABLE activity DROP CONSTRAINT activity_item_type_check;
ALTER TABLE activity ADD CONSTRAINT activity_item_type_check
  CHECK (item_type IN ('project', 'task', 'tag', 'comment'));

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'activity'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%item_type%') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = 'activity'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%item_type%' AND pg_get_constraintdef(oid) LIKE '%comment%') THEN
    RAISE EXCEPTION 'activity must have exactly one item_type CHECK, allowing comment';
  END IF;
END $$;
