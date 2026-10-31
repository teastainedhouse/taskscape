import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('stale version: 409 with the current record; fresh version succeeds', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  const first = await a.patch(`/api/tasks/${task.id}`, { version: 1, status: 'Doing' });
  assert.equal(first.status, 200);
  const second = await t.as('bob').patch(`/api/tasks/${task.id}`, { version: 1, status: 'Done' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'conflict');
  assert.equal(second.body.current.version, 2);
  assert.equal(second.body.current.status, 'Doing');
  const retry = await t.as('bob').patch(`/api/tasks/${task.id}`, { version: second.body.current.version, status: 'Done' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.version, 3);
  await t.close();
});

test('every write that touches a record requires version and bumps it by one', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'x' })).body;
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  let v = 1;
  const step = async (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); v++; assert.equal(res.body.version, v); };
  await step(await a.patch(`/api/projects/${p.id}`, { version: v, status: 'Active' }));
  await step(await a.put(`/api/projects/${p.id}/tags/${tag.id}`, { version: v }));
  await step(await a.delete(`/api/projects/${p.id}/tags/${tag.id}`, { version: v }));
  await step(await a.delete(`/api/projects/${p.id}`, { version: v }));
  await step(await a.post(`/api/projects/${p.id}/restore`, { version: v }));
  for (const [method, path] of [['patch', `/api/projects/${p.id}`], ['delete', `/api/projects/${p.id}`],
    ['post', `/api/projects/${p.id}/restore`], ['put', `/api/projects/${p.id}/tags/${tag.id}`]]) {
    const r = await a[method](path, { status: 'Done' });
    assert.equal(r.status, 400, `${method} ${path}`);
    assert.equal(r.body.error.details.fields.version, 'is required and must be a positive integer');
  }
  await t.close();
});

test('the 409 body is re-read through the privacy filter: becomes 404 if hidden meanwhile', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  // bob loads version 1; alice then makes it private (version 2)
  await a.patch(`/api/tasks/${task.id}`, { version: 1, private: true });
  const r = await t.as('bob').patch(`/api/tasks/${task.id}`, { version: 1, status: 'Done' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: { code: 'not_found', message: 'Not found.' } });
  await t.close();
});

test('editing a trashed item is invalid_state, not a conflict', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  await a.delete(`/api/tasks/${task.id}`, { version: 1 });
  const r = await a.patch(`/api/tasks/${task.id}`, { version: 2, status: 'Done' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('two writers racing on the same version: exactly one wins', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const results = await Promise.all(
    ['Active', 'Done', 'On hold', 'Planned'].map((status) => t.as('bob').patch(`/api/projects/${p.id}`, { version: 1, status })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409, 409]);
  assert.equal((await a.get(`/api/projects/${p.id}`)).body.version, 2);
  await t.close();
});
