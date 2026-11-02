import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY } from './helpers.js';

test('health is unauthenticated; everything else needs a principal', async () => {
  const t = await createTestApp();
  const h = await t.anon().get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, { ok: true });
  const me = await t.anon().get('/api/me', undefined, { 'x-dev-user': 'nobody' });
  assert.equal(me.status, 401);
  assert.equal(me.body.error.code, 'unauthorized');
  assert.equal(me.headers.get('www-authenticate'), 'Bearer realm="taskscape"');
  await t.close();
});

test('every response carries no-store and nosniff, and errors are JSON envelopes', async () => {
  const t = await createTestApp();
  for (const r of [await t.anon().get('/api/health'), await t.as('alice').get('/api/nope'), await t.anon().get('/api/me', undefined, { 'x-dev-user': 'x' })]) {
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.ok(!/text\/html/.test(r.headers.get('content-type')));
  }
  await t.close();
});

test('unknown route is the generic 404; wrong method is 405 with Allow', async () => {
  const t = await createTestApp();
  const nf = await t.as('alice').get('/api/does-not-exist');
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.body, NOT_FOUND_BODY);
  const mna = await t.anon().post('/api/health', {});
  assert.equal(mna.status, 405);
  assert.equal(mna.body.error.code, 'method_not_allowed');
  assert.equal(mna.headers.get('allow'), 'GET');
  await t.close();
});

test('me reports identity and edit rights; config is the public subset only', async () => {
  const t = await createTestApp();
  const me = await t.as('bob').get('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { id: 'bob', name: 'Bob Ortiz', email: 'bob@example.test', auth: 'dev', can_edit: true, preferences: { theme: 'toolbar', comments_label: 'Comments', shortcuts: true, time_zone: 'UTC' } });
  const cfg = await t.as('bob').get('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.catch_all_project_id, 'general');
  assert.equal(cfg.body.auth.provider, 'dev');
  assert.deepEqual(cfg.body.auth.dev_users.map((u) => u.id), ['alice', 'bob', 'carol']);
  assert.equal(JSON.stringify(cfg.body).includes('x-forwarded'), false);
  assert.equal(cfg.body.auth.headers, undefined);
  assert.deepEqual(cfg.body.limits, { page_size: 500, max_page_size: 1000, body_bytes: 262144 });
  assert.equal(cfg.body.theme, 'toolbar');
  assert.deepEqual(cfg.body.themes, ['toolbar', 'netscape']);
  assert.deepEqual(cfg.body.preference_defaults, { comments_label: 'Comments', shortcuts: true, time_zone: 'UTC' });
  await t.close();
});

test('group permissions: non-members are read-only', async () => {
  const t = await createTestApp({
    config: {
      permissions: { edit: 'group', groups: ['editors'] },
      auth: { dev: { users: [
        { id: 'alice', name: 'Alice Lin', groups: ['editors'] },
        { id: 'zed', name: 'Zed', groups: ['viewers'] },
      ] } },
    },
  });
  assert.equal((await t.as('alice').get('/api/me')).body.can_edit, true);
  assert.equal((await t.as('zed').get('/api/me')).body.can_edit, false);
  await t.close();
});

test('unexpected errors become a generic 500 envelope and are logged', async () => {
  const t = await createTestApp();
  // Break the db under the router to force a throw inside a handler path.
  t.db.query = async () => { throw new Error('db exploded: secret detail'); };
  const r = await t.tokenAs('tsk_whatever').get('/api/me');
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'internal');
  assert.equal(JSON.stringify(r.body).includes('secret'), false);
  assert.equal(t.errors.length, 1);
  await t.close();
});

test('bodies: malformed JSON is 400, arrays are 400, oversized is 413', async () => {
  const t = await createTestApp({ config: { limits: { body_bytes: 200 } } });
  const bad = await t.as('alice').post('/api/projects', '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details.fields.body, 'must be valid JSON');
  const arr = await t.as('alice').post('/api/projects', '[1,2]');
  assert.equal(arr.status, 400);
  const big = await t.as('alice').post('/api/projects', { name: 'x'.repeat(500) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'payload_too_large');
  // a chunked body with no Content-Length is cut off at the limit too
  const chunks = Array.from({ length: 20 }, () => new Uint8Array(70_000).fill(97));
  const stream = new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } });
  const res = await t.app.fetch(new Request('http://test/api/projects', {
    method: 'POST', headers: { 'x-dev-user': 'alice', 'content-type': 'application/json' }, body: stream, duplex: 'half' }));
  assert.equal(res.status, 413);
  assert.ok(chunks.length > 0, 'the stream was cancelled before it was fully read');
  await t.close();
});

test('a malformed percent-escape in a path is the generic 404, not a 500', async () => {
  const t = await createTestApp();
  const r = await t.as('alice').get('/api/projects/%E0%A4%A');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, NOT_FOUND_BODY);
  assert.equal(t.errors.length, 0);
  await t.close();
});
