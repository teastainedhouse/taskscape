// today.test.js — one rule for "today": the caller's time zone (their preference, else the site
// default) decides the date; due=overdue|today|week, closed_since and closed_at; Me carries today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('due filters use the caller\'s own today: the same tasks are overdue for one person and due today for another', async () => {
  // 23:30 UTC on 2 November is 3 November in Kiritimati (UTC+14)
  const t = await createTestApp({ now: () => '2026-11-02T23:30:00.000Z' });
  const a = t.as('alice');
  const b = t.as('bob');
  await a.patch('/api/me/preferences', { time_zone: 'Pacific/Kiritimati' });
  const mk = (title, due_date, status) => a.post('/api/tasks', { title, due_date, status }).then((r) => r.body);
  const nov2 = await mk('Nov 2', '2026-11-02');
  const nov3 = await mk('Nov 3', '2026-11-03');
  const nov9 = await mk('Nov 9', '2026-11-09');
  const nov10 = await mk('Nov 10', '2026-11-10');
  await mk('Nov 1 done', '2026-11-01', 'Done');
  const ids = async (client, q) => (await client.get(`/api/tasks?${q}&sort=due_date`)).body.items.map((x) => x.title);
  assert.deepEqual(await ids(a, 'due=overdue'), ['Nov 2'], 'for alice it is already 3 November; a closed task is never overdue');
  assert.deepEqual(await ids(a, 'due=today'), ['Nov 3']);
  assert.deepEqual(await ids(a, 'due=week'), ['Nov 3', 'Nov 9'], 'today and the next six days');
  assert.deepEqual(await ids(b, 'due=overdue'), [], 'for bob (UTC) it is 2 November: nothing overdue');
  assert.deepEqual(await ids(b, 'due=today'), ['Nov 2']);
  assert.deepEqual(await ids(b, 'due=week'), ['Nov 2', 'Nov 3']);
  assert.equal((await a.get('/api/me')).body.today, '2026-11-03');
  assert.equal((await b.get('/api/me')).body.today, '2026-11-02');
  const bad = await a.get('/api/tasks?due=yesterday');
  assert.deepEqual(bad.body.error.details.fields, { due: 'must be overdue, today, or week' });
  assert.ok(nov2 && nov3 && nov9 && nov10);
  await t.close();
});

test('closed_at is set when a task closes and cleared when it reopens; closed_since filters on it', async () => {
  let now = '2026-11-01T10:00:00.000Z';
  const t = await createTestApp({ now: () => now });
  const a = t.as('alice');
  let task = (await a.post('/api/tasks', { title: 'T' })).body;
  assert.equal(task.closed_at, null);
  now = '2026-11-02T10:00:00.000Z';
  task = (await a.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'Done' })).body;
  assert.equal(task.closed_at, '2026-11-02T10:00:00.000Z');
  now = '2026-11-03T10:00:00.000Z';
  task = (await a.patch(`/api/tasks/${task.id}`, { version: task.version, title: 'T2' })).body;
  assert.equal(task.closed_at, '2026-11-02T10:00:00.000Z', 'an edit to a closed task keeps when it closed');
  const born = (await a.post('/api/tasks', { title: 'Born done', status: 'Done' })).body;
  assert.equal(born.closed_at, now);
  let r = await a.get('/api/tasks?closed_since=2026-11-02T12:00:00.000Z');
  assert.deepEqual(r.body.items.map((x) => x.title), ['Born done']);
  r = await a.get('/api/tasks?closed_since=2026-11-01');
  assert.equal(r.body.items.length, 2);
  task = (await a.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'To do' })).body;
  assert.equal(task.closed_at, null, 'reopening clears it');
  assert.equal((await a.get('/api/tasks?closed_since=nope')).status, 400);
  assert.equal((await a.get('/api/tasks?closed_since=2026-02-31')).status, 400, 'no rolling over into March');
  assert.equal((await a.get('/api/tasks?closed_since=2026-02-30T10:00:00Z')).status, 400);
  assert.equal((await a.post('/api/tasks', { title: 'x', closed_at: now })).body.error.details.fields.closed_at, 'read-only');
  await t.close();
});

test('attention_statuses come from the config and must be task statuses', async () => {
  const t = await createTestApp();
  assert.deepEqual((await t.as('alice').get('/api/config')).body.attention_statuses, { task: ['Blocked'] });
  await t.close();
  const { prepareConfig } = await import('../api/lib/config.js');
  const base = JSON.parse((await import('node:fs')).readFileSync(new URL('../taskscape.config.json', import.meta.url), 'utf8'));
  assert.throws(() => prepareConfig({ ...base, attention_statuses: { task: ['Stuck'] } }), /attention_statuses.task must list task statuses/);
  assert.deepEqual(prepareConfig({ ...base, attention_statuses: undefined }).attention_statuses, { task: [] });
});

test('privacy: the due filters and closed_since never show another person\'s private items', async () => {
  const t = await createTestApp({ now: () => '2026-11-02T10:00:00.000Z' });
  const a = t.as('alice');
  const b = t.as('bob');
  await b.post('/api/tasks', { title: 'Bob secret overdue', private: true, due_date: '2026-11-01' });
  await b.post('/api/tasks', { title: 'Bob secret done', private: true, status: 'Done' });
  const p = (await b.post('/api/projects', { name: 'Bob only', private: true })).body;
  await b.post('/api/tasks', { title: 'Inside bob only', project_id: p.id, due_date: '2026-11-02' });
  for (const q of ['due=overdue', 'due=today', 'due=week', 'closed_since=2026-01-01']) {
    for (const extra of ['', '&owner=bob']) {
      assert.deepEqual((await a.get(`/api/tasks?${q}${extra}`)).body.items, [], `${q}${extra}`);
    }
  }
  assert.equal((await b.get('/api/tasks?due=overdue')).body.items.length, 1);
  assert.equal((await b.get('/api/tasks?due=today')).body.items.length, 1);
  await t.close();
});
