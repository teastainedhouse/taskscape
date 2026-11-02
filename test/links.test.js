// links.test.js — labelled web links on a task: http(s) only, versioned on the
// task with an activity entry, removed by trashing, visible exactly when the
// task is, in search, and never fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY } from './helpers.js';

async function setup() {
  const t = await createTestApp();
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'Write spec' })).body;
  return { t, a, task };
}

test('add, rename, move and remove: each a compare-and-set on the task with an activity entry', async () => {
  const { t, a, task } = await setup();
  assert.deepEqual(task.links, []);
  let r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/spec', label: '  The spec ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.version, task.version + 1);
  assert.equal(r.body.links.length, 1);
  const first = r.body.links[0];
  assert.deepEqual({ url: first.url, label: first.label, position: first.position }, { url: 'https://example.test/spec', label: 'The spec', position: 0 });
  r = await a.post(`/api/tasks/${task.id}/links`, { version: r.body.version, url: 'http://example.test/a b<c>' });
  assert.equal(r.body.links[1].url, 'http://example.test/a%20b%3Cc%3E', 'stored as the URL parser writes it');
  assert.equal(r.body.links[1].label, null);
  const second = r.body.links[1];
  // a stale version is a 409 with the current task, and nothing is written
  const stale = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/x' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.links.length, 2);
  // rename
  r = await a.patch(`/api/tasks/${task.id}/links/${first.id}`, { version: r.body.version, label: 'Spec v2' });
  assert.equal(r.body.links[0].label, 'Spec v2');
  // a change that changes nothing is not a write
  const same = await a.patch(`/api/tasks/${task.id}/links/${first.id}`, { version: r.body.version, label: 'Spec v2', position: 0 });
  assert.equal(same.body.version, r.body.version);
  // move the second up to the top
  r = await a.patch(`/api/tasks/${task.id}/links/${second.id}`, { version: r.body.version, position: 0 });
  assert.deepEqual(r.body.links.map((l) => [l.id, l.position]), [[second.id, 0], [first.id, 1]]);
  // a position past the end means the end
  r = await a.patch(`/api/tasks/${task.id}/links/${second.id}`, { version: r.body.version, position: 99 });
  assert.deepEqual(r.body.links.map((l) => l.id), [first.id, second.id]);
  // remove: trashed, not deleted; positions close up
  r = await a.delete(`/api/tasks/${task.id}/links/${first.id}`, { version: r.body.version });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.links.map((l) => [l.id, l.position]), [[second.id, 0]]);
  const { rows } = await t.db.query('SELECT deleted_at FROM task_links WHERE id = ?', [first.id]);
  assert.ok(rows[0].deleted_at, 'the row stays, with deleted_at');
  // a removed link cannot be changed or removed again
  assert.equal((await a.patch(`/api/tasks/${task.id}/links/${first.id}`, { version: r.body.version, label: 'x' })).status, 404);
  assert.equal((await a.delete(`/api/tasks/${task.id}/links/${first.id}`, { version: r.body.version })).status, 404);
  const acts = (await a.get(`/api/activity?item_type=task&item_id=${task.id}`)).body.items.map((x) => x.changes);
  assert.deepEqual(acts[0], { link: { from: { url: 'https://example.test/spec', label: 'Spec v2' }, to: null } });
  assert.ok(acts.some((c) => c.link_moved?.to === 0));
  assert.ok(acts.some((c) => c.link?.from?.label === 'The spec' && c.link?.to?.label === 'Spec v2'));
  assert.ok(acts.some((c) => c.link?.from === null && c.link?.to?.url === 'https://example.test/spec'));
  await t.close();
});

test('only http and https URLs, within the limits; the error never echoes the value', async () => {
  const { t, a, task } = await setup();
  const bad = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://example.test/', 'mailto:a@example.test',
    'https://user:pw@example.test/', '//example.test/x', 'example.test', '', '   ', 'https://example.test/' + 'a'.repeat(2001), 'https://exa\nmple.test/', 42, null];
  for (const url of bad) {
    const r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url });
    assert.equal(r.status, 400, String(url).slice(0, 40));
    assert.deepEqual(Object.keys(r.body.error.details.fields), ['url']);
    if (typeof url === 'string' && url.trim()) assert.equal(JSON.stringify(r.body).includes(url.slice(0, 12)), false, 'not echoed');
  }
  let r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/', label: 'two\nlines' });
  assert.deepEqual(r.body.error.details.fields, { label: 'must be one line of at most 200 characters without control characters, or null' });
  r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/', label: 'safe\u202Egpj.exe' });
  assert.equal(r.status, 400, 'bidi overrides could make a label read as something else');
  r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/', label: 'x'.repeat(201) });
  assert.equal(r.status, 400);
  r = await a.post(`/api/tasks/${task.id}/links`, { url: 'https://example.test/' });
  assert.deepEqual(r.body.error.details.fields, { version: 'is required and must be a positive integer' });
  r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/', position: 0 });
  assert.equal(r.status, 400, 'position only on PATCH');
  r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/', fetch: true });
  assert.deepEqual(r.body.error.details.fields, { body: 'has a key that is not a link field' });
  // the cap: 50 live links
  let v = task.version;
  for (let i = 0; i < 50; i++) v = (await a.post(`/api/tasks/${task.id}/links`, { version: v, url: `https://example.test/${i}` })).body.version;
  r = await a.post(`/api/tasks/${task.id}/links`, { version: v, url: 'https://example.test/51' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('privacy: links on a private task are the generic 404 to everyone else, in reads, writes, lists and search', async () => {
  const { t, a } = await setup();
  const b = t.as('bob');
  const hidden = (await a.post('/api/tasks', { title: 'Secret', private: true })).body;
  const r1 = await a.post(`/api/tasks/${hidden.id}/links`, { version: hidden.version, url: 'https://example.test/payroll', label: 'payroll sheet' });
  const linkId = r1.body.links[0].id;
  for (const [method, path, body] of [
    ['post', `/api/tasks/${hidden.id}/links`, { version: r1.body.version, url: 'https://example.test/x' }],
    ['patch', `/api/tasks/${hidden.id}/links/${linkId}`, { version: r1.body.version, label: 'mine now' }],
    ['delete', `/api/tasks/${hidden.id}/links/${linkId}`, { version: r1.body.version }],
    ['patch', `/api/tasks/missing/links/${linkId}`, { version: 1, label: 'x' }],
  ]) {
    const r = await b[method](path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.body, NOT_FOUND_BODY);
  }
  // a link id from another task is not found on this one
  const mine = (await b.post('/api/tasks', { title: 'Bob task' })).body;
  assert.equal((await b.patch(`/api/tasks/${mine.id}/links/${linkId}`, { version: mine.version, label: 'x' })).status, 404);
  // search finds a link's label or URL for the owner only
  assert.equal((await a.get('/api/search?q=payroll')).body.tasks.length, 1);
  assert.equal((await b.get('/api/search?q=payroll')).body.tasks.length, 0);
  assert.equal((await b.get('/api/tasks?q=payroll')).body.items.length, 0);
  assert.equal(JSON.stringify((await b.get('/api/activity')).body).includes('payroll'), false);
  // a trashed link is not searchable
  await a.delete(`/api/tasks/${hidden.id}/links/${linkId}`, { version: r1.body.version });
  assert.equal((await a.get('/api/search?q=payroll')).body.tasks.length, 0);
  await t.close();
});

test('a trashed task takes no link changes; a token write needs the session header like any write', async () => {
  const { t, a, task } = await setup();
  const trashed = (await a.delete(`/api/tasks/${task.id}`, { version: task.version })).body;
  const r = await a.post(`/api/tasks/${task.id}/links`, { version: trashed.version, url: 'https://example.test/' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  // cross-site from a browser principal is refused like any write
  const cross = await a.post(`/api/tasks/${task.id}/links`, { version: trashed.version, url: 'https://example.test/' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  await t.close();
});

test('a read-only account gets 403 on every link route; a token needs the session header; a handover returns the links', async () => {
  const t = await createTestApp({ config: { permissions: { edit: 'group', groups: ['editors'] }, auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] }, { id: 'rita', name: 'Rita Read', groups: [] }] } } } });
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'T', private: true })).body;
  let r = await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/' });
  const linkId = r.body.links[0].id;
  const v = r.body.version;
  const pub = (await a.post('/api/tasks', { title: 'Public' })).body;
  const rita = t.as('rita');
  assert.equal((await rita.post(`/api/tasks/${pub.id}/links`, { version: pub.version, url: 'https://example.test/' })).status, 403);
  assert.equal((await rita.patch(`/api/tasks/${pub.id}/links/x`, { version: pub.version, label: 'x' })).status, 403);
  assert.equal((await rita.delete(`/api/tasks/${pub.id}/links/x`, { version: pub.version })).status, 403);
  // a token write without X-Taskscape-Session is a 400, like any token write
  const plain = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  r = await t.tokenAs(plain, null).post(`/api/tasks/${task.id}/links`, { version: v, url: 'https://example.test/2' });
  assert.equal(r.status, 400);
  r = await t.tokenAs(plain).post(`/api/tasks/${task.id}/links`, { version: v, url: 'https://example.test/2' });
  assert.equal(r.status, 201);
  // handing the private task to bob answers once with the record, links included
  r = await a.patch(`/api/tasks/${task.id}`, { version: r.body.version, owner_id: 'bob' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.links.map((l) => l.id).slice(0, 1), [linkId]);
  assert.equal(r.body.links.length, 2);
  assert.equal((await a.get(`/api/tasks/${task.id}`)).status, 404);
  await t.close();
});
