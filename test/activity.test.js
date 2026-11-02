import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, tickingClock } from './helpers.js';

test('one entry per write, with the documented change shapes', async () => {
  const t = await createTestApp({ now: tickingClock() });
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

test('actor= never bypasses visibility: my own entry about an item that went private to someone else is gone', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const b = t.as('bob');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p.id })).body;
  await b.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'Doing' });
  assert.equal((await b.get('/api/activity?actor=bob')).body.items.length, 1);
  await a.patch(`/api/projects/${p.id}`, { version: p.version, private: true });
  assert.equal((await b.get('/api/activity?actor=bob')).body.items.length, 0);
  assert.equal((await a.get('/api/activity?actor=bob')).body.items.length, 1, 'the owner still sees it');
  await t.close();
});

test('for=me: entries by others about the projects and tasks I own now', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const a = t.as('alice');
  const b = t.as('bob');
  const mine = (await a.post('/api/projects', { name: 'Mine' })).body;
  const task = (await a.post('/api/tasks', { title: 'My task', project_id: mine.id })).body;
  const given = (await b.post('/api/tasks', { title: 'Handed over' })).body;
  const kept = (await b.post('/api/tasks', { title: 'Bob keeps' })).body;
  await b.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'Doing' }); // bob on my task: counts
  await b.patch(`/api/projects/${mine.id}`, { version: mine.version, description: 'bob was here' }); // on my project: counts
  await b.patch(`/api/tasks/${given.id}`, { version: given.version, owner_id: 'alice' }); // now mine: counts, with its history
  await b.patch(`/api/tasks/${kept.id}`, { version: kept.version, status: 'Doing' }); // not mine: no
  await a.patch(`/api/tasks/${task.id}`, { version: task.version + 1, title: 'My task, renamed' }); // by me: no
  await b.post('/api/tags', { name: 'shiny' }); // tags belong to nobody: no
  const forMe = (await a.get('/api/activity?for=me')).body;
  assert.deepEqual(forMe.items.map((e) => [e.actor_id, e.item_title, e.action]), [
    ['bob', 'Handed over', 'update'],
    ['bob', 'Mine', 'update'],
    ['bob', 'My task, renamed', 'update'],
    ['bob', 'Handed over', 'create'],
  ]);
  assert.equal(forMe.next_cursor, null);
  // it pages with the cursor and combines with the other filters
  const p1 = (await a.get('/api/activity?for=me&limit=3')).body;
  const p2 = (await a.get(`/api/activity?for=me&limit=3&before=${p1.next_cursor}`)).body;
  assert.deepEqual([...p1.items, ...p2.items].map((e) => e.id), forMe.items.map((e) => e.id));
  assert.deepEqual((await a.get('/api/activity?for=me&item_type=project')).body.items.map((e) => e.item_title), ['Mine']);
  // giving a task away takes its entries with it
  const g = (await a.get(`/api/tasks/${given.id}`)).body;
  await a.patch(`/api/tasks/${g.id}`, { version: g.version, owner_id: 'carol' });
  assert.equal((await a.get('/api/activity?for=me')).body.items.some((e) => e.item_id === given.id), false);
  assert.equal((await t.as('carol').get('/api/activity?for=me')).body.items.filter((e) => e.item_id === given.id).length, 3);
  // only "me"; the details name the field and not the value
  const r = await a.get('/api/activity?for=bob');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.error.details, { fields: { for: 'must be me' } });
  assert.equal(JSON.stringify(r.body).includes('bob'), false);
  await t.close();
});
