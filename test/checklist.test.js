// checklist.test.js — checklist items on a task: add, rename, tick, untick,
// reorder and trash, each a compare-and-set on the task with an activity
// entry; visible exactly when the task is; in search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY } from './helpers.js';

test('add, rename, tick, untick, move and trash, each on the task version with an entry', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'Launch' })).body;
  assert.deepEqual(task.checklist, []);
  let r = await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: '  Write copy ' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.checklist.map((c) => [c.text, c.done, c.position]), [['Write copy', false, 0]]);
  r = await a.post(`/api/tasks/${task.id}/checklist`, { version: r.body.version, text: 'Ship it' });
  r = await a.post(`/api/tasks/${task.id}/checklist`, { version: r.body.version, text: 'Tell people' });
  const [one, two, three] = r.body.checklist;
  r = await a.patch(`/api/tasks/${task.id}/checklist/${one.id}`, { version: r.body.version, done: true });
  assert.equal(r.body.checklist[0].done, true);
  const v = r.body.version;
  // ticking an item that is already ticked is not a write
  r = await a.patch(`/api/tasks/${task.id}/checklist/${one.id}`, { version: v, done: true });
  assert.equal(r.body.version, v);
  r = await a.patch(`/api/tasks/${task.id}/checklist/${one.id}`, { version: v, done: false, text: 'Write the copy' });
  assert.deepEqual([r.body.checklist[0].text, r.body.checklist[0].done], ['Write the copy', false]);
  r = await a.patch(`/api/tasks/${task.id}/checklist/${three.id}`, { version: r.body.version, position: 0 });
  assert.deepEqual(r.body.checklist.map((c) => c.id), [three.id, one.id, two.id]);
  r = await a.delete(`/api/tasks/${task.id}/checklist/${one.id}`, { version: r.body.version });
  assert.deepEqual(r.body.checklist.map((c) => [c.id, c.position]), [[three.id, 0], [two.id, 1]]);
  assert.ok((await t.db.query('SELECT deleted_at FROM task_checklist_items WHERE id = ?', [one.id])).rows[0].deleted_at, 'trashed, not deleted');
  assert.equal((await a.patch(`/api/tasks/${task.id}/checklist/${one.id}`, { version: r.body.version, done: true })).status, 404);
  // a stale version is a 409 with the current task
  const stale = await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: 'late' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.checklist.length, 2);
  const acts = (await a.get(`/api/activity?item_type=task&item_id=${task.id}`)).body.items.map((x) => x.changes);
  assert.deepEqual(acts[0], { checklist_item: { from: { text: 'Write the copy', done: false }, to: null } });
  assert.ok(acts.some((c) => c.checklist_moved?.to === 0));
  assert.ok(acts.some((c) => c.checklist_item?.from?.done === false && c.checklist_item?.to?.done === true));
  await t.close();
});

test('validation: one line, 1 to 500 characters, booleans only, position on PATCH only, 100 items at most', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  for (const [body, field] of [
    [{ text: '' }, 'text'], [{ text: '   ' }, 'text'], [{ text: 'a\nb' }, 'text'], [{ text: 'a\u2028b' }, 'text'], [{ text: 'a\u202Eb' }, 'text'], [{ text: 'x'.repeat(501) }, 'text'], [{ text: 5 }, 'text'],
    [{ text: 'ok', position: 1 }, 'position'], [{ text: 'ok', done: true }, 'done'], [{ text: 'ok', extra: 1 }, 'body'],
  ]) {
    const r = await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(field in r.body.error.details.fields, JSON.stringify(r.body));
  }
  const item = (await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: 'ok' })).body;
  let r = await a.patch(`/api/tasks/${task.id}/checklist/${item.checklist[0].id}`, { version: item.version, done: 'yes' });
  assert.deepEqual(r.body.error.details.fields, { done: 'must be true or false' });
  let v = item.version;
  for (let i = 1; i < 100; i++) v = (await a.post(`/api/tasks/${task.id}/checklist`, { version: v, text: `step ${i}` })).body.version;
  r = await a.post(`/api/tasks/${task.id}/checklist`, { version: v, text: 'one too many' });
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('privacy: a private task\'s checklist is the generic 404 to others, and stays out of their search', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const b = t.as('bob');
  const hidden = (await a.post('/api/tasks', { title: 'Mine', private: true })).body;
  const r = await a.post(`/api/tasks/${hidden.id}/checklist`, { version: hidden.version, text: 'call the lawyer' });
  const itemId = r.body.checklist[0].id;
  for (const [method, path, body] of [
    ['post', `/api/tasks/${hidden.id}/checklist`, { version: r.body.version, text: 'x' }],
    ['patch', `/api/tasks/${hidden.id}/checklist/${itemId}`, { version: r.body.version, done: true }],
    ['delete', `/api/tasks/${hidden.id}/checklist/${itemId}`, { version: r.body.version }],
  ]) {
    const res = await b[method](path, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND_BODY);
  }
  assert.equal((await a.get('/api/search?q=lawyer')).body.tasks.length, 1);
  assert.equal((await b.get('/api/search?q=lawyer')).body.tasks.length, 0);
  assert.equal(JSON.stringify((await b.get('/api/activity')).body).includes('lawyer'), false);
  // an item id from another task is not found on this one
  const mine = (await b.post('/api/tasks', { title: 'Bob' })).body;
  assert.equal((await b.patch(`/api/tasks/${mine.id}/checklist/${itemId}`, { version: mine.version, done: true })).status, 404);
  await t.close();
});

test('privacy: items inside a private project, and items written while public, follow the task\'s visibility now', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const b = t.as('bob');
  const p = (await a.post('/api/projects', { name: 'Mine', private: true })).body;
  const inPrivate = (await a.post('/api/tasks', { title: 'Inside', project_id: p.id })).body;
  await a.post(`/api/tasks/${inPrivate.id}/checklist`, { version: inPrivate.version, text: 'zebra crossing' });
  assert.equal((await b.get('/api/search?q=zebra')).body.tasks.length, 0);
  assert.equal((await b.patch(`/api/tasks/${inPrivate.id}/checklist/x`, { version: 1, done: true })).status, 404);
  // written while public, then hidden: the entries go with the task
  const pub = (await a.post('/api/tasks', { title: 'Was public' })).body;
  const r = await b.post(`/api/tasks/${pub.id}/checklist`, { version: pub.version, text: 'okapi' });
  assert.ok(JSON.stringify((await b.get('/api/activity')).body).includes('okapi'));
  await a.patch(`/api/tasks/${pub.id}`, { version: r.body.version, private: true });
  assert.equal(JSON.stringify((await b.get('/api/activity')).body).includes('okapi'), false);
  assert.equal((await b.get('/api/search?q=okapi')).body.tasks.length, 0);
  await t.close();
});

test('a trashed task takes no checklist writes; a read-only account gets 403; a position past the end means last', async () => {
  const t = await createTestApp({ config: { permissions: { edit: 'group', groups: ['editors'] }, auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'rita', name: 'Rita Read', groups: [] }] } } } });
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T' })).body;
  let r = await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: 'one' });
  r = await a.post(`/api/tasks/${task.id}/checklist`, { version: r.body.version, text: 'two' });
  const first = r.body.checklist[0];
  r = await a.patch(`/api/tasks/${task.id}/checklist/${first.id}`, { version: r.body.version, position: 42 });
  assert.deepEqual(r.body.checklist.map((c) => c.text), ['two', 'one']);
  const same = await a.patch(`/api/tasks/${task.id}/checklist/${first.id}`, { version: r.body.version });
  assert.equal(same.body.version, r.body.version, 'a PATCH with only the version writes nothing');
  assert.equal((await t.as('rita').post(`/api/tasks/${task.id}/checklist`, { version: r.body.version, text: 'x' })).status, 403);
  const trashed = (await a.delete(`/api/tasks/${task.id}`, { version: r.body.version })).body;
  r = await a.patch(`/api/tasks/${task.id}/checklist/${first.id}`, { version: trashed.version, done: true });
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});
