// feeds.test.js — feed links: separate tokens that only read the feeds; human-only management;
// the calendar feed (RFC 5545: escaping, folding, stable UIDs, all-day events); privacy and revocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { icalText, fold, renderCalendar } from '../api/lib/ical.js';

const NOW = '2026-11-02T10:00:00.000Z';

async function setup(opts = {}) {
  const t = await createTestApp({ now: () => NOW, ...opts });
  const a = t.as('alice');
  const made = await a.post('/api/feeds', { label: 'Phone calendar', scope: 'mine' });
  return { t, a, made };
}

test('feed links: created once with the full link, listed without it, revoked; human-only', async () => {
  const { t, a, made } = await setup();
  assert.equal(made.status, 201);
  assert.match(made.body.plaintext, /^tsf_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.body.calendar_url, `http://test/api/feeds/${made.body.plaintext}/calendar.ics`);
  assert.equal(made.body.feed.scope, 'mine');
  const list = (await a.get('/api/feeds')).body.items;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes(made.body.plaintext), false, 'never shown again');
  assert.equal(list[0].token_prefix, made.body.plaintext.slice(0, 12));
  let r = await a.post('/api/feeds', { label: '', scope: 'everyone' });
  assert.deepEqual(Object.keys(r.body.error.details.fields).sort(), ['label', 'scope']);
  // an MCP token cannot manage feed links
  const plain = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  assert.equal((await t.tokenAs(plain).get('/api/feeds')).status, 403);
  assert.equal((await t.tokenAs(plain).post('/api/feeds', { label: 'x', scope: 'all' })).status, 403);
  // someone else's feed id is the generic 404
  assert.equal((await t.as('bob').delete(`/api/feeds/${made.body.feed.id}`)).status, 404);
  r = await a.delete(`/api/feeds/${made.body.feed.id}`);
  assert.ok(r.body.revoked_at);
  assert.equal((await t.anon().get(`/api/feeds/${made.body.plaintext}/calendar.ics`)).status, 404, 'a revoked link stops working');
  await t.close();
});

test('a feed token reads the feeds and nothing else', async () => {
  const { t, made } = await setup();
  const feed = t.withHeaders({ authorization: `Bearer ${made.body.plaintext}` });
  for (const path of ['/api/me', '/api/tasks', '/api/projects', '/api/activity', '/api/feeds']) {
    assert.equal((await feed.get(path)).status, 401, path);
  }
  assert.equal((await t.anon().get('/api/feeds/tsf_nonsense/calendar.ics')).status, 404);
  assert.equal((await t.anon().get('/api/feeds/not-a-token/calendar.ics')).status, 404);
  await t.close();
});

test('the calendar: open, dated, visible tasks as all-day events; headers keep the link private', async () => {
  const { t, a, made } = await setup();
  const b = t.as('bob');
  const hostile = 'Pay; rent, now\\then\nsecond line — ünïcödé ✓ ' + 'x'.repeat(80);
  const mine = (await a.post('/api/tasks', { title: hostile, due_date: '2026-11-05', priority: 'High' })).body;
  await a.post('/api/tasks', { title: 'Done already', due_date: '2026-11-04', status: 'Done' });
  await a.post('/api/tasks', { title: 'No date' });
  const gone = (await a.post('/api/tasks', { title: 'Trashed one', due_date: '2026-11-06' })).body;
  await a.delete(`/api/tasks/${gone.id}`, { version: gone.version });
  await b.post('/api/tasks', { title: 'Bob public', due_date: '2026-11-07' });
  await b.post('/api/tasks', { title: 'Bob private', due_date: '2026-11-08', private: true });
  const r = await t.anon().get(`/api/feeds/${made.body.plaintext}/calendar.ics`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const ics = r.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(/[^\r]\n/.test(ics), false, 'every line ends with CRLF');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `folded: ${line}`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`UID:task-${mine.id}@taskscape`));
  assert.ok(unfolded.includes('DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106'));
  assert.ok(unfolded.includes('SUMMARY:Pay\\; rent\\, now\\\\then\\nsecond line — ünïcödé ✓ '));
  assert.ok(unfolded.includes(`URL:http://test/task.html?id=${mine.id}`));
  assert.match(unfolded, /DESCRIPTION:Status: To do\\nPriority: High\\nProject: General\\nhttp:\/\/test\/task\.html/);
  for (const absent of ['Done already', 'No date', 'Trashed one', 'Bob public', 'Bob private']) assert.equal(unfolded.includes(absent), false, absent);
  // scope "all": everything alice can see, never bob's private task
  const all = (await a.post('/api/feeds', { label: 'All', scope: 'all' })).body;
  const everything = (await t.anon().get(`/api/feeds/${all.plaintext}/calendar.ics`)).text.replace(/\r\n /g, '');
  assert.ok(everything.includes('Bob public'));
  assert.equal(everything.includes('Bob private'), false);
  // the UID is stable across fetches
  const again = (await t.anon().get(`/api/feeds/${made.body.plaintext}/calendar.ics`)).text.replace(/\r\n /g, '');
  assert.ok(again.includes(`UID:task-${mine.id}@taskscape`));
  await t.close();
});

test('the public base URL comes from the config or the environment', async () => {
  const t = await createTestApp({ now: () => NOW, env: { TASKSCAPE_PUBLIC_URL: 'https://tasks.example.test/' } });
  const made = (await t.as('alice').post('/api/feeds', { label: 'x', scope: 'mine' })).body;
  assert.ok(made.calendar_url.startsWith('https://tasks.example.test/api/feeds/'));
  await t.close();
  const { prepareConfig } = await import('../api/lib/config.js');
  const base = JSON.parse((await import('node:fs')).readFileSync(new URL('../taskscape.config.json', import.meta.url), 'utf8'));
  assert.throws(() => prepareConfig({ ...base, public_url: 'javascript:alert(1)' }), /public_url/);
  assert.throws(() => prepareConfig({ ...base, public_url: 'https://u:p@x.test' }), /public_url/);
});

test('under the password provider a feed works only while the account is enabled; passwd and disable revoke feeds', async () => {
  const t = await createTestApp({ now: () => NOW, config: { auth: { provider: 'password' } } });
  const users = await import('../api/lib/repo/users.js');
  const feeds = await import('../api/lib/repo/feeds.js');
  await users.create(t.db, { id: 'dana', name: 'Dana Fox', email: null, groups: [] }, 'x', NOW);
  const dana = { id: 'dana', name: 'Dana Fox', groups: [], via: 'ui', auth: 'password' };
  const { plaintext } = await feeds.issue(t.db, dana, { label: 'cal', scope: 'mine' }, NOW);
  assert.equal((await t.anon().get(`/api/feeds/${plaintext}/calendar.ics`)).status, 200);
  await t.db.query('UPDATE users SET disabled_at = ? WHERE id = ?', [NOW, 'dana']);
  assert.equal((await t.anon().get(`/api/feeds/${plaintext}/calendar.ics`)).status, 404, 'a disabled account\'s feed stops');
  await t.db.query('UPDATE users SET disabled_at = NULL WHERE id = ?', ['dana']);
  assert.equal((await users.disable(t.db, 'dana', NOW)).feeds, 1);
  const second = await feeds.issue(t.db, dana, { label: 'cal2', scope: 'mine' }, NOW);
  assert.equal((await users.setPassword(t.db, 'dana', 'y', NOW, { revokeTokens: true })).feeds, 1);
  assert.ok(second);
  await t.close();
});

test('RFC 5545 helpers: escaping and folding at 75 octets without splitting a character', () => {
  assert.equal(icalText('a,b;c\\d\r\ne\rf\ng'), 'a\\,b\\;c\\\\d\\ne\\nf\\ng');
  assert.equal(icalText('bell\u0007 and nul\u0000'), 'bell and nul');
  const long = 'SUMMARY:' + 'é'.repeat(60);
  const folded = fold(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long);
  const cal = renderCalendar({ name: 'X, Y; Z', base: 'https://x.test', stamp: NOW }, []);
  assert.ok(cal.includes('X-WR-CALNAME:X\\, Y\\; Z\r\n'));
});

test('a feed link made before an account existed keeps the id in use: add refuses it without --claim-existing', async () => {
  const t = await createTestApp({ now: () => NOW, config: { auth: { provider: 'password' } } });
  const users = await import('../api/lib/repo/users.js');
  const feeds = await import('../api/lib/repo/feeds.js');
  const { plaintext } = await feeds.issue(t.db, { id: 'erin', name: 'Old Erin', groups: [], via: 'ui' }, { label: 'cal', scope: 'all' }, NOW);
  assert.equal((await t.anon().get(`/api/feeds/${plaintext}/calendar.ics`)).status, 404, 'no account, no feed');
  const r = await users.create(t.db, { id: 'erin', name: 'Someone else', email: null, groups: [] }, 'x', NOW);
  assert.equal(r.status, 'in_use');
  assert.equal(r.claimed.live_feeds, 1);
  assert.equal((await t.anon().get(`/api/feeds/${plaintext}/calendar.ics`)).status, 404);
  await t.close();
});

test('production needs an https public_url, so a feed link is never handed out for plain HTTP', async () => {
  const { prepareConfig } = await import('../api/lib/config.js');
  const base = JSON.parse((await import('node:fs')).readFileSync(new URL('../taskscape.config.json', import.meta.url), 'utf8'));
  const env = { TASKSCAPE_ENV: 'production', TASKSCAPE_AUTH_PROVIDER: 'headers' };
  assert.throws(() => prepareConfig(base, env), /public_url .* https/);
  assert.throws(() => prepareConfig(base, { ...env, TASKSCAPE_PUBLIC_URL: 'http://tasks.example.test' }), /https/);
  assert.equal(prepareConfig(base, { ...env, TASKSCAPE_PUBLIC_URL: 'https://tasks.example.test/' }).public_url, 'https://tasks.example.test');
});
