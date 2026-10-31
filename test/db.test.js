import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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

test('sqlite: migrate applies 001 once and is idempotent', async () => {
  const db = await openDb('sqlite::memory:');
  const first = await db.migrate(MIGRATIONS);
  assert.deepEqual(first.applied, ['001_init']);
  const second = await db.migrate(MIGRATIONS);
  assert.deepEqual(second.applied, []);
  const { rows } = await db.query('SELECT id, name FROM schema_migrations ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'init' }]);
  await db.close();
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
    const list = await listMigrations(dir, 'sqlite');
    assert.deepEqual(list.map((m) => path.basename(m.file)), ['001_first.sqlite.sql', '002_second.sql', '010_tenth.sql']);
    const db = await openDb('sqlite::memory:');
    const { applied } = await db.migrate(dir);
    assert.deepEqual(applied, ['001_first', '002_second', '010_tenth']);
    const cols = (await db.query('PRAGMA table_info(a)')).rows.map((r) => r.name);
    assert.deepEqual(cols, ['x', 'from_override']);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openDb rejects unknown schemes', async () => {
  await assert.rejects(openDb('mysql://x'), /Unsupported/);
  await assert.rejects(openDb(''), /not set/);
});
