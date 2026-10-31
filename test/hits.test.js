import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY } from './helpers.js';

test('hit increments without touching version, updated_at, or activity; GET never increments', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  await a.get(`/api/projects/${p.id}`); await a.get('/api/projects');
  assert.equal((await a.get(`/api/projects/${p.id}`)).body.hit_count, 0);
  let r = await a.post(`/api/projects/${p.id}/hit`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { project_id: p.id, hit_count: 1 });
  r = await a.post(`/api/projects/${p.id}/hit`);
  assert.equal(r.body.hit_count, 2);
  const after = (await a.get(`/api/projects/${p.id}`)).body;
  assert.equal(after.hit_count, 2);
  assert.equal(after.version, 1);
  assert.equal(after.updated_at, p.updated_at);
  assert.equal((await a.get(`/api/activity?item_id=${p.id}`)).body.items.length, 1);
  // a PATCH with the pre-hit version still succeeds
  assert.equal((await a.patch(`/api/projects/${p.id}`, { version: 1, status: 'Active' })).status, 200);
  await t.close();
});

test('hit_count is read-only on POST and PATCH', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/projects', { name: 'P', hit_count: 9 });
  assert.equal(r.body.error.details.fields.hit_count, 'read-only');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  r = await a.patch(`/api/projects/${p.id}`, { version: 1, hit_count: 9 });
  assert.equal(r.body.error.details.fields.hit_count, 'read-only');
  await t.close();
});

test('private project: non-owner hit is the generic 404 and the count does not move; flips preserve it', async () => {
  const t = await createTestApp();
  const c = t.as('carol');
  const p = (await c.post('/api/projects', { name: 'Secret', private: true })).body;
  await c.post(`/api/projects/${p.id}/hit`);
  const bob = await t.as('bob').post(`/api/projects/${p.id}/hit`);
  assert.equal(bob.status, 404);
  assert.deepEqual(bob.body, NOT_FOUND_BODY);
  const random = await t.as('bob').post('/api/projects/does-not-exist/hit');
  assert.equal(random.text, bob.text);
  assert.equal((await c.get(`/api/projects/${p.id}`)).body.hit_count, 1);
  await c.patch(`/api/projects/${p.id}`, { version: 1, private: false });
  await c.patch(`/api/projects/${p.id}`, { version: 2, private: true });
  assert.equal((await c.get(`/api/projects/${p.id}`)).body.hit_count, 1);
  await t.close();
});

test('token principals get 403; trashed projects 400; restore makes hits work again', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const { plaintext } = (await a.post('/api/tokens', { label: 'cli' })).body;
  const r = await t.tokenAs(plaintext).post(`/api/projects/${p.id}/hit`);
  assert.equal(r.status, 403);
  await a.delete(`/api/projects/${p.id}`, { version: 1 });
  assert.equal((await a.post(`/api/projects/${p.id}/hit`)).status, 400);
  await a.post(`/api/projects/${p.id}/restore`, { version: 2 });
  assert.equal((await a.post(`/api/projects/${p.id}/hit`)).body.hit_count, 1);
  await t.close();
});

test('twenty parallel hits count exactly twenty', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  await Promise.all(Array.from({ length: 20 }, () => a.post(`/api/projects/${p.id}/hit`)));
  assert.equal((await a.get(`/api/projects/${p.id}`)).body.hit_count, 20);
  const md = await a.get(`/api/projects/${p.id}/export.md`);
  assert.match(md.text, /\| Hits \| 20 \|/);
  await t.close();
});
