import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('create task: defaults to the catch-all project; shape; validation', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/tasks', { title: 'Loose end' });
  assert.equal(r.status, 201);
  assert.equal(r.body.project_id, 'general');
  assert.equal(r.body.project_name, 'General');
  assert.equal(r.body.status, 'To do');
  assert.equal(r.body.owner_id, 'alice');
  assert.equal(r.body.due_date, null);
  assert.equal(r.body.notes, '');
  assert.equal(r.body.version, 1);
  r = await a.post('/api/tasks', {});
  assert.equal(r.body.error.details.fields.title, 'is required');
  r = await a.post('/api/tasks', { title: 'x', due_date: '2026-13-45' });
  assert.equal(r.body.error.details.fields.due_date, 'must be YYYY-MM-DD or null');
  r = await a.post('/api/tasks', { title: 'x', due_date: '2026-02-30' });
  assert.equal(r.status, 400);
  r = await a.post('/api/tasks', { title: 'x', status: 'Planned' }); // a project status, not a task status
  assert.equal(r.status, 400);
  r = await a.post('/api/tasks', { title: 'x', project_id: 'missing' });
  assert.equal(r.status, 404);
  r = await a.post('/api/tasks', { title: 'x', project_id: null });
  assert.equal(r.status, 201);
  assert.equal(r.body.project_id, 'general');
  await t.close();
});

test('create in a trashed project is invalid_state', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  await a.delete(`/api/projects/${p.id}`, { version: 1 });
  const r = await a.post('/api/tasks', { title: 'x', project_id: p.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('list: project filter, status order, due sorting with nulls last, due windows', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const mk = (title, extra) => a.post('/api/tasks', { title, project_id: p.id, ...extra }).then((r) => r.body);
  const t1 = await mk('A', { due_date: '2026-11-05', status: 'Done' });
  const t2 = await mk('B', { due_date: null, status: 'Blocked' });
  const t3 = await mk('C', { due_date: '2026-11-01', status: 'Doing' });
  await a.post('/api/tasks', { title: 'Elsewhere' });
  let r = await a.get(`/api/tasks?project=${p.id}&sort=due_date`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t3.id, t1.id, t2.id]);
  r = await a.get(`/api/tasks?project=${p.id}&sort=due_date&dir=desc`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t1.id, t3.id, t2.id]);
  r = await a.get(`/api/tasks?project=${p.id}&sort=status&dir=asc`);
  assert.deepEqual(r.body.items.map((x) => x.status), ['Doing', 'Blocked', 'Done']);
  r = await a.get(`/api/tasks?project=${p.id}&due_before=2026-11-03`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t3.id]);
  r = await a.get(`/api/tasks?project=${p.id}&due_after=2026-11-03`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t1.id]);
  r = await a.get(`/api/tasks?due_before=garbage`);
  assert.equal(r.status, 400);
  r = await a.get(`/api/tasks?project=general`);
  assert.deepEqual(r.body.items.map((x) => x.title), ['Elsewhere']);
  await t.close();
});

test('patch: edit, move between projects, reassign', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p1 = (await a.post('/api/projects', { name: 'P1' })).body;
  const p2 = (await a.post('/api/projects', { name: 'P2' })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p1.id })).body;
  let r = await a.patch(`/api/tasks/${task.id}`, { version: 1, notes: 'hello', due_date: '2026-12-01' });
  assert.equal(r.body.version, 2);
  assert.equal(r.body.notes, 'hello');
  r = await a.patch(`/api/tasks/${task.id}`, { version: 2, project_id: p2.id });
  assert.equal(r.body.project_id, p2.id);
  assert.equal(r.body.project_name, 'P2');
  r = await a.patch(`/api/tasks/${task.id}`, { version: 3, project_id: 'nope' });
  assert.equal(r.status, 404);
  r = await a.patch(`/api/tasks/${task.id}`, { version: 3, project_id: null });
  assert.equal(r.status, 400);
  r = await t.as('bob').patch(`/api/tasks/${task.id}`, { version: 3, owner_id: 'bob' });
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  const act = (await a.get(`/api/activity?item_id=${task.id}`)).body.items;
  assert.deepEqual(act[0].changes, { owner_id: { from: 'alice', to: 'bob' }, owner_name: { from: 'Alice Lin', to: 'Bob Ortiz' } });
  assert.deepEqual(act[1].changes, { project_id: { from: p1.id, to: p2.id } });
  await t.close();
});
