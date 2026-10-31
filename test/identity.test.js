import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { prepareConfig } from '../api/lib/config.js';

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
  assert.deepEqual(r.body, { id: 'u-123', name: 'Dana Fox', email: 'dana@example.test', auth: 'headers', can_edit: true });
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
  const t = await headersApp({ headers: { principal: 'x-sso-principal' } });
  const doc = {
    userId: 'u-777', userDetails: 'Eve Park', userRoles: ['authenticated', 'editors'],
    claims: [{ typ: 'email', val: 'eve@example.test' }, { typ: 'name', val: 'Eve' }],
  };
  const r = await t.withHeaders({ 'x-sso-principal': Buffer.from(JSON.stringify(doc)).toString('base64') }).get('/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'u-777', name: 'Eve Park', email: 'eve@example.test', auth: 'headers', can_edit: true });
  // garbage principal, no plain headers: 401
  assert.equal((await t.withHeaders({ 'x-sso-principal': '!!!' }).get('/api/me')).status, 401);
  // plain header wins over the document for a field it has
  const both = await t.withHeaders({
    'x-sso-principal': Buffer.from(JSON.stringify(doc)).toString('base64'), 'x-forwarded-user': 'u-override',
  }).get('/api/me');
  assert.equal(both.body.id, 'u-override');
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
  await t.close();
});
