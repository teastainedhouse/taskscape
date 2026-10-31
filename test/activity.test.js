import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('one entry per write, with the documented change shapes', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'web' })).body;
  const p = (await a.post('/api/projects', { name: 'P', tag_ids: [tag.id] })).body;
  await a.patch(`/api/projects/${p.id}`, { version: 1, status: 'Active', owner_id: 'bob', owner_name: 'Bob Ortiz' });
  await t.as('bob').delete(`/api/projects/${p.id}`, { version: 2 });
  await t.as('bob').post(`/api/projects/${p.id}/restore`, { version: 3 });
  const items = (await a.get(`/api/activity?item_id=${p.id}`)).body.items;
  assert.deepEqual(items.map((e) => e.action), ['restore', 'trash', 'update', 'create']);
  assert.deepEqual(items[0].changes, {});
  assert.deepEqual(items[2].changes, {
    status: { from: 'Planned', to: 'Active' }, owner_id: { from: 'alice', to: 'bob' }, owner_name: { from: 'Alice Lin', to: 'Bob Ortiz' },
  });
  assert.deepEqual(items[3].changes, {
    name: { to: 'P' }, description: { to: '' }, status: { to: 'Planned' }, owner_id: { to: 'alice' }, owner_name: { to: 'Alice Lin' },
    private: { to: false }, tags: { to: ['web'] },
  });
  for (const e of items) {
    assert.equal(e.item_type, 'project'); assert.equal(e.item_title, 'P'); assert.equal(e.project_id, p.id);
    assert.equal(e.via, 'ui'); assert.equal(e.session_id, null);
  }
  assert.deepEqual(items.map((e) => e.actor_id), ['bob', 'bob', 'alice', 'alice']);
  const tagEntry = (await a.get(`/api/activity?item_type=tag`)).body.items[0];
  assert.equal(tagEntry.item_title, 'web');
  assert.deepEqual(tagEntry.changes, { name: { to: 'web' }, color: { to: '#000080' } });
  await t.close();
});

test('item_title follows renames; project_id is set for task entries', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'Old' })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p.id })).body;
  await a.patch(`/api/projects/${p.id}`, { version: 1, name: 'New' });
  const items = (await a.get('/api/activity')).body.items;
  assert.ok(items.filter((e) => e.item_id === p.id).every((e) => e.item_title === 'New'));
  const te = items.find((e) => e.item_id === task.id);
  assert.equal(te.project_id, p.id);
  assert.deepEqual((await a.get(`/api/activity?project=${p.id}`)).body.items.map((e) => e.item_id).sort(), [p.id, p.id, task.id].sort());
  await t.close();
});

test('keyset pagination is stable under equal timestamps and ends with a null cursor', async () => {
  const t = await createTestApp({ now: () => '2026-11-01T00:00:00.000Z' });
  const a = t.as('alice');
  for (let i = 0; i < 7; i++) await a.post('/api/tasks', { title: `T${i}` });
  const seen = [];
  let before;
  let pages = 0;
  for (;;) {
    const r = await a.get(`/api/activity?limit=3${before ? `&before=${before}` : ''}`);
    assert.equal(r.status, 200);
    seen.push(...r.body.items.map((e) => e.id));
    pages++;
    if (!r.body.next_cursor) break;
    before = r.body.next_cursor;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.equal((await a.get('/api/activity?before=%%%')).status, 400);
  assert.equal((await a.get('/api/activity?limit=500')).status, 400);
  assert.equal((await a.get('/api/activity?via=fax')).status, 400);
  await t.close();
});

test('filters: actor, via, item_type', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const { plaintext } = (await a.post('/api/tokens', { label: 'x' })).body;
  await a.post('/api/tasks', { title: 'ui task' });
  await t.tokenAs(plaintext, 's1').post('/api/tasks', { title: 'mcp task' });
  await t.as('bob').post('/api/projects', { name: 'bob project' });
  const q = async (qs) => (await a.get('/api/activity?' + qs)).body.items;
  assert.deepEqual((await q('via=mcp')).map((e) => e.item_title), ['mcp task']);
  assert.deepEqual((await q('actor=bob')).map((e) => e.item_title), ['bob project']);
  assert.deepEqual((await q('item_type=project')).map((e) => e.item_title), ['bob project']);
  assert.equal((await q('actor=alice')).length, 2);
  await t.close();
});
