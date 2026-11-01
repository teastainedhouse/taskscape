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

test('a request that changes nothing is not a write: version checked, not bumped, nothing logged', async () => {
  let clock = 0;
  const t = await createTestApp({ now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString() });
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'web' })).body;
  const p = (await a.post('/api/projects', { name: 'P', tag_ids: [tag.id] })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p.id, status: 'Doing' })).body;
  const entries = async (id) => (await a.get(`/api/activity?item_id=${id}`)).body.items.length;

  for (const [kind, item, same] of [['projects', p, { name: 'P', status: 'Planned', private: false }],
    ['tasks', task, { title: 'T', status: 'Doing', project_id: p.id, owner_id: 'alice', due_date: null }]]) {
    const path = `/api/${kind}/${item.id}`;
    const before = await entries(item.id);
    for (const r of [
      await a.patch(path, { version: 1, ...same }),
      await a.patch(path, { version: 1 }),
      kind === 'projects' ? await a.put(`${path}/tags/${tag.id}`, { version: 1 }) : await a.delete(`${path}/tags/${tag.id}`, { version: 1 }),
    ]) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.version, 1);
      assert.equal(r.body.updated_at, item.updated_at);
      assert.equal('moved_tasks' in r.body, false);
    }
    assert.equal(await entries(item.id), before, `${kind}: no activity for a no-op`);
    // a stale version on a no-op is still a conflict
    await a.patch(path, { version: 1, ...(kind === 'projects' ? { status: 'Active' } : { status: 'Done' }) });
    const stale = await a.patch(path, { version: 1, ...same });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 2);
    const staleTag = await a.put(`${path}/tags/${tag.id}`, { version: 1 });
    assert.equal(staleTag.status, 409);
    // the trash check still applies before the version check
    await a.delete(path, { version: 2 });
    const trashed = await a.patch(path, { version: 3 });
    assert.equal(trashed.status, 400);
    assert.equal(trashed.body.error.code, 'invalid_state');
    await a.post(`${path}/restore`, { version: 3 });
  }
  await t.close();
});

test('a no-op by a non-owner on a private item is still the generic 404, stale version or not', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const b = t.as('bob');
  const tag = (await a.post('/api/tags', { name: 'x' })).body;
  const open = (await a.post('/api/projects', { name: 'Open' })).body;
  const p = (await a.post('/api/projects', { name: 'P', private: true })).body;
  const privateTask = (await a.post('/api/tasks', { title: 'Mine', project_id: open.id, private: true })).body;
  const inPrivate = (await a.post('/api/tasks', { title: 'Inside', project_id: p.id })).body; // public task, private project
  const missing = (await b.patch('/api/projects/no-such-id', { version: 1 })).text;
  for (const [path, title] of [[`/api/projects/${p.id}`, { name: 'P' }], [`/api/tasks/${privateTask.id}`, { title: 'Mine' }],
    [`/api/tasks/${inPrivate.id}`, { title: 'Inside' }]]) {
    for (const r of [
      await b.patch(path, { version: 1 }),
      await b.patch(path, { version: 1, ...title }),
      await b.patch(path, { version: 7, ...title }), // stale
      await b.delete(`${path}/tags/${tag.id}`, { version: 1 }),
      await b.delete(`${path}/tags/${tag.id}`, { version: 7 }),
    ]) {
      assert.equal(r.status, 404, path);
      assert.equal(r.text, missing, path);
    }
  }
  await t.close();
});

test("the owner's name refresh alone is a logged write; alongside other changes it stays silent", async () => {
  const t = await createTestApp();
  const p = (await t.as('alice').post('/api/projects', { name: 'P', owner_id: 'bob', owner_name: 'Bobby' })).body;
  const r = await t.as('bob').patch(`/api/projects/${p.id}`, { version: 1 });
  assert.equal(r.body.version, 2);
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  const [entry] = (await t.as('bob').get(`/api/activity?item_id=${p.id}`)).body.items;
  assert.deepEqual(entry.changes, { owner_name: { from: 'Bobby', to: 'Bob Ortiz' } });
  await t.close();
});

test('error order: a non-owner privacy flip is 403 and an unknown tag 404, even with a stale version', async () => {
  const t = await createTestApp();
  const p = (await t.as('alice').post('/api/projects', { name: 'P' })).body;
  await t.as('alice').patch(`/api/projects/${p.id}`, { version: 1, status: 'Active' });
  assert.equal((await t.as('bob').patch(`/api/projects/${p.id}`, { version: 1, private: true })).status, 403);
  assert.equal((await t.as('bob').put(`/api/projects/${p.id}/tags/no-such-tag`, { version: 1 })).status, 404);
  assert.equal((await t.as('bob').patch(`/api/projects/${p.id}`, { version: 1, status: 'Done' })).status, 409);
  await t.close();
});
