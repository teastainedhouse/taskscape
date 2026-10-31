import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { _resetTouchCache } from '../api/lib/auth/tokens.js';

test('issue shows the plaintext once; list shows the prefix only; the DB holds a hash', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const r = await a.post('/api/tokens', { label: 'laptop' });
  assert.equal(r.status, 201);
  assert.match(r.body.plaintext, /^tsk_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.token.label, 'laptop');
  assert.equal(r.body.token.token_prefix, r.body.plaintext.slice(0, 12));
  assert.equal(r.body.token.revoked_at, null);
  const list = (await a.get('/api/tokens')).body.items;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes(r.body.plaintext), false);
  assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'id', 'label', 'last_used_at', 'revoked_at', 'token_prefix']);
  const { rows } = await t.db.query('SELECT token_hash FROM mcp_tokens');
  assert.equal(rows.length, 1);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].token_hash, r.body.plaintext);
  assert.equal((await t.as('bob').get('/api/tokens')).body.items.length, 0);
  assert.equal((await a.post('/api/tokens', {})).status, 400);
  await t.close();
});

test('a token acts as its user via mcp, records the session id, and must send one on writes', async () => {
  const t = await createTestApp();
  const { plaintext } = (await t.as('alice').post('/api/tokens', { label: 'cli' })).body;
  const me = await t.tokenAs(plaintext, 'sess-42').get('/api/me');
  assert.deepEqual(me.body, { id: 'alice', name: 'Alice Lin', email: 'alice@example.test', auth: 'token', can_edit: true });
  const created = await t.tokenAs(plaintext, 'sess-42').post('/api/tasks', { title: 'From Claude' });
  assert.equal(created.status, 201);
  const act = (await t.as('alice').get(`/api/activity?item_id=${created.body.id}`)).body.items[0];
  assert.equal(act.via, 'mcp');
  assert.equal(act.session_id, 'sess-42');
  assert.equal(act.actor_id, 'alice');
  const noSession = await t.tokenAs(plaintext, null).post('/api/tasks', { title: 'x' });
  assert.equal(noSession.status, 400);
  assert.ok(noSession.body.error.details.fields['X-Taskscape-Session']);
  const readOk = await t.tokenAs(plaintext, null).get('/api/tasks');
  assert.equal(readOk.status, 200);
  await t.close();
});

test('revoked tokens are 401; revocation is idempotent and scoped to the owner', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const { token, plaintext } = (await a.post('/api/tokens', { label: 'cli' })).body;
  const bobTries = await t.as('bob').delete(`/api/tokens/${token.id}`);
  assert.equal(bobTries.status, 404);
  assert.equal((await t.tokenAs(plaintext).get('/api/me')).status, 200);
  const rev = await a.delete(`/api/tokens/${token.id}`);
  assert.equal(rev.status, 200);
  assert.ok(rev.body.revoked_at);
  assert.equal((await t.tokenAs(plaintext).get('/api/me')).status, 401);
  const again = await a.delete(`/api/tokens/${token.id}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.revoked_at, rev.body.revoked_at);
  assert.equal((await a.get('/api/tokens')).body.items[0].revoked_at, rev.body.revoked_at);
  await t.close();
});

test('token principals cannot touch the token routes', async () => {
  const t = await createTestApp();
  const { plaintext, token } = (await t.as('alice').post('/api/tokens', { label: 'cli' })).body;
  const tok = t.tokenAs(plaintext);
  assert.equal((await tok.get('/api/tokens')).status, 403);
  assert.equal((await tok.post('/api/tokens', { label: 'escalate' })).status, 403);
  assert.equal((await tok.delete(`/api/tokens/${token.id}`)).status, 403);
  await t.close();
});

test('last_used_at is recorded at most once a minute', async () => {
  _resetTouchCache();
  let clock = Date.parse('2026-11-01T10:00:00Z');
  const t = await createTestApp({ now: () => new Date(clock).toISOString() });
  const a = t.as('alice');
  const { plaintext, token } = (await a.post('/api/tokens', { label: 'cli' })).body;
  const lastUsed = async () => (await a.get('/api/tokens')).body.items.find((x) => x.id === token.id).last_used_at;
  await t.tokenAs(plaintext).get('/api/me');
  assert.equal(await lastUsed(), '2026-11-01T10:00:00.000Z');
  clock += 10_000;
  await t.tokenAs(plaintext).get('/api/me');
  assert.equal(await lastUsed(), '2026-11-01T10:00:00.000Z');
  clock += 60_000;
  await t.tokenAs(plaintext).get('/api/me');
  assert.equal(await lastUsed(), '2026-11-01T10:01:10.000Z');
  await t.close();
});

test('a token\'s rights follow the groups it was issued with; a demoted user can still revoke', async () => {
  const t = await createTestApp({ config: { permissions: { edit: 'group', groups: ['editors'] },
    auth: { dev: { users: [{ id: 'alice', name: 'Alice Lin', groups: ['editors'] }] } } } });
  const { plaintext, token } = (await t.as('alice').post('/api/tokens', { label: 'cli' })).body;
  assert.equal((await t.tokenAs(plaintext).post('/api/tasks', { title: 'ok' })).status, 201);
  t.config.permissions.groups = ['admins']; // alice is no longer an editor
  assert.equal((await t.as('alice').get('/api/me')).body.can_edit, false);
  assert.equal((await t.tokenAs(plaintext).get('/api/me')).body.can_edit, false);
  assert.equal((await t.tokenAs(plaintext).post('/api/tasks', { title: 'nope' })).status, 403);
  const rev = await t.as('alice').delete(`/api/tokens/${token.id}`);
  assert.equal(rev.status, 200);
  assert.equal((await t.tokenAs(plaintext).get('/api/me')).status, 401);
  assert.equal((await t.as('alice').post('/api/tokens', { label: 'again' })).status, 403);
  await t.close();
});

test('issuing a token requires edit rights', async () => {
  const t = await createTestApp({ config: { permissions: { edit: 'group', groups: ['editors'] },
    auth: { dev: { users: [{ id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'zed', name: 'Zed', groups: [] }] } } } });
  assert.equal((await t.as('zed').post('/api/tokens', { label: 'x' })).status, 403);
  assert.equal((await t.as('alice').post('/api/tokens', { label: 'x' })).status, 201);
  await t.close();
});
