import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('trash a project: it and its tasks leave the lists; restore brings them back', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p.id })).body;
  let r = await a.delete(`/api/projects/${p.id}`, { version: 1 });
  assert.equal(r.status, 200);
  assert.ok(r.body.deleted_at);
  assert.equal((await a.get('/api/projects')).body.items.some((x) => x.id === p.id), false);
  assert.equal((await a.get('/api/tasks')).body.items.some((x) => x.id === task.id), false);
  assert.equal((await a.get(`/api/projects?include_trashed=true`)).body.items.some((x) => x.id === p.id), true);
  assert.deepEqual((await a.get(`/api/projects?include_trashed=only`)).body.items.map((x) => x.id), [p.id]);
  // the task was not stamped itself, so it is not in the trash list
  const trash = (await a.get('/api/trash')).body;
  assert.deepEqual(trash.projects.map((x) => x.id), [p.id]);
  assert.deepEqual(trash.tasks, []);
  // GET by id still works for the owner (so the trash page can show it)
  assert.equal((await a.get(`/api/projects/${p.id}`)).status, 200);
  r = await a.delete(`/api/projects/${p.id}`, { version: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  r = await a.post(`/api/projects/${p.id}/restore`, { version: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted_at, null);
  assert.equal((await a.get('/api/tasks')).body.items.some((x) => x.id === task.id), true);
  r = await a.post(`/api/projects/${p.id}/restore`, { version: 3 });
  assert.equal(r.status, 400);
  await t.close();
});

test('a task trashed on its own stays trashed after its project is restored', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const t1 = (await a.post('/api/tasks', { title: 'keep', project_id: p.id })).body;
  const t2 = (await a.post('/api/tasks', { title: 'gone', project_id: p.id })).body;
  await a.delete(`/api/tasks/${t2.id}`, { version: 1 });
  await a.delete(`/api/projects/${p.id}`, { version: 1 });
  // restoring the task while its project is trashed is refused
  let r = await a.post(`/api/tasks/${t2.id}/restore`, { version: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await a.post(`/api/projects/${p.id}/restore`, { version: 2 });
  const ids = (await a.get(`/api/tasks?project=${p.id}`)).body.items.map((x) => x.id);
  assert.deepEqual(ids, [t1.id]);
  const trash = (await a.get('/api/trash')).body;
  assert.deepEqual(trash.tasks.map((x) => x.id), [t2.id]);
  r = await a.post(`/api/tasks/${t2.id}/restore`, { version: 2 });
  assert.equal(r.status, 200);
  await t.close();
});

test('the catch-all project cannot be trashed', async () => {
  const t = await createTestApp();
  const r = await t.as('alice').delete('/api/projects/general', { version: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('trash list is newest first', async () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const t = await createTestApp({ now: () => new Date(now += 1000).toISOString() });
  const b = t.as('alice');
  const x1 = (await b.post('/api/tasks', { title: 'first' })).body;
  const x2 = (await b.post('/api/tasks', { title: 'second' })).body;
  await b.delete(`/api/tasks/${x1.id}`, { version: 1 });
  await b.delete(`/api/tasks/${x2.id}`, { version: 1 });
  assert.deepEqual((await b.get('/api/trash')).body.tasks.map((x) => x.id), [x2.id, x1.id]);
  await t.close();
});

test('tagging a trashed item is refused; other items are unaffected', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'x' })).body;
  const t1 = (await a.post('/api/tasks', { title: 'first' })).body;
  const t2 = (await a.post('/api/tasks', { title: 'second' })).body;
  await a.delete(`/api/tasks/${t1.id}`, { version: 1 });
  const r = await a.put(`/api/tasks/${t1.id}/tags/${tag.id}`, { version: 2 });
  assert.equal(r.status, 400);
  assert.equal((await a.get(`/api/tasks/${t2.id}`)).status, 200);
  await t.close();
});
