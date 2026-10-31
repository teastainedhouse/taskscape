import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('tags: create is idempotent on the normalized name; palette default; validation', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/tags', { name: '  Web  Dev ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'web dev');
  assert.equal(r.body.color, '#000080');
  const again = await t.as('bob').post('/api/tags', { name: 'WEB DEV', color: '#FFFFFF' });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, r.body.id);
  assert.equal(again.body.color, '#000080'); // existing wins
  r = await a.post('/api/tags', { name: 'ops', color: '#ABCDEF' });
  assert.equal(r.body.color, '#abcdef');
  r = await a.post('/api/tags', { name: 'auto' });
  assert.equal(r.body.color, '#800000'); // third tag -> third palette entry
  r = await a.post('/api/tags', { name: '' });
  assert.equal(r.body.error.details.fields.name, 'must not be empty');
  r = await a.post('/api/tags', { name: 'x', color: 'red' });
  assert.equal(r.body.error.details.fields.color, 'must be #rrggbb');
  r = await a.post('/api/tags', { name: 'y'.repeat(41) });
  assert.equal(r.status, 400);
  const list = (await a.get('/api/tags')).body.items;
  assert.deepEqual(list.map((x) => x.name), ['auto', 'ops', 'web dev']);
  assert.equal('count' in list[0], false);
  await t.close();
});

test('attach and detach are idempotent, bump the version, and log once per real change', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'bug' })).body;
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  let r = await a.put(`/api/tasks/${task.id}/tags/${tag.id}`, { version: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags.map((x) => x.name), ['bug']);
  assert.equal(r.body.version, 2);
  r = await a.put(`/api/tasks/${task.id}/tags/${tag.id}`, { version: 2 });
  assert.equal(r.body.version, 3);
  assert.deepEqual(r.body.tags.map((x) => x.name), ['bug']);
  r = await a.delete(`/api/tasks/${task.id}/tags/${tag.id}`, { version: 3 });
  assert.deepEqual(r.body.tags, []);
  r = await a.put(`/api/tasks/${task.id}/tags/not-a-tag`, { version: 4 });
  assert.equal(r.status, 404);
  const act = (await a.get(`/api/activity?item_id=${task.id}`)).body.items;
  assert.deepEqual(act.map((e) => e.action), ['update', 'update', 'create']);
  assert.deepEqual(act[0].changes, { tags: { from: ['bug'], to: [] } });
  assert.deepEqual(act[1].changes, { tags: { from: [], to: ['bug'] } });
  // tag list filter by name works for tasks too
  await a.put(`/api/tasks/${task.id}/tags/${tag.id}`, { version: 4 });
  assert.deepEqual((await a.get('/api/tasks?tag=bug')).body.items.map((x) => x.id), [task.id]);
  await t.close();
});
