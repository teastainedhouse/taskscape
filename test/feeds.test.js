// feeds.test.js — feed links: separate tokens that only read the feeds; human-only management;
// the calendar feed (RFC 5545: escaping, folding, stable UIDs, all-day events); the Atom feed of What's New
// (RFC 4287: one escaping function, stable entry ids, the scopes); privacy and revocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { icalText, fold, renderCalendar } from '../api/lib/ical.js';
import { xmlText, renderAtom } from '../api/lib/atom.js';

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
  assert.equal(made.body.atom_url, `http://test/api/feeds/${made.body.plaintext}/activity.atom`);
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
  assert.equal((await t.anon().get(`/api/feeds/${made.body.plaintext}/activity.atom`)).status, 404, 'both feeds');
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
  const unknown = await t.anon().get('/api/feeds/tsf_nonsense/activity.atom');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, (await t.anon().get('/api/feeds/tsf_nonsense/calendar.ics')).text, 'one 404 body for both feeds');
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
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
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
  assert.ok(made.atom_url.startsWith('https://tasks.example.test/api/feeds/'));
  const atom = (await t.anon().get(new URL(made.atom_url).pathname)).text;
  assert.ok(atom.includes(`<link rel="self" type="application/atom+xml" href="${made.atom_url}"/>`));
  assert.ok(atom.includes('<link rel="alternate" type="text/html" href="https://tasks.example.test/whats-new.html"/>'));
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
  assert.equal((await t.anon().get(`/api/feeds/${plaintext}/activity.atom`)).status, 404);
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

test('the calendar: closed tasks never use up the cap; a task in a trashed project is left out', async () => {
  const { t, a, made } = await setup({ config: { limits: { max_page_size: 3 } } });
  // three closed tasks due first, then an open one: the open one must still be in the feed
  for (const d of ['2026-11-03', '2026-11-04', '2026-11-05']) await a.post('/api/tasks', { title: `Closed ${d}`, due_date: d, status: 'Done' });
  await a.post('/api/tasks', { title: 'Still open', due_date: '2026-11-06' });
  const p = (await a.post('/api/projects', { name: 'Binned' })).body;
  await a.post('/api/tasks', { title: 'In a trashed project', due_date: '2026-11-07', project_id: p.id });
  await a.delete(`/api/projects/${p.id}`, { version: p.version });
  const ics = (await t.anon().get(`/api/feeds/${made.body.plaintext}/calendar.ics`)).text.replace(/\r\n /g, '');
  assert.ok(ics.includes('SUMMARY:Still open'));
  assert.equal(ics.includes('Closed 2026'), false);
  assert.equal(ics.includes('In a trashed project'), false);
  await t.close();
});

test('the calendar: an all-day event ends the next day across month, year and leap-day ends', () => {
  const task = (id, due) => ({ id, title: id, status: 'To do', priority: null, project_name: null, due_date: due, updated_at: NOW });
  const cal = renderCalendar({ name: 'X', base: 'https://x.test', stamp: NOW },
    [task('a', '2026-01-31'), task('b', '2026-12-31'), task('c', '2028-02-28'), task('d', '2028-02-29'), task('e', '2027-02-28')]);
  for (const [start, end] of [['20260131', '20260201'], ['20261231', '20270101'], ['20280228', '20280229'], ['20280229', '20280301'], ['20270228', '20270301']]) {
    assert.ok(cal.includes(`DTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}\r\n`), start);
  }
});

/** The entries of an Atom document, as {id, title, updated, link, content} with the five escapes undone. @param {string} xml */
function atomEntries(xml) {
  const un = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: un(e.match(/<id>(.*)<\/id>/)[1]), title: un(e.match(/<title type="text">(.*)<\/title>/)[1]),
    updated: e.match(/<updated>(.*)<\/updated>/)[1], link: un(e.match(/<link rel="alternate" type="text\/html" href="(.*)"\/>/)[1]),
    content: un(e.match(/<content type="text">(.*)<\/content>/)[1]),
  }));
}

test('the Atom feed: What\'s New as the owner sees it, hostile text escaped, stable ids, private headers', async () => {
  let clock = 0;
  const t = await createTestApp({ now: () => new Date(Date.parse(NOW) + 1000 * clock++).toISOString() });
  const a = t.as('alice');
  const b = t.as('bob');
  const all = (await a.post('/api/feeds', { label: 'Reader', scope: 'all' })).body;
  // (a lone surrogate never gets this far: storage makes it U+FFFD; the helpers test covers it)
  const hostile = 'Q3 <script>alert("x")</script> & \'quotes\' ]]> \u0007bell \u0085nel \u202Eflip ✓';
  const task = (await a.post('/api/tasks', { title: hostile })).body;
  await b.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'Doing' });
  await b.post(`/api/tasks/${task.id}/comments`, { body: 'the comment text itself <b>never</b> appears' });
  await b.post('/api/tasks', { title: 'Bob public' });
  await b.post('/api/tasks', { title: 'Bob private', private: true });
  const r = await t.anon().get(`/api/feeds/${all.plaintext}/activity.atom`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'a browser opening the feed runs nothing');
  const xml = r.text;
  assert.ok(xml.includes('<author><name>Taskscape</name></author>\n  <link rel="self"'), 'the feed has its own author');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.ok(xml.includes(`<id>urn:uuid:${all.feed.id}</id>`), 'the feed id is the link\'s id');
  assert.equal(xml.includes('<script>'), false);
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\ud800-\udfff]/u.test(xml), false, 'no character XML 1.0 forbids, no C1');
  // every & in the document starts one of the five escapes
  assert.equal(/&(?!(amp|lt|gt|quot|apos);)/.test(xml), false);
  assert.ok(task.title.includes('\u0007bell \u0085nel \u202Eflip'), 'the API keeps the bell, the C1 control and the override, so the feed must drop them');
  const shown = task.title.replace(/[\u0007\u0085\u202E]/g, '');
  assert.ok(xml.includes('Q3 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;quotes&apos; ]]&gt; bell nel'));
  const entries = atomEntries(xml);
  assert.deepEqual(entries.map((e) => e.title), [
    'Bob Ortiz created task "Bob public"',
    `Bob Ortiz commented on task "${shown}"`,
    `Bob Ortiz changed task "${shown}": status: To do → Doing`,
    `Alice Lin created task "${shown}"`,
  ], 'newest first; bob\'s private task is not there');
  assert.equal(xml.includes('never'), false, 'a comment entry names its parent, never its text');
  const { items } = (await a.get('/api/activity')).body;
  assert.deepEqual(entries.map((e) => e.id), items.map((i) => `urn:uuid:${i.id}`), 'the same entries as What\'s New, ids from the activity ids');
  assert.deepEqual(entries.map((e) => e.updated), items.map((i) => i.created_at));
  assert.ok(xml.includes(`<updated>${items[0].created_at}</updated>\n  <author>`), 'the feed is as new as its newest entry');
  assert.equal(entries[1].link, `http://test/task.html?id=${task.id}`, 'a comment links to its task');
  assert.equal(entries[2].link, `http://test/task.html?id=${task.id}`);
  assert.equal(entries[2].content, `${entries[2].title}.`);
  // a change made through Claude says so
  const mcp = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  await t.tokenAs(mcp, 'session-1').post('/api/tasks', { title: 'Via MCP' });
  const latest = atomEntries((await t.anon().get(`/api/feeds/${all.plaintext}/activity.atom`)).text)[0];
  assert.equal(latest.content, 'Alice Lin (through Claude) created task "Via MCP".');
  // stable across fetches
  assert.deepEqual(atomEntries((await t.anon().get(`/api/feeds/${all.plaintext}/activity.atom`)).text).slice(1).map((e) => e.id), entries.map((e) => e.id));
  await t.close();
});

test('the Atom feed: "My tasks" is For you, and the owner\'s visibility now decides every entry', async () => {
  let clock = 0;
  const t = await createTestApp({ now: () => new Date(Date.parse(NOW) + 1000 * clock++).toISOString() });
  const a = t.as('alice');
  const b = t.as('bob');
  const mine = (await a.post('/api/feeds', { label: 'For you', scope: 'mine' })).body;
  const all = (await a.post('/api/feeds', { label: 'All', scope: 'all' })).body;
  const atom = async (f) => atomEntries((await t.anon().get(`/api/feeds/${f.plaintext}/activity.atom`)).text).map((e) => e.title);
  const own = (await a.post('/api/tasks', { title: 'Alice owns this' })).body;
  await a.patch(`/api/tasks/${own.id}`, { version: own.version, status: 'Doing' });
  await b.patch(`/api/tasks/${own.id}`, { version: own.version + 1, status: 'Blocked' });
  await b.post('/api/tasks', { title: 'Bob owns this' });
  assert.deepEqual(await atom(mine), ['Bob Ortiz changed task "Alice owns this": status: Doing → Blocked'], 'only others\' changes to what alice owns');
  // a project bob shares, then makes private: its history, and the comments on it, leave alice's feed
  const p = (await b.post('/api/projects', { name: 'Shared then hidden' })).body;
  await a.post(`/api/projects/${p.id}/comments`, { body: 'hello' });
  let titles = await atom(all);
  assert.ok(titles.includes('Bob Ortiz created project "Shared then hidden"'));
  assert.ok(titles.includes('Alice Lin commented on project "Shared then hidden"'));
  await b.patch(`/api/projects/${p.id}`, { version: p.version, private: true });
  titles = await atom(all);
  assert.equal(titles.some((x) => x.includes('Shared then hidden')), false, 'nothing about a project alice can no longer see');
  const xml = (await t.anon().get(`/api/feeds/${all.plaintext}/activity.atom`)).text;
  assert.equal(xml.includes(p.id), false, 'not even its id');
  // handing a private task to bob takes its history out of alice's feeds
  const gift = (await a.post('/api/tasks', { title: 'Private gift', private: true })).body;
  assert.ok((await atom(all)).includes('Alice Lin created task "Private gift"'));
  await a.patch(`/api/tasks/${gift.id}`, { version: gift.version, owner_id: 'bob', owner_name: 'Bob Ortiz' });
  assert.equal((await atom(all)).some((x) => x.includes('Private gift')), false);
  assert.equal((await atom(mine)).some((x) => x.includes('Private gift')), false);
  await t.close();
});

test('Atom helpers: one escaping function for text and attributes; an empty feed is still a feed', () => {
  assert.equal(xmlText(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(xmlText('nul\u0000 esc\u001b del\u007f c1\u0085 tab\tline\n ok'), 'nul esc del c1 tab\tline\n ok');
  assert.equal(xmlText('\ufffe\uffff\ud83d'), '', 'non-characters and a lone surrogate');
  assert.equal(xmlText('emoji 😀 and nbsp\u00a0'), 'emoji 😀 and nbsp\u00a0');
  assert.equal(xmlText(null), '');
  assert.equal(xmlText('a\u202Ab\u202Ec\u2066d\u2069e \u200f'), 'abcde \u200f', 'bidi embedding, override and isolate controls go; marks stay');
  const xml = renderAtom({ title: 'T & <T>', author: 'Site', id: 'urn:uuid:x', self: 'https://x.test/a?b=1&c=2', base: 'https://x.test', updated: NOW }, []);
  assert.ok(xml.includes('<title type="text">T &amp; &lt;T&gt;</title>'));
  assert.ok(xml.includes(`<updated>${NOW}</updated>`));
  assert.ok(xml.includes('<author><name>Site</name></author>'), 'an empty feed still has an author');
  assert.equal(xml.includes('<entry>'), false);
  assert.ok(xml.includes('href="https://x.test/a?b=1&amp;c=2"'));
  assert.ok(xml.endsWith('</feed>\n'));
});

test('the Atom feed: what each kind of entry says and links to; the request cannot change whose feed it is', async () => {
  let clock = 0;
  const t = await createTestApp({ now: () => new Date(Date.parse(NOW) + 1000 * clock++).toISOString() });
  const a = t.as('alice');
  const b = t.as('bob');
  const all = (await a.post('/api/feeds', { label: 'All', scope: 'all' })).body;
  const mine = (await a.post('/api/feeds', { label: 'Mine', scope: 'mine' })).body;
  const fetchAtom = async (f, headers) => (await t.withHeaders(headers ?? {}).get(`/api/feeds/${f.plaintext}/activity.atom`)).text;
  assert.equal(atomEntries(await fetchAtom(mine)).length, 0, 'a new For you feed is empty, and still a feed');
  // links: a label is shown, an unlabelled link only by its host; checklist text and tag names are escaped like titles
  let task = (await a.post('/api/tasks', { title: 'Links and lists' })).body;
  task = (await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://docs.example.test/d/abc?key=SECRET' })).body;
  task = (await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://x.test/', label: 'Spec <b>&</b>' })).body;
  task = (await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: 'Item </content><x>' })).body;
  const tag = (await a.post('/api/tags', { name: 'tag<&>' })).body;
  const p = (await a.post('/api/projects', { name: 'Guest page' })).body;
  await b.post(`/api/projects/${p.id}/comments`, { body: 'hi' });
  let xml = await fetchAtom(all);
  assert.equal(xml.includes('SECRET'), false, 'never an unlabelled link\'s URL');
  const byTitle = Object.fromEntries(atomEntries(xml).map((e) => [e.title, e]));
  assert.ok(byTitle['Alice Lin changed task "Links and lists": added the link on docs.example.test']);
  assert.ok(byTitle['Alice Lin changed task "Links and lists": added the link "Spec <b>&</b>"']);
  assert.ok(byTitle['Alice Lin changed task "Links and lists": added the checklist item "Item </content><x>"']);
  assert.equal(byTitle[`Alice Lin created tag "${tag.name}"`].link, 'http://test/whats-new.html', 'a tag entry links to What\'s New');
  assert.equal(byTitle['Bob Ortiz commented on project "Guest page"'].link, `http://test/project.html?id=${p.id}`);
  // For you: others' comments on what alice owns; never her own changes, through Claude or not
  const mcp = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  await t.tokenAs(mcp, 'session-1').post('/api/tasks', { title: 'Alice via Claude' });
  assert.deepEqual(atomEntries(await fetchAtom(mine)).map((e) => e.title), ['Bob Ortiz commented on project "Guest page"']);
  // a session or dev-user header sent along does not change whose feed it is
  const asBob = await fetchAtom(mine, { 'x-dev-user': 'bob', cookie: 'taskscape_dev_user=bob' });
  assert.equal(asBob, await fetchAtom(mine));
  // a repeating task whose copy the reader cannot see: no "next one was created"
  const rep = (await a.post('/api/tasks', { title: 'Weekly', private: true, recurrence: 'weekly', due_date: '2026-11-03' })).body;
  const closed = (await a.patch(`/api/tasks/${rep.id}`, { version: rep.version, status: 'Done' })).body;
  assert.ok(closed.recurred_to);
  assert.ok(atomEntries(await fetchAtom(all)).some((e) => e.title === 'Alice Lin changed task "Weekly": status: To do → Done; it repeats, so the next one was created'));
  await a.patch(`/api/tasks/${rep.id}`, { version: closed.version, private: false });
  const bobs = (await b.post('/api/feeds', { label: 'Bob', scope: 'all' })).body;
  xml = await fetchAtom(bobs);
  assert.ok(atomEntries(xml).some((e) => e.title === 'Alice Lin changed task "Weekly": status: To do → Done'), 'bob sees the close, not the hidden copy');
  assert.equal(xml.includes(closed.recurred_to), false);
  await t.close();
});

test('the Atom feed: one 404 for an unknown, malformed, or revoked link, the same as any missing id', async () => {
  const { t, a, made } = await setup();
  await a.delete(`/api/feeds/${made.body.feed.id}`);
  const missing = await a.get('/api/tasks/00000000-0000-4000-8000-000000000000');
  for (const path of [`/api/feeds/${made.body.plaintext}/activity.atom`, '/api/feeds/tsf_nonsense/activity.atom', `/api/feeds/tsf_${'A'.repeat(43)}/activity.atom`]) {
    const r = await t.anon().get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.text, missing.text, path);
  }
  await t.close();
});

test('the calendar: a task due 9999-12-31 is a one-day event without DTEND; bidi controls never reach a SUMMARY', () => {
  const task = (id, due, title = id) => ({ id, title, status: 'To do', priority: null, project_name: null, due_date: due, updated_at: NOW });
  const cal = renderCalendar({ name: 'X', base: 'https://x.test', stamp: NOW }, [task('last', '9999-12-31'), task('flip', '2026-11-05', 'abc\u202Edef\u2066g\u200fh')]);
  assert.ok(cal.includes('DTSTART;VALUE=DATE:99991231\r\nSUMMARY:last'), 'no DTEND past year 9999');
  assert.equal(cal.includes('+0100'), false);
  assert.ok(cal.includes('SUMMARY:abcdefgh\r\n'));
});
