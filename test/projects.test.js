import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('create project: defaults, shape, 201', async () => {
  const t = await createTestApp();
  const r = await t.as('alice').post('/api/projects', { name: '  Website refresh ' });
  assert.equal(r.status, 201);
  const p = r.body;
  assert.equal(p.name, 'Website refresh');
  assert.equal(p.status, 'Planned');
  assert.equal(p.owner_id, 'alice');
  assert.equal(p.owner_name, 'Alice Lin');
  assert.equal(p.private, false);
  assert.equal(p.version, 1);
  assert.equal(p.hit_count, 0);
  assert.equal(p.deleted_at, null);
  assert.deepEqual(p.tags, []);
  assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T/);
  const got = await t.as('bob').get(`/api/projects/${p.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, p);
  await t.close();
});

test('the catch-all project exists, is public, and is owned by the system', async () => {
  const t = await createTestApp();
  const r = await t.as('carol').get('/api/projects/general');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'General');
  assert.equal(r.body.owner_id, 'system');
  assert.equal(r.body.private, false);
  await t.close();
});

test('create project: validation errors name the field only', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/projects', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'validation_failed');
  assert.equal(r.body.error.details.fields.name, 'is required');
  r = await a.post('/api/projects', { name: 'X', status: 'Bogus Status Value' });
  assert.equal(r.body.error.details.fields.status, 'must be one of the configured project statuses');
  assert.equal(JSON.stringify(r.body).includes('Bogus'), false);
  r = await a.post('/api/projects', { name: 'X', hit_count: 5, version: 3, id: 'mine' });
  assert.deepEqual(r.body.error.details.fields, { id: 'read-only', hit_count: 'read-only', version: 'read-only' });
  r = await a.post('/api/projects', { name: 'X', private: 'yes' });
  assert.equal(r.body.error.details.fields.private, 'must be true or false');
  r = await a.post('/api/projects', { name: 'X', owner_id: 'bob' });
  assert.equal(r.body.error.details.fields.owner_name, 'is required when owner_id is someone else');
  r = await a.post('/api/projects', { name: 'X', owner_id: 'bob', owner_name: 'Bob Ortiz' });
  assert.equal(r.status, 201);
  assert.equal(r.body.owner_id, 'bob');
  r = await a.post('/api/projects', { name: 'X', tag_ids: ['nope'] });
  assert.equal(r.status, 404);
  await t.close();
});

test('list: filters, sorts, and paging', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const web = (await a.post('/api/tags', { name: 'Web' })).body;
  const p1 = (await a.post('/api/projects', { name: 'Zeta', status: 'Done', tag_ids: [web.id] })).body;
  const p2 = (await t.as('bob').post('/api/projects', { name: 'alpha', status: 'Active', description: 'Has 100% of the things' })).body;
  const p3 = (await a.post('/api/projects', { name: 'Mid', status: 'On hold' })).body;

  let r = await a.get('/api/projects');
  assert.deepEqual(r.body.items.map((p) => p.name), ['Mid', 'alpha', 'Zeta', 'General']); // updated_at desc
  assert.equal(r.body.limit, 500);
  r = await a.get('/api/projects?sort=name');
  assert.deepEqual(r.body.items.map((p) => p.name), ['alpha', 'General', 'Mid', 'Zeta']); // asc default for name
  r = await a.get('/api/projects?sort=status&dir=asc');
  assert.deepEqual(r.body.items.map((p) => p.status), ['Active', 'Active', 'On hold', 'Done']); // config order
  r = await a.get('/api/projects?status=Done,On hold,Unknown');
  assert.deepEqual(r.body.items.map((p) => p.id).sort(), [p1.id, p3.id].sort());
  r = await a.get('/api/projects?owner=me');
  assert.deepEqual(r.body.items.map((p) => p.id).sort(), [p1.id, p3.id].sort());
  r = await a.get(`/api/projects?owner=bob`);
  assert.deepEqual(r.body.items.map((p) => p.id), [p2.id]);
  r = await a.get('/api/projects?tag=WEB');
  assert.deepEqual(r.body.items.map((p) => p.id), [p1.id]);
  r = await a.get('/api/projects?q=ALPHA');
  assert.deepEqual(r.body.items.map((p) => p.id), [p2.id]);
  r = await a.get('/api/projects?q=100%25');
  assert.deepEqual(r.body.items.map((p) => p.id), [p2.id]);
  r = await a.get('/api/projects?q=_'); // underscore is literal, matches nothing
  assert.deepEqual(r.body.items, []);
  r = await a.get('/api/projects?sort=name&limit=2&offset=1');
  assert.deepEqual(r.body.items.map((p) => p.name), ['General', 'Mid']);
  for (const bad of ['sort=hit_count', 'dir=sideways', 'include_trashed=maybe', 'limit=0', 'limit=5000', 'offset=-1']) {
    const b = await a.get('/api/projects?' + bad);
    assert.equal(b.status, 400, bad);
  }
  await t.close();
});

test('patch: changes fields, bumps version, logs only what changed', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  let r = await a.patch(`/api/projects/${p.id}`, { version: 1, status: 'Active', description: 'd' });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 2);
  assert.equal(r.body.status, 'Active');
  assert.equal(r.body.description, 'd');
  assert.equal(r.body.moved_tasks, undefined);
  r = await a.patch(`/api/projects/${p.id}`, { version: 2, name: '' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.fields.name, 'must not be empty');
  r = await a.patch(`/api/projects/${p.id}`, { version: 2, tag_ids: [] });
  assert.equal(r.body.error.details.fields.tag_ids, 'use the tag routes to change tags');
  const act = (await a.get(`/api/activity?item_id=${p.id}`)).body.items;
  assert.deepEqual(act.map((e) => e.action), ['update', 'create']);
  assert.deepEqual(act[0].changes, { description: { from: '', to: 'd' }, status: { from: 'Planned', to: 'Active' } });
  await t.close();
});

test('owner display name is refreshed silently when the owner edits their own item', async () => {
  const t = await createTestApp({ config: { auth: { provider: 'headers' } } });
  const u1 = (name) => t.withHeaders({ 'x-forwarded-user': 'u1', 'x-forwarded-preferred-username': name });
  const p = (await u1('Dana').post('/api/projects', { name: 'P' })).body;
  assert.equal(p.owner_name, 'Dana');
  const r = await u1('Dana Fox').patch(`/api/projects/${p.id}`, { version: 1, status: 'Active' });
  assert.equal(r.body.owner_name, 'Dana Fox');
  const act = (await u1('Dana Fox').get(`/api/activity?item_id=${p.id}`)).body.items;
  assert.deepEqual(Object.keys(act[0].changes), ['status']);
  // another editor's write does not rename the owner
  const other = t.withHeaders({ 'x-forwarded-user': 'u2', 'x-forwarded-preferred-username': 'Someone' });
  const r2 = await other.patch(`/api/projects/${p.id}`, { version: 2, status: 'Done' });
  assert.equal(r2.body.owner_name, 'Dana Fox');
  await t.close();
});

test('reassign: owner_name required for someone else; reassigning to yourself uses your name', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  let r = await a.patch(`/api/projects/${p.id}`, { version: 1, owner_id: 'bob' });
  assert.equal(r.status, 400);
  r = await a.patch(`/api/projects/${p.id}`, { version: 1, owner_id: 'bob', owner_name: 'Bobby' });
  assert.equal(r.body.owner_name, 'Bobby');
  r = await t.as('bob').patch(`/api/projects/${p.id}`, { version: 2, owner_id: 'bob', owner_name: 'ignored' });
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  await t.close();
});

test('people: visible owners, the caller, and dev users', async () => {
  const t = await createTestApp();
  await t.as('alice').post('/api/projects', { name: 'P', owner_id: 'dave', owner_name: 'Dave' });
  await t.as('alice').post('/api/projects', { name: 'S', owner_id: 'secret-owner', owner_name: 'Secret', private: false });
  const r = await t.as('bob').get('/api/people');
  assert.deepEqual(r.body.items.map((p) => p.id).sort(), ['alice', 'bob', 'carol', 'dave', 'secret-owner']);
  await t.close();
});
