import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { prepareConfig } from '../api/lib/config.js';
import * as users from '../api/lib/repo/users.js';
import * as tokens from '../api/lib/repo/tokens.js';

const headersApp = (extra = {}) => createTestApp({ config: { auth: { provider: 'headers', ...extra } } });

test('dev provider: header beats cookie beats default; unknown user is 401', async () => {
  const t = await createTestApp();
  assert.equal((await t.anon().get('/api/me')).body.id, 'alice'); // default
  assert.equal((await t.anon().get('/api/me', undefined, { cookie: 'taskscape_dev_user=bob' })).body.id, 'bob');
  assert.equal((await t.anon().get('/api/me', undefined, { cookie: 'taskscape_dev_user=bob', 'x-dev-user': 'carol' })).body.id, 'carol');
  assert.equal((await t.anon().get('/api/me', undefined, { 'x-dev-user': 'mallory' })).status, 401);
  await t.close();
});

test('dev provider refuses to run in production', async () => {
  await assert.rejects(createTestApp({ env: { TASKSCAPE_ENV: 'production' } }), /production/);
});

test('config: TASKSCAPE_ENV=production with dev provider throws at load', () => {
  const raw = { statuses: { project: ['A'], task: ['B'] }, closed_statuses: { project: [], task: [] },
    default_status: { project: 'A', task: 'B' }, tag_palette: ['#000000'], catch_all_project: { id: 'g', name: 'G' },
    permissions: { edit: 'everyone' }, auth: { provider: 'dev', dev: { default_user: 'a', users: [{ id: 'a', name: 'A' }] } } };
  assert.throws(() => prepareConfig(raw, { TASKSCAPE_ENV: 'production' }), /production/);
  assert.doesNotThrow(() => prepareConfig(raw, { TASKSCAPE_ENV: 'development' }));
  // env override of the provider
  const c = prepareConfig({ ...raw, auth: { ...raw.auth, headers: {} } }, { TASKSCAPE_ENV: 'production', TASKSCAPE_AUTH_PROVIDER: 'headers' });
  assert.equal(c.auth.provider, 'headers');
});

test('headers provider: plain headers', async () => {
  const t = await headersApp();
  const r = await t.withHeaders({
    'x-forwarded-user': 'u-123', 'x-forwarded-preferred-username': 'Dana Fox', 'x-forwarded-email': 'dana@example.test',
    'x-forwarded-groups': 'editors, staff',
  }).get('/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'u-123', name: 'Dana Fox', email: 'dana@example.test', auth: 'headers', can_edit: true, preferences: { theme: 'toolbar', comments_label: 'Comments', shortcuts: true, time_zone: 'UTC', chosen: { theme: false, comments_label: false, shortcuts: false, time_zone: false } }, today: new Date().toISOString().slice(0, 10) });
  const anon = await t.withHeaders({}).get('/api/me');
  assert.equal(anon.status, 401);
  const noId = await t.withHeaders({ 'x-forwarded-preferred-username': 'Ghost' }).get('/api/me');
  assert.equal(noId.status, 401);
  // the dev switch header is ignored under the headers provider
  const dev = await t.withHeaders({ 'x-dev-user': 'alice' }).get('/api/me');
  assert.equal(dev.status, 401);
  await t.close();
});

test('headers provider: base64 principal document with claims flattening', async () => {
  // a fork sets the paths to match its host's principal document; these are made-up names
  const t = await headersApp({ headers: { principal: 'x-sso-principal', id_path: 'sub', name_path: 'display_name',
    email_path: 'claims.email', groups_path: 'roles', claims_path: 'claims', claim_type_key: 'type', claim_value_key: 'value' } });
  const doc = {
    sub: 'u-777', display_name: 'Eve Park', roles: ['authenticated', 'editors'],
    claims: [{ type: 'email', value: 'eve@example.test' }, { type: 'name', value: 'Eve' }],
  };
  const r = await t.withHeaders({ 'x-sso-principal': Buffer.from(JSON.stringify(doc)).toString('base64') }).get('/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'u-777', name: 'Eve Park', email: 'eve@example.test', auth: 'headers', can_edit: true, preferences: { theme: 'toolbar', comments_label: 'Comments', shortcuts: true, time_zone: 'UTC', chosen: { theme: false, comments_label: false, shortcuts: false, time_zone: false } }, today: new Date().toISOString().slice(0, 10) });
  // garbage principal, no plain headers: 401
  assert.equal((await t.withHeaders({ 'x-sso-principal': '!!!' }).get('/api/me')).status, 401);
  // with a principal document configured, a client-supplied plain header is ignored
  const both = await t.withHeaders({
    'x-sso-principal': Buffer.from(JSON.stringify(doc)).toString('base64'), 'x-forwarded-user': 'u-override',
  }).get('/api/me');
  assert.equal(both.body.id, 'u-777');
  const onlyPlain = await t.withHeaders({ 'x-forwarded-user': 'u-override' }).get('/api/me');
  assert.equal(onlyPlain.status, 401);
  await t.close();
});

test('headers provider: group permissions come from the groups header', async () => {
  const t = await headersApp({}).then(async (t0) => { await t0.close(); return createTestApp({ config: {
    auth: { provider: 'headers' }, permissions: { edit: 'group', groups: ['taskscape-editors'] } } }); });
  const editor = await t.withHeaders({ 'x-forwarded-user': 'a', 'x-forwarded-groups': 'taskscape-editors' }).get('/api/me');
  assert.equal(editor.body.can_edit, true);
  const viewer = await t.withHeaders({ 'x-forwarded-user': 'b', 'x-forwarded-groups': 'other' }).get('/api/me');
  assert.equal(viewer.body.can_edit, false);
  await t.close();
});

test('bearer token present but invalid: 401, no fallback to the header provider', async () => {
  const t = await createTestApp();
  const r = await t.anon().get('/api/me', undefined, { authorization: 'Bearer tsk_not_a_real_token', 'x-dev-user': 'alice' });
  assert.equal(r.status, 401);
  for (const bad of ['Basic YWxpY2U6eA==', 'Bearer', 'Token tsk_x']) {
    const r2 = await t.anon().get('/api/me', undefined, { authorization: bad, 'x-dev-user': 'alice' });
    assert.equal(r2.status, 401, bad);
  }
  await t.close();
});

test('owner names: the directory name wins under dev and password; headers keeps requiring owner_name', async () => {
  const dev = await createTestApp();
  let r = await dev.as('alice').post('/api/tasks', { title: 'T', owner_id: 'bob' });
  assert.equal(r.status, 201);
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  r = await dev.as('alice').post('/api/tasks', { title: 'T', owner_id: 'bob', owner_name: 'Not Bob' });
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  r = await dev.as('alice').patch(`/api/tasks/${r.body.id}`, { version: 1, owner_id: 'carol', owner_name: 'Anyone' });
  assert.equal(r.body.owner_name, 'Carol Nkemelu');
  await dev.close();

  const pw = await createTestApp({ config: { auth: { provider: 'password' } } });
  const now = '2026-11-01T09:00:00.000Z';
  await users.create(pw.db, { id: 'dana', name: 'Dana Fox', groups: [] }, 'scrypt$x', now);
  await users.create(pw.db, { id: 'eli', name: 'Eli Moss', groups: [] }, 'scrypt$x', now);
  await users.disable(pw.db, 'eli', now);
  const { plaintext } = await tokens.issue(pw.db, { id: 'dana', name: 'Dana Fox', groups: [] }, 'test', now);
  const dana = pw.tokenAs(plaintext);
  await users.create(pw.db, { id: 'fay', name: 'Fay Quinn', groups: [] }, 'scrypt$x', now);
  r = await dana.post('/api/projects', { name: 'P', owner_id: 'fay', owner_name: 'Forged' });
  assert.equal(r.status, 201);
  assert.equal(r.body.owner_name, 'Fay Quinn');
  // nobody else can be named under password: not a disabled user, a look-alike id, or an id with no users row,
  // and the answers are identical, so a write cannot tell a disabled account from a made-up id
  const refused = [];
  for (const owner_id of ['eli', 'Fay', 'fay\u200b', 'fa%', 'legacy-id']) {
    r = await dana.post('/api/projects', { name: 'P', owner_id, owner_name: 'Fay Quinn' });
    assert.equal(r.status, 400, owner_id);
    refused.push(r.text);
  }
  assert.equal(new Set(refused).size, 1);
  assert.deepEqual(JSON.parse(refused[0]).error.details.fields, { owner_id: 'must be someone who can sign in' });
  await pw.close();

  const h = await createTestApp({ config: { auth: { provider: 'headers' } } });
  const u = h.withHeaders({ 'x-forwarded-user': 'u1', 'x-forwarded-preferred-username': 'Una' });
  assert.equal((await u.post('/api/tasks', { title: 'T', owner_id: 'bob' })).status, 400); // no directory, even for a dev user id
  assert.equal((await u.post('/api/tasks', { title: 'T', owner_id: 'bob', owner_name: 'Bob' })).body.owner_name, 'Bob');
  await h.close();
});

test('system is reserved: nobody can own an item as it or relabel the catch-all owner', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/tasks', { title: 'T', owner_id: 'system', owner_name: 'Taskscape' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.fields.owner_id, 'is reserved');
  r = await a.patch(`/api/projects/${t.catchAllId}`, { version: 1, owner_id: 'system', owner_name: 'Alice Lin' });
  assert.equal(r.status, 400);
  assert.equal((await a.get(`/api/projects/${t.catchAllId}`)).body.owner_name, 'Taskscape');
  await t.close();
});
