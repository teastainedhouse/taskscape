import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { prepareConfig } from '../api/lib/config.js';
import { hashPassword, verifyPassword, passwordProblem } from '../api/lib/auth/passwords.js';
import * as users from '../api/lib/repo/users.js';
import * as tokens from '../api/lib/repo/tokens.js';
import { createLockout } from '../api/lib/auth/lockout.js';
import { validateNewUser } from '../api/lib/validate.js';

const PASSWORD = 'correct horse battery';
const COOKIE = '__Host-taskscape_session';

/** A password-provider app with a driveable clock and one user, dana. */
async function passwordApp(opts = {}) {
  let ms = Date.parse('2026-11-01T09:00:00.000Z');
  const clock = { advance: (minutes) => { ms += minutes * 60_000; } };
  const config = { ...(opts.config ?? {}), auth: { provider: 'password', ...(opts.config?.auth ?? {}) } };
  const t = await createTestApp({ config, now: () => new Date(ms).toISOString() });
  const addUser = async (id, name, password = PASSWORD) =>
    (await users.create(t.db, { id, name, email: `${id}@example.test`, groups: ['editors'] }, await hashPassword(password), new Date(ms).toISOString())).user;
  await addUser('dana', 'Dana Fox');
  const login = (username = 'dana', password = PASSWORD, headers = {}) => t.anon().post('/api/login', { username, password }, headers);
  /** @param {{headers: Headers}} r */
  const cookieFrom = (r) => /^__Host-taskscape_session=([^;]*)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
  const as = (value, extra = {}) => t.withHeaders({ cookie: `${COOKIE}=${value}`, ...extra });
  return { ...t, clock, login, cookieFrom, cookie: as, addUser };
}

test('passwords: scrypt format, verify, and rules', async () => {
  const h = await hashPassword('ten chars!');
  assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('ten chars!', h), true);
  assert.equal(await verifyPassword('ten chars?', h), false);
  assert.notEqual(await hashPassword('ten chars!'), h); // salted
  for (const bad of ['', 'nope', 'scrypt$1$8$1$AA$AA', 'scrypt$1073741824$8$1$AAAA$' + 'A'.repeat(88), h.replace('$8$', '$999$')]) {
    assert.equal(await verifyPassword('ten chars!', bad), false);
  }
  assert.equal(passwordProblem('123456789'), 'must be 10 to 200 characters');
  assert.equal(passwordProblem('1234567890'), null);
  assert.equal(passwordProblem('x'.repeat(201)), 'must be 10 to 200 characters');
  assert.equal(passwordProblem('\u{1F600}'.repeat(10)), null); // characters, not UTF-16 units
});

test('config: password provider accepted, block defaulted and validated, never public', async () => {
  const raw = { statuses: { project: ['A'], task: ['B'] }, closed_statuses: { project: [], task: [] },
    default_status: { project: 'A', task: 'B' }, tag_palette: ['#000000'], catch_all_project: { id: 'g', name: 'G' },
    permissions: { edit: 'everyone' }, auth: { provider: 'headers', headers: {} } };
  const c = prepareConfig(raw, { TASKSCAPE_ENV: 'production', TASKSCAPE_AUTH_PROVIDER: 'password' });
  assert.equal(c.auth.provider, 'password');
  assert.deepEqual(c.auth.password, { session_days: 30, cookie_name: '__Host-taskscape_session' });
  for (const password of [{ session_days: 0 }, { session_days: 366 }, { session_days: 1.5 }, { cookie_name: 'a b' }, { cookie_name: '' }, { cookie_name: 'x'.repeat(65) }]) {
    assert.throws(() => prepareConfig({ ...raw, auth: { provider: 'password', password } }, {}), /auth\.password/);
  }
  const t = await passwordApp();
  const r = await t.login();
  const cfg = await t.cookie(t.cookieFrom(r)).get('/api/config');
  assert.deepEqual(cfg.body.auth, { provider: 'password' });
  await t.close();
});

test('login sets a hardened session cookie that authenticates /api/me', async () => {
  const t = await passwordApp();
  assert.equal((await t.anon().get('/api/me')).status, 401);
  const r = await t.login('  Dana ');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'dana', name: 'Dana Fox', email: 'dana@example.test', auth: 'password', can_edit: true });
  const set = r.headers.get('set-cookie');
  assert.match(set, /^__Host-taskscape_session=[A-Za-z0-9_-]{43}; /);
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${30 * 86400}`]) assert.ok(set.split('; ').includes(attr), attr);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const value = t.cookieFrom(r);
  // only the hash is stored
  const { rows } = await t.db.query('SELECT token_hash FROM sessions');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, value);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  const me = await t.cookie(value).get('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, r.body);
  // a password principal can write, and is recorded like any UI user
  const p = await t.cookie(value).post('/api/projects', { name: 'Signed in' });
  assert.equal(p.status, 201);
  assert.equal(p.body.owner_id, 'dana');
  const act = await t.cookie(value).get('/api/activity');
  assert.equal(act.body.items[0].via, 'ui');
  assert.equal(act.body.items[0].session_id, null);
  // junk cookies are just signed-out
  for (const junk of ['nope', 'A'.repeat(43), '%E0%A4%A']) assert.equal((await t.cookie(junk).get('/api/me')).status, 401);
  // neither the dev switch nor SSO headers mean anything here
  assert.equal((await t.withHeaders({ 'x-dev-user': 'alice' }).get('/api/me')).status, 401);
  assert.equal((await t.withHeaders({ 'x-forwarded-user': 'dana', 'x-forwarded-preferred-username': 'Dana Fox' }).get('/api/me')).status, 401);
  const withSso = await t.cookie(value, { 'x-forwarded-user': 'mallory', 'x-forwarded-groups': 'admins' }).get('/api/me');
  assert.equal(withSso.body.id, 'dana');
  await t.close();
});

test('wrong password, unknown user, and disabled user get byte-identical 401s', async () => {
  const t = await passwordApp();
  const wrong = await t.login('dana', 'not the password');
  const unknown = await t.login('nobody', 'not the password');
  await users.disable(t.db, 'dana', new Date().toISOString());
  const disabled = await t.login('dana', PASSWORD);
  for (const r of [wrong, unknown, disabled]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal(wrong.text, unknown.text);
  assert.equal(wrong.text, disabled.text);
  assert.deepEqual(wrong.body, { error: { code: 'unauthorized', message: 'Wrong username or password.' } });
  assert.equal(JSON.stringify(wrong.body).includes('dana'), false);
  await users.enable(t.db, 'dana', new Date().toISOString());
  assert.equal((await t.login()).status, 200);
  await t.close();
});

test('login validation names fields only', async () => {
  const t = await passwordApp();
  const r = await t.anon().post('/api/login', { username: 'secret-name-xyz', password: 42 });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.error.details.fields), ['password']);
  assert.equal(r.text.includes('secret-name-xyz'), false);
  for (const bad of ['dana\u0000', 'da\nna', 'dana\u007f', 'dana\u0085']) {
    const c = await t.anon().post('/api/login', { username: bad, password: PASSWORD });
    assert.equal(c.status, 400);
    assert.deepEqual(c.body.error.details.fields, { username: 'must not contain control characters' });
  }
  const r2 = await t.anon().post('/api/login', {});
  assert.deepEqual(Object.keys(r2.body.error.details.fields).sort(), ['password', 'username']);
  assert.equal((await t.anon().post('/api/login', { username: 'x'.repeat(65), password: 'p' })).status, 400);
  assert.equal((await t.anon().post('/api/login', { username: 'dana', password: 'p'.repeat(201) })).status, 400);
  await t.close();
});

test('lockout: 5 failures lock the name for 15 minutes, known or not; success resets', async () => {
  const t = await passwordApp();
  for (let i = 0; i < 5; i++) assert.equal((await t.login('dana', 'wrong password')).status, 401);
  const locked = await t.login(); // even the right password
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_requests');
  assert.equal(locked.headers.get('retry-after'), String(15 * 60));
  assert.equal(locked.headers.get('set-cookie'), null);
  t.clock.advance(10);
  assert.equal((await t.login()).headers.get('retry-after'), String(5 * 60));
  // an unknown name locks the same way, so a 429 says nothing about who exists
  for (let i = 0; i < 5; i++) await t.login('ghost', 'wrong password');
  assert.equal((await t.login('ghost', 'wrong password')).status, 429);
  t.clock.advance(5);
  assert.equal((await t.login()).status, 200);
  // a success clears the count: four more failures do not lock
  for (let i = 0; i < 4; i++) await t.login('dana', 'wrong password');
  assert.equal((await t.login()).status, 200);
  for (let i = 0; i < 4; i++) await t.login('dana', 'wrong password');
  assert.equal((await t.login('dana', 'wrong password')).status, 401);
  assert.equal((await t.login()).status, 429);
  // failures older than the window do not count
  t.clock.advance(15);
  for (let i = 0; i < 4; i++) await t.login('dana', 'wrong password');
  t.clock.advance(16);
  assert.equal((await t.login('dana', 'wrong password')).status, 401);
  assert.equal((await t.login()).status, 200);
  await t.close();
});

test('logout ends the session and clears the cookie; works signed out too', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const out = await t.cookie(value).post('/api/logout');
  assert.equal(out.status, 204);
  assert.equal(out.headers.get('set-cookie'), '__Host-taskscape_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  assert.equal((await t.cookie(value).get('/api/me')).status, 401);
  assert.equal((await t.db.query('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 0);
  assert.equal((await t.anon().post('/api/logout')).status, 204);
  await t.close();
});

test('sessions expire at a fixed time from creation; expired rows are swept on login', async () => {
  const t = await passwordApp({ config: { auth: { password: { session_days: 2 } } } });
  const first = await t.login();
  assert.match(first.headers.get('set-cookie'), /Max-Age=172800/);
  const value = t.cookieFrom(first);
  t.clock.advance(47 * 60);
  assert.equal((await t.cookie(value).get('/api/me')).status, 200); // use does not extend it
  t.clock.advance(60);
  assert.equal((await t.cookie(value).get('/api/me')).status, 401);
  await t.login();
  assert.equal((await t.db.query('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 1);
  await t.close();
});

test('last_seen_at moves at most once a minute', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const seen = async () => (await t.db.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at;
  const start = await seen();
  t.clock.advance(0.5);
  await t.cookie(value).get('/api/me');
  assert.equal(await seen(), start);
  t.clock.advance(1);
  await t.cookie(value).get('/api/me');
  assert.notEqual(await seen(), start);
  await t.close();
});

test('disabling a user ends sessions and revokes MCP tokens', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const issued = await t.cookie(value).post('/api/tokens', { label: 'laptop' });
  assert.equal(issued.status, 201);
  assert.equal((await t.tokenAs(issued.body.plaintext).get('/api/me')).body.auth, 'token');
  const swept = await users.disable(t.db, 'dana', new Date().toISOString());
  assert.deepEqual(swept, { found: true, sessions: 1, tokens: 1 });
  assert.equal((await t.cookie(value).get('/api/me')).status, 401);
  assert.equal((await t.tokenAs(issued.body.plaintext).get('/api/me')).status, 401);
  assert.equal((await tokens.listForUser(t.db, 'dana'))[0].revoked_at !== null, true);
  await t.close();
});

test('password change: checks the current one, keeps this session, ends the others', async () => {
  const t = await passwordApp();
  const here = t.cookieFrom(await t.login());
  const there = t.cookieFrom(await t.login());
  const change = (body, value = here) => t.cookie(value).post('/api/me/password', body);
  const short = await change({ current_password: PASSWORD, new_password: 'short' });
  assert.equal(short.status, 400);
  assert.deepEqual(short.body.error.details.fields, { new_password: 'must be 10 to 200 characters' });
  assert.equal(short.text.includes('short"'), false);
  const wrong = await change({ current_password: 'not the password', new_password: 'a new password' });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.error.details.fields, { current_password: 'is incorrect' });
  assert.equal((await t.cookie(there).get('/api/me')).status, 200);
  const ok = await change({ current_password: PASSWORD, new_password: 'a new password' });
  assert.equal(ok.status, 204);
  assert.equal((await t.cookie(here).get('/api/me')).status, 200);
  assert.equal((await t.cookie(there).get('/api/me')).status, 401);
  assert.equal((await t.login()).status, 401);
  assert.equal((await t.login('dana', 'a new password')).status, 200);
  // a token cannot change the password
  const issued = await t.cookie(here).post('/api/tokens', { label: 'x' });
  const viaToken = await t.tokenAs(issued.body.plaintext).post('/api/me/password', { current_password: 'a new password', new_password: 'another one!' });
  assert.equal(viaToken.status, 403);
  await t.close();
});

test('password change has its own lockout, separate from sign-in', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  // anyone can lock the name at the sign-in form; the signed-in owner can still change the password
  for (let i = 0; i < 5; i++) await t.login('dana', 'wrong password');
  assert.equal((await t.login()).status, 429);
  const change = (current, fresh) => t.cookie(value).post('/api/me/password', { current_password: current, new_password: fresh });
  assert.equal((await change(PASSWORD, 'a new password')).status, 204);
  // and guessing the current password locks the change form, not sign-in
  for (let i = 0; i < 5; i++) assert.equal((await change('wrong guess', 'another new one')).status, 400);
  const locked = await change('a new password', 'another new one');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  t.clock.advance(16);
  assert.equal((await t.login('dana', 'a new password')).status, 200);
  await t.close();
});

test('password change can revoke every MCP token; revoke_tokens must be a boolean', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const a = (await t.cookie(value).post('/api/tokens', { label: 'a' })).body.plaintext;
  const b = (await t.cookie(value).post('/api/tokens', { label: 'b' })).body.plaintext;
  const bad = await t.cookie(value).post('/api/me/password', { current_password: PASSWORD, new_password: 'a new password', revoke_tokens: 'yes' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.fields, { revoke_tokens: 'must be true or false' });
  // default: tokens keep working
  assert.equal((await t.cookie(value).post('/api/me/password', { current_password: PASSWORD, new_password: 'a new password' })).status, 204);
  assert.equal((await t.tokenAs(a).get('/api/me')).status, 200);
  const r = await t.cookie(value).post('/api/me/password', { current_password: 'a new password', new_password: 'the third one', revoke_tokens: true });
  assert.equal(r.status, 204);
  for (const p of [a, b]) assert.equal((await t.tokenAs(p).get('/api/me')).status, 401);
  assert.equal((await t.cookie(value).get('/api/me')).status, 200); // this session survives
  await t.close();
});

test('passwd (repo) ends sessions and, as the CLI asks, revokes tokens', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const p = (await t.cookie(value).post('/api/tokens', { label: 'x' })).body.plaintext;
  const swept = await users.setPassword(t.db, 'dana', await hashPassword('reset by admin'), new Date().toISOString(), { revokeTokens: true });
  assert.deepEqual(swept, { sessions: 1, tokens: 1 });
  assert.equal((await t.cookie(value).get('/api/me')).status, 401);
  assert.equal((await t.tokenAs(p).get('/api/me')).status, 401);
  assert.equal(await users.setPassword(t.db, 'nobody', 'x', new Date().toISOString()), null);
  await t.close();
});

test('under password, a token needs a live users row; under dev it does not', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const p = (await t.cookie(value).post('/api/tokens', { label: 'x' })).body.plaintext;
  assert.equal((await t.tokenAs(p).get('/api/me')).status, 200);
  // a token whose user_id has no users row at all (minted earlier under another provider)
  const orphan = await tokens.issue(t.db, { id: 'ghost', name: 'Ghost', groups: [], via: 'ui', auth: 'headers' }, 'old', new Date().toISOString());
  assert.equal((await t.tokenAs(orphan.plaintext).get('/api/me')).status, 401);
  // disabled, without the sweep (as if revoking had failed): still dead, and alive again once enabled
  await t.db.query('UPDATE users SET disabled_at = ? WHERE id = ?', [new Date().toISOString(), 'dana']);
  assert.equal((await t.tokenAs(p).get('/api/me')).status, 401);
  await users.enable(t.db, 'dana', new Date().toISOString());
  assert.equal((await t.tokenAs(p).get('/api/me')).status, 200);
  await t.close();
  const dev = await createTestApp();
  const devToken = await tokens.issue(dev.db, { id: 'alice', name: 'Alice Lin', groups: [], via: 'ui', auth: 'dev' }, 'dev', new Date().toISOString());
  assert.equal((await dev.tokenAs(devToken.plaintext).get('/api/me')).status, 200);
  await dev.close();
});

test('disable sweeps an id that has no users row', async () => {
  const t = await passwordApp();
  const orphan = await tokens.issue(t.db, { id: 'ghost', name: 'Ghost', groups: [], via: 'ui', auth: 'headers' }, 'old', new Date().toISOString());
  assert.deepEqual(await users.disable(t.db, 'ghost', new Date().toISOString()), { found: false, sessions: 0, tokens: 1 });
  assert.notEqual((await tokens.listForUser(t.db, 'ghost'))[0].revoked_at, null);
  await t.close();
  assert.equal(orphan.token.label, 'old');
});

test('new users: system is reserved; an id already in use needs claimExisting', async () => {
  assert.throws(() => validateNewUser({ id: 'system', name: 'S' }), (e) => e.details.fields.id === 'is reserved');
  const t = await passwordApp();
  const now = () => new Date().toISOString();
  // dana creates things, then the same person's old id from another provider shows up: "olddana"
  const dana = t.cookieFrom(await t.login());
  await t.cookie(dana).post('/api/projects', { name: 'x' });
  await t.db.query("UPDATE projects SET owner_id = 'olddana' WHERE name = 'x'");
  await t.db.query("UPDATE activity SET actor_id = 'olddana'");
  await tokens.issue(t.db, { id: 'olddana', name: 'Old', groups: [], via: 'ui', auth: 'headers' }, 'old', now());
  const hash = await hashPassword('claim this account');
  const refused = await users.create(t.db, { id: 'olddana', name: 'Dana' }, hash, now());
  assert.equal(refused.status, 'in_use');
  assert.deepEqual(refused.claimed, { projects: 1, tasks: 0, activity: 1, tokens: 1, live_tokens: 1 });
  assert.equal(await users.get(t.db, 'olddana'), null);
  const claimed = await users.create(t.db, { id: 'olddana', name: 'Dana' }, hash, now(), { claimExisting: true });
  assert.equal(claimed.status, 'created');
  assert.equal(claimed.claimed.projects, 1);
  assert.equal((await users.create(t.db, { id: 'olddana', name: 'Dana' }, hash, now(), { claimExisting: true })).status, 'exists');
  // a revoked token alone still marks the id as someone's
  const o = await tokens.issue(t.db, { id: 'gone', name: 'Gone', groups: [], via: 'ui', auth: 'headers' }, 'g', now());
  await tokens.revokeAllForUser(t.db, 'gone', now());
  assert.equal((await users.create(t.db, { id: 'gone', name: 'G' }, hash, now())).status, 'in_use');
  assert.ok(o.plaintext);
  // the claimed account signs in and owns the old project
  const r = await t.login('olddana', 'claim this account');
  assert.equal(r.status, 200);
  const mine = await t.cookie(t.cookieFrom(r)).get('/api/projects', undefined);
  assert.ok(mine.body.items.some((p) => p.name === 'x' && p.owner_id === 'olddana'));
  await t.close();
});

test('signing in again in the same browser replaces the previous session', async () => {
  const t = await passwordApp();
  const first = t.cookieFrom(await t.login());
  const second = t.cookieFrom(await t.login('dana', PASSWORD, { cookie: `${COOKIE}=${first}` }));
  assert.notEqual(first, second);
  assert.equal((await t.cookie(first).get('/api/me')).status, 401);
  assert.equal((await t.cookie(second).get('/api/me')).status, 200);
  assert.equal((await t.db.query('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 1);
  await t.close();
});

test('lockout never forgets a live entry; when full of them it fails closed', () => {
  const l = createLockout({ maxKeys: 3 });
  let now = 1_000_000;
  for (let i = 0; i < 5; i++) l.attempt('locked', now);
  assert.ok(l.attempt('locked', now) > 0);
  l.attempt('b', now); l.attempt('c', now);
  // a spray of new names cannot push "locked" out; the new names are refused instead
  for (const name of ['d', 'e', 'f']) assert.ok(l.attempt(name, now) > 0, name);
  assert.ok(l.attempt('locked', now) > 0);
  // a correct password for a tracked name frees a slot
  l.succeeded('b');
  assert.equal(l.attempt('d', now), 0);
  // once the window passes, everything is free again
  now += 16 * 60_000;
  for (const name of ['e', 'f']) assert.equal(l.attempt(name, now), 0, name);
  assert.equal(l.attempt('locked', now), 0);
  assert.ok(l.attempt('g', now) > 0); // full again, of live entries
});

test('scrypt runs at most two at once; a full queue answers 503 with Retry-After', async () => {
  const t = await passwordApp();
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => t.login(`nobody${i}`, 'not the password')));
  const busy = results.filter((r) => r.status === 503);
  assert.ok(busy.length > 0, 'some requests are turned away');
  assert.ok(results.filter((r) => r.status === 401).length >= 16, 'the running and queued ones still get answered');
  assert.equal(busy[0].headers.get('retry-after'), '1');
  assert.equal(busy[0].body.error.code, 'unavailable');
  // a 503 took its attempt back: five turned-away tries do not lock a name
  assert.equal((await t.login()).status, 200);
  await t.close();
});

test('a Bearer token wins over the session cookie, and a bad one never falls back to it', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const { plaintext } = (await t.cookie(value).post('/api/tokens', { label: 'mcp' })).body;
  const both = await t.cookie(value, { authorization: `Bearer ${plaintext}` }).get('/api/me');
  assert.equal(both.body.auth, 'token');
  assert.equal((await t.cookie(value, { authorization: 'Bearer tsk_not_real' }).get('/api/me')).status, 401);
  assert.equal((await t.cookie(value, { authorization: 'Basic ZGFuYTp4' }).get('/api/me')).status, 401);
  await t.close();
});

test('cross-site and non-JSON writes are refused for cookie sessions and sign-in', async () => {
  const t = await passwordApp();
  const value = t.cookieFrom(await t.login());
  const cookie = `${COOKIE}=${value}`;
  const send = (path, headers, body) => t.app.fetch(new Request('http://test' + path, { method: 'POST', headers: { cookie, ...headers }, body }));
  const json = { 'content-type': 'application/json' };
  const project = JSON.stringify({ name: 'From elsewhere' });
  for (const site of ['cross-site', 'same-site']) {
    const r = await send('/api/projects', { ...json, 'sec-fetch-site': site }, project);
    assert.equal(r.status, 403, site);
    assert.equal((await r.json()).error.code, 'forbidden');
    assert.equal((await send('/api/login', { ...json, 'sec-fetch-site': site }, JSON.stringify({ username: 'dana', password: PASSWORD }))).status, 403);
    assert.equal((await send('/api/logout', { 'sec-fetch-site': site })).status, 403);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await send('/api/projects', { ...json, 'sec-fetch-site': site }, project)).status, 201);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await send('/api/projects', { 'content-type': type }, project);
    assert.equal(r.status, 415, type);
    assert.equal((await r.json()).error.code, 'unsupported_media_type');
    assert.equal((await send('/api/login', { 'content-type': type }, 'username=dana&password=x')).status, 415);
  }
  assert.equal((await send('/api/projects', {}, project)).status, 415); // a body with no type at all
  assert.equal((await send('/api/projects', { 'content-type': 'application/json; charset=utf-8' }, project)).status, 201);
  // nothing was created by the refused requests: only the three accepted ones exist
  const list = await t.cookie(value).get('/api/projects');
  assert.equal(list.body.items.filter((p) => p.name === 'From elsewhere').length, 3);
  assert.equal((await send('/api/logout', { 'content-length': '0' })).status, 204); // no body, no type: fine
  await t.close();
});

test('the cross-site checks apply to every browser principal, but not to tokens', async () => {
  const t = await createTestApp();
  const dev = await t.as('alice').post('/api/projects', { name: 'Dev' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(dev.status, 403);
  const form = await t.app.fetch(new Request('http://test/api/projects', { method: 'POST', headers: { 'x-dev-user': 'alice', 'content-type': 'text/plain' }, body: '{"name":"x"}' }));
  assert.equal(form.status, 415);
  const { plaintext } = (await t.as('alice').post('/api/tokens', { label: 'mcp' })).body;
  assert.equal((await t.tokenAs(plaintext).post('/api/projects', { name: 'Token' }, { 'sec-fetch-site': 'cross-site' })).status, 201);
  await t.close();
  const h = await createTestApp({ config: { auth: { provider: 'headers' } } });
  const sso = { 'x-forwarded-user': 'u-1', 'x-forwarded-preferred-username': 'Una' };
  assert.equal((await h.withHeaders(sso).post('/api/projects', { name: 'SSO' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await h.withHeaders(sso).post('/api/projects', { name: 'SSO' }, { 'sec-fetch-site': 'same-origin' })).status, 201);
  await h.close();
});

test('privacy holds under the password provider', async () => {
  const t = await passwordApp();
  await t.addUser('eli', 'Eli Moss');
  await t.addUser('fay', 'Fay Quinn'); // owns nothing
  const dana = t.cookieFrom(await t.login());
  const eli = t.cookieFrom(await t.login('eli'));
  const secret = await t.cookie(dana).post('/api/projects', { name: 'Dana only', private: true });
  assert.equal(secret.status, 201);
  const hidden = await t.cookie(eli).get(`/api/projects/${secret.body.id}`);
  const missing = await t.cookie(eli).get('/api/projects/no-such-id');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.text, missing.text);
  assert.equal((await t.cookie(eli).get('/api/projects')).body.items.some((p) => p.id === secret.body.id), false);
  assert.equal((await t.cookie(eli).get('/api/activity')).body.items.some((a) => a.item_id === secret.body.id), false);
  // people comes from visible items, never from the users table
  const people = (await t.cookie(eli).get('/api/people')).body.items.map((p) => p.id);
  assert.ok(people.includes('eli'));
  assert.equal(people.includes('fay'), false);
  assert.equal(people.includes('dana'), false); // dana owns only a private project
  await t.close();
});

test('password routes are 404 under other providers; GET /api/login works everywhere', async () => {
  const t = await createTestApp();
  assert.equal((await t.anon().post('/api/login', { username: 'alice', password: 'whatever it is' })).status, 404);
  assert.equal((await t.anon().post('/api/logout')).status, 404);
  assert.equal((await t.as('alice').post('/api/me/password', { current_password: 'x', new_password: 'a new password' })).status, 404);
  const info = await t.anon().get('/api/login', undefined, { 'x-dev-user': 'nobody' });
  assert.equal(info.status, 200);
  assert.deepEqual(info.body, { provider: 'dev', site_title: t.config.site_title });
  await t.close();
  const p = await passwordApp();
  assert.deepEqual((await p.anon().get('/api/login')).body, { provider: 'password', site_title: p.config.site_title });
  await p.close();
});
