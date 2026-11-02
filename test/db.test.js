import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../api/lib/db/index.js';
import { toPositional, coerceParams, isReadStatement } from '../api/lib/db/placeholders.js';
import { listMigrations } from '../api/lib/db/migrate.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname;

test('placeholders: ? becomes $n, except inside quotes and comments', () => {
  assert.equal(toPositional('SELECT ? , ?'), 'SELECT $1 , $2');
  assert.equal(toPositional("SELECT 'a?b', ? FROM t WHERE x = 'it''s?'"), "SELECT 'a?b', $1 FROM t WHERE x = 'it''s?'");
  assert.equal(toPositional('SELECT 1 -- is it?\n WHERE a = ?'), 'SELECT 1 -- is it?\n WHERE a = $1');
  assert.equal(toPositional('SELECT /* what? */ ? FROM "odd?name" WHERE x = ?'), 'SELECT /* what? */ $1 FROM "odd?name" WHERE x = $2');
});

test('placeholders: booleans and undefined are coerced', () => {
  assert.deepEqual(coerceParams([true, false, undefined, 'x', 0, null]), [1, 0, null, 'x', 0, null]);
});

test('placeholders: read statements are detected', () => {
  assert.equal(isReadStatement('  select 1'), true);
  assert.equal(isReadStatement('-- comment\nWITH a AS (SELECT 1) SELECT * FROM a'), true);
  assert.equal(isReadStatement('UPDATE t SET a = 1'), false);
  assert.equal(isReadStatement('INSERT INTO t VALUES (1)'), false);
});

test('sqlite: migrate applies the shipped migrations once and is idempotent', async () => {
  const db = await openDb('sqlite::memory:');
  const first = await db.migrate(MIGRATIONS);
  assert.deepEqual(first.applied, ['001_init', '002_password_auth', '003_comments', '004_activity_comment_type', '005_preferences', '006_task_priority', '007_task_links', '008_task_checklist', '009_task_recurrence', '010_task_closed_at', '011_feed_tokens']);
  const second = await db.migrate(MIGRATIONS);
  assert.deepEqual(second.applied, []);
  const { rows } = await db.query('SELECT id, name FROM schema_migrations ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'init' }, { id: 2, name: 'password_auth' }, { id: 3, name: 'comments' }, { id: 4, name: 'activity_comment_type' }, { id: 5, name: 'preferences' }, { id: 6, name: 'task_priority' }, { id: 7, name: 'task_links' }, { id: 8, name: 'task_checklist' }, { id: 9, name: 'task_recurrence' }, { id: 10, name: 'task_closed_at' }, { id: 11, name: 'feed_tokens' }]);
  await db.close();
});

test('sqlite: 004 widens the activity item_type CHECK and keeps every row and index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsk-mig-'));
  try {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql'));
    for (const f of files.filter((f) => Number.parseInt(f, 10) < 4)) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
    const db = await openDb('sqlite::memory:');
    await db.migrate(dir);
    const row = (id, type, session) => db.query(
      'INSERT INTO activity (id, created_at, actor_id, actor_name, via, session_id, item_type, item_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, `2026-11-01T00:00:0${id}.000Z`, 'alice', 'Alice', session ? 'mcp' : 'ui', session, type, 'x', 'update', '{"a":{"from":1,"to":2}}']);
    await row('1', 'project', null);
    await row('2', 'task', 's1');
    await row('3', 'tag', null);
    await assert.rejects(row('4', 'comment', null), /CHECK/, 'before 004 a comment entry is refused');
    const before = (await db.query('SELECT * FROM activity ORDER BY id')).rows;
    for (const f of files.filter((f) => f.startsWith('004_'))) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
    assert.deepEqual((await db.migrate(dir)).applied, ['004_activity_comment_type']);
    assert.deepEqual((await db.query('SELECT * FROM activity ORDER BY id')).rows, before);
    const indexes = (await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity' AND sql IS NOT NULL ORDER BY name")).rows;
    assert.deepEqual(indexes.map((r) => r.name), ['idx_activity_created', 'idx_activity_item']);
    await row('4', 'comment', null);
    await assert.rejects(row('5', 'bogus', null), /CHECK/);
    await assert.rejects(db.query(
      'INSERT INTO activity (id, created_at, actor_id, actor_name, via, session_id, item_type, item_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['6', 'now', 'a', 'A', 'web', null, 'task', 'x', 'update', '{}']), /CHECK/, 'the other CHECKs survive the rebuild');
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite: transaction rolls back on throw and commits otherwise', async () => {
  const db = await openDb('sqlite::memory:');
  await db.migrate(MIGRATIONS);
  const now = new Date().toISOString();
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)", ['t1', 'web', '#000080', now]);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM tags')).rows[0].n, 0);
  const result = await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)", ['t1', 'web', '#000080', now]);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM tags')).rows[0].n, 1);
  await db.close();
});

test('sqlite: nested transactions throw; boolean params bind as 0/1', async () => {
  const db = await openDb('sqlite::memory:');
  await db.migrate(MIGRATIONS);
  await assert.rejects(db.transaction(async (tx) => tx.transaction(async () => {})), /Nested/);
  const now = new Date().toISOString();
  await db.query(
    'INSERT INTO projects (id, name, status, owner_id, owner_name, private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['p1', 'P', 'Active', 'alice', 'Alice', true, now, now]);
  assert.equal((await db.query('SELECT private FROM projects WHERE id = ?', ['p1'])).rows[0].private, 1);
  await db.close();
});

test('sqlite: overlapping transactions are serialised, not interleaved', async () => {
  const db = await openDb('sqlite::memory:');
  await db.migrate(MIGRATIONS);
  const now = new Date().toISOString();
  await db.query(
    'INSERT INTO projects (id, name, status, owner_id, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['p1', 'P', 'Active', 'alice', 'Alice', now, now]);
  const bump = () => db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT hit_count FROM projects WHERE id = ?', ['p1']);
    await new Promise((r) => setTimeout(r, 2)); // give another transaction a chance to sneak in
    await tx.query('UPDATE projects SET hit_count = ? WHERE id = ?', [Number(rows[0].hit_count) + 1, 'p1']);
  });
  await Promise.all(Array.from({ length: 10 }, bump));
  assert.equal((await db.query('SELECT hit_count FROM projects WHERE id = ?', ['p1'])).rows[0].hit_count, 10);
  await db.close();
});

test('migrate: dialect-specific override is preferred and ordering is numeric', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsk-mig-'));
  try {
    await writeFile(path.join(dir, '002_second.sql'), 'CREATE TABLE b (x INTEGER);');
    await writeFile(path.join(dir, '010_tenth.sql'), 'CREATE TABLE c (x INTEGER);');
    await writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
    await writeFile(path.join(dir, '001_first.sqlite.sql'), 'CREATE TABLE a (x INTEGER, from_override INTEGER);');
    await writeFile(path.join(dir, '001_first.postgres.sql'), 'CREATE TABLE a (x INTEGER, pg_only INTEGER);');
    await writeFile(path.join(dir, '011_snake_case_name.sql'), 'CREATE TABLE d (x INTEGER);'); // underscores in the name, as the recipes use
    const list = await listMigrations(dir, 'sqlite');
    assert.deepEqual(list.map((m) => path.basename(m.file)), ['001_first.sqlite.sql', '002_second.sql', '010_tenth.sql', '011_snake_case_name.sql']);
    const db = await openDb('sqlite::memory:');
    const { applied } = await db.migrate(dir);
    assert.deepEqual(applied, ['001_first', '002_second', '010_tenth', '011_snake_case_name']);
    const cols = (await db.query('PRAGMA table_info(a)')).rows.map((r) => r.name);
    assert.deepEqual(cols, ['x', 'from_override']);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate: a misnamed .sql file, or a recorded name that no longer matches, stops the run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsk-mig-'));
  try {
    await writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
    await writeFile(path.join(dir, 'notes.txt'), 'not a migration, ignored');
    const db = await openDb('sqlite::memory:');
    assert.deepEqual((await db.migrate(dir)).applied, ['001_first']);
    // renamed after it was applied: the runner must not take 001 as done
    await rm(path.join(dir, '001_first.sql'));
    await writeFile(path.join(dir, '001_renamed.sql'), 'CREATE TABLE b (x INTEGER);');
    await assert.rejects(db.migrate(dir), /applied as "first" but the file is now "renamed"/);
    await rm(path.join(dir, '001_renamed.sql'));
    await writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (x INTEGER);');
    for (const bad of ['2_two words.sql', '002-dash.sql', 'three.sql', '004_x.mysql.sql']) {
      await writeFile(path.join(dir, bad), 'SELECT 1;');
      await assert.rejects(db.migrate(dir), /does not match/, bad);
      await rm(path.join(dir, bad));
    }
    assert.deepEqual((await db.migrate(dir)).applied, []);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openDb rejects unknown schemes', async () => {
  await assert.rejects(openDb('mysql://x'), /Unsupported/);
  await assert.rejects(openDb(''), /not set/);
});
