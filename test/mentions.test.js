// mentions.test.js — @mentions in comments: what counts as one, how they are stored and read, For you and the Atom
// feed's "mine"; and that a mention never grants access: someone who cannot see the item gets nothing from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestApp } from './helpers.js';
import { parseMentions, mentionCandidates, MAX_MENTIONS, MENTION_RE } from '../api/lib/repo/comments.js';

const NOW = '2026-11-02T10:00:00.000Z';

/** A clock that moves a second per call, so entries sort in the order they were written. */
async function app(opts = {}) {
  let n = 0;
  return createTestApp({ now: () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(), ...opts });
}

const forMe = async (client) => (await client.get('/api/activity?for=me')).body.items;

test('what counts as a mention: @id of someone the server knows, never the author, an email, or nobody', async () => {
  assert.deepEqual(parseMentions('@alice hi @Bob, mail me@example.com or (@carol). @alice again @-no @x. @a.b_c-d @josé café@bob @dana@example.com'),
    ['alice', 'Bob', 'carol', 'x.', 'a.b_c-d', 'dana@example.com'], 'greedy words; never an email, nor a word running on into a letter');
  assert.deepEqual(mentionCandidates('bob_.'), ['bob_.', 'bob_', 'bob']);
  const t = await app();
  const b = t.as('bob');
  const task = (await t.as('alice').post('/api/tasks', { title: 'Shared' })).body;
  const r = await b.post(`/api/tasks/${task.id}/comments`, { body: '@Alice and @carol, see this. Not @nobody, not me@example.com, not @bob.' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.mentions, [{ id: 'alice', name: 'Alice Lin' }, { id: 'carol', name: 'Carol Nkemelu' }], 'case-insensitive; in text order; the author is left out');
  assert.equal(r.body.body, '@Alice and @carol, see this. Not @nobody, not me@example.com, not @bob.', 'the text is kept as written');
  const list = (await t.as('carol').get(`/api/tasks/${task.id}/comments`)).body.items;
  assert.deepEqual(list[0].mentions.map((m) => m.id), ['alice', 'carol'], 'every read carries them');
  await t.close();
});

test('For you: a comment that mentions you, with words for it, in What\'s New and the Atom feed', async () => {
  const t = await app();
  const a = t.as('alice');
  const b = t.as('bob');
  const c = t.as('carol');
  const task = (await a.post('/api/tasks', { title: 'Launch plan' })).body;
  await b.post(`/api/tasks/${task.id}/comments`, { body: '@carol can you check the dates?' });
  await b.post(`/api/tasks/${task.id}/comments`, { body: 'A plain comment' });
  // carol owns nothing here: only the mention reaches her For you
  const mine = await forMe(c);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].actor_id, mine[0].item_type, mine[0].action, mine[0].mentions_you], ['bob', 'comment', 'create', true]);
  // alice owns the task: both comments, neither mentions her
  assert.deepEqual((await forMe(a)).map((e) => e.mentions_you), [false, false]);
  // the everything view marks it too, for carol only
  assert.equal((await c.get('/api/activity')).body.items.filter((e) => e.mentions_you).length, 1);
  assert.equal((await a.get('/api/activity')).body.items.filter((e) => e.mentions_you).length, 0);
  // the Atom feed's "mine" is For you
  const feed = (await c.post('/api/feeds', { label: 'Mine', scope: 'mine' })).body;
  const xml = (await t.anon().get(`/api/feeds/${feed.plaintext}/activity.atom`)).text;
  assert.ok(xml.includes('<title type="text">Bob Ortiz mentioned you in a comment on task &quot;Launch plan&quot;</title>'));
  assert.equal(xml.includes('check the dates'), false, 'the feed never carries comment text');
  // mentioning yourself stores nothing and reaches nobody
  const self = (await c.post(`/api/tasks/${task.id}/comments`, { body: 'note to @carol' })).body;
  assert.deepEqual(self.mentions, []);
  await t.close();
});

test('privacy: a mention never grants access; nothing reaches someone who cannot see the item', async () => {
  const t = await app();
  const a = t.as('alice');
  const b = t.as('bob');
  const priv = (await a.post('/api/tasks', { title: 'Salary review', private: true })).body;
  const P = (await a.post('/api/projects', { name: 'Secret plans', private: true })).body;
  const r = await a.post(`/api/tasks/${priv.id}/comments`, { body: '@bob look at this' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.mentions.map((m) => m.id), ['bob'], 'stored (refusing it would tell alice something about bob)');
  await a.post(`/api/projects/${P.id}/comments`, { body: '@bob and this' });
  const feed = (await b.post('/api/feeds', { label: 'Mine', scope: 'mine' })).body;
  const nothing = async () => {
    assert.deepEqual(await forMe(b), [], 'no For you entry, so no unread count');
    const all = JSON.stringify((await b.get('/api/activity?limit=200')).body);
    for (const s of ['Salary review', 'Secret plans', priv.id, P.id, r.body.id]) assert.equal(all.includes(s), false, s);
    assert.equal((await b.get(`/api/tasks/${priv.id}/comments`)).status, 404);
    const xml = (await t.anon().get(`/api/feeds/${feed.plaintext}/activity.atom`)).text;
    assert.equal(xml.includes('<entry>'), false);
  };
  await nothing();
  // the item becomes visible: the mention reaches bob then, like the rest of its history
  await a.patch(`/api/tasks/${priv.id}`, { version: priv.version, private: false });
  const now = await forMe(b);
  assert.equal(now.length, 1);
  assert.equal(now[0].mentions_you, true);
  // and goes again when it is private again
  await a.patch(`/api/tasks/${priv.id}`, { version: priv.version + 1, private: true });
  await nothing();
  // a public task moved into a private project takes its mentions out of sight too
  const pub = (await a.post('/api/tasks', { title: 'Moving' })).body;
  await a.post(`/api/tasks/${pub.id}/comments`, { body: 'hey @bob' });
  assert.equal((await forMe(b)).length, 1);
  await a.patch(`/api/tasks/${pub.id}`, { version: pub.version, project_id: P.id, private: true });
  await nothing();
  await t.close();
});

test('limits and doors: at most 20 people; @words that are nobody do not count; a token resolves only what it may list; trash withdraws a mention', async () => {
  const people = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, groups: [] }));
  const t = await app({ config: { auth: { dev: { users: [{ id: 'alice', name: 'Alice Lin', groups: [] }, { id: 'bob', name: 'Bob Ortiz', groups: [] }, ...people] } } } });
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'Big' })).body;
  let r = await a.post(`/api/tasks/${task.id}/comments`, { body: people.map((p) => `@${p.id}`).join(' ') });
  assert.equal(r.status, 201, 'never a refusal, which would answer "are these all people?" without a trace');
  assert.deepEqual(r.body.mentions.map((m) => m.id), people.slice(0, MAX_MENTIONS).map((p) => p.id), 'the first 20; the rest are text');
  r = await a.post(`/api/tasks/${task.id}/comments`, { body: Array.from({ length: 40 }, (_, i) => `@word${i}`).join(' ') });
  assert.equal(r.status, 201, 'forty @words that are nobody are just text');
  assert.deepEqual(r.body.mentions, []);
  // through an MCP token: only people the token may list (owners of what it sees), never the directory
  const plain = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  r = await t.tokenAs(plain).post(`/api/tasks/${task.id}/comments`, { body: 'from Claude: @bob' });
  assert.deepEqual(r.body.mentions, [], 'bob owns nothing alice can see, so a token cannot learn his name');
  await t.as('bob').post('/api/tasks', { title: 'Bob owns this' });
  r = await t.tokenAs(plain).post(`/api/tasks/${task.id}/comments`, { body: 'from Claude: @bob' });
  assert.deepEqual(r.body.mentions, [{ id: 'bob', name: 'Bob Ortiz' }]);
  assert.equal((await forMe(t.as('bob')))[0].via, 'mcp');
  // a trashed comment: only its author sees it, mentions and all, and its mention reaches nobody
  await a.delete(`/api/comments/${r.body.id}`, { version: r.body.version });
  assert.deepEqual(await forMe(t.as('bob')), [], 'no For you entry, so no unread count');
  assert.equal((await t.as('bob').get('/api/activity')).body.items.some((e) => e.mentions_you), false);
  const feed = (await t.as('bob').post('/api/feeds', { label: 'Mine', scope: 'mine' })).body;
  assert.equal((await t.anon().get(`/api/feeds/${feed.plaintext}/activity.atom`)).text.includes('<entry>'), false);
  const forBob = (await t.as('bob').get(`/api/tasks/${task.id}/comments`)).body.items;
  assert.equal(forBob.some((x) => x.id === r.body.id), false);
  const forAlice = (await a.get(`/api/tasks/${task.id}/comments`)).body.items.find((x) => x.id === r.body.id);
  assert.deepEqual(forAlice.mentions.map((m) => m.id), ['bob']);
  await t.close();
});

test('who a word names: punctuation at the end, email-style ids, case only for the directory, names it may already list', async () => {
  const t = await app({ config: { auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: [] }, { id: 'bob', name: 'Bob Ortiz', groups: [] }, { id: 'bob_', name: 'Bobby Under', groups: [] },
    { id: 'carol', name: 'Carol Nkemelu', groups: [] }] } } } });
  const a = t.as('alice');
  const task = (await a.post('/api/tasks', { title: 'Shared' })).body;
  const say = async (body, who = 'carol') => (await t.as(who).post(`/api/tasks/${task.id}/comments`, { body })).body.mentions.map((m) => m.id);
  assert.deepEqual(await say('@bob_ please'), ['bob_'], 'an id that ends in "_" is that id, not bob');
  assert.deepEqual(await say('thanks @bob.'), ['bob'], 'a full stop after a name is punctuation');
  assert.deepEqual(await say('@BOB and @Alice'), ['bob', 'alice'], 'directory ids ignore case');
  // an owner id made up to differ from alice only in case cannot take her mentions
  await t.as('bob').post('/api/tasks', { title: 'Decoy', owner_id: 'Alice', owner_name: 'Alice Lin' });
  assert.deepEqual(await say('@alice look'), ['alice']);
  assert.deepEqual(await say('@ALICE look'), ['alice'], 'loosely, only the directory');
  assert.deepEqual(await say('@Alice look'), ['alice'], 'the directory person before a made-up id, even typed in its case');
  await t.close();

  // headers: ids can look like email addresses; there is no directory, so only owners the author can see
  const h = await app({ config: { auth: { provider: 'headers' } } });
  const as = (id, name) => h.withHeaders({ 'x-forwarded-user': id, 'x-forwarded-preferred-username': name });
  const una = as('una@example.test', 'Una');
  const t2 = (await as('dana@example.test', 'Dana').post('/api/tasks', { title: 'Dana owns this' })).body;
  await as('zed@example.test', 'Zed').post('/api/tasks', { title: 'Zed private', private: true });
  const r = await una.post(`/api/tasks/${t2.id}/comments`, { body: '@dana@example.test please, and @zed@example.test' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.mentions, [{ id: 'dana@example.test', name: 'Dana' }], 'zed owns only a private task una cannot see');
  await h.close();
});

test('an export of a project with very many comments still reads their mentions', async () => {
  const t = await app();
  const a = t.as('alice');
  const P = (await a.post('/api/projects', { name: 'Chatty' })).body;
  // 70 tasks with 480 comments each, under the guestbook cap, and past SQLite's 32,766 placeholders in one query;
  // straight into the tables: the point is the number of rows, not 33,600 requests
  let last = null;
  for (let k = 0; k < 70; k++) {
    last = (await a.post('/api/tasks', { project_id: P.id, title: `Busy ${k}` })).body;
    for (let i = 0; i < 480; i++) {
      const id = `c${k}-${i}`;
      await t.db.query('INSERT INTO comments (id, item_type, item_id, author_id, author_name, body, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [id, 'task', last.id, 'bob', 'Bob Ortiz', `hi @alice ${i}`, NOW, NOW]);
      await t.db.query('INSERT INTO comment_mentions (comment_id, person_id, person_name) VALUES (?, ?, ?)', [id, 'alice', 'Alice Lin']);
    }
  }
  const r = await a.get(`/api/projects/${P.id}/export.md`);
  assert.equal(r.status, 200);
  const list = (await a.get(`/api/tasks/${last.id}/comments`)).body.items;
  assert.equal(list.filter((c) => c.mentions.length === 1).length, 480);
  await t.close();
});

test('the comment box reads mentions exactly as the server does', () => {
  // public/js/mentions.js imports the DOM helpers, so compare its source text rather than load it
  const ui = readFileSync(new URL('../public/js/mentions.js', import.meta.url), 'utf8');
  assert.ok(ui.includes(`export const MENTION_RE = ${MENTION_RE.toString()};`), 'the same pattern, character for character');
  const candidates = /function candidates\(word\) \{[\s\S]*?\n\}/.exec(ui)?.[0] ?? '';
  assert.ok(candidates.includes("while (/[._@+-]$/.test(w)) { w = w.slice(0, -1); out.push(w); }"), 'the same candidates');
});

test('restore brings a mention back; under password a token or a read-only reader resolves no directory name', async () => {
  const t = await app({ config: { auth: { provider: 'password' }, permissions: { edit: 'group', groups: ['editors'] } } });
  const users = await import('../api/lib/repo/users.js');
  const tasks = await import('../api/lib/repo/tasks.js');
  const comments = await import('../api/lib/repo/comments.js');
  for (const [id, name, groups] of [['dana', 'Dana Fox', ['editors']], ['erin', 'Erin Moss', ['editors']], ['gus', 'Gus Read', []]]) {
    await users.create(t.db, { id, name, email: null, groups }, 'x', NOW);
  }
  const who = (id, name, groups, via = 'ui') => ({ id, name, groups, via, auth: 'password', ...(via === 'mcp' ? { session_id: 's1' } : {}) });
  const dana = who('dana', 'Dana Fox', ['editors']);
  const task = await tasks.create(t.db, dana, { title: 'Shared' }, t.config, NOW);
  // dana in the browser may pick erin from the directory; her token may not
  let c = await comments.create(t.db, dana, 'task', task.id, 'hi @ERIN', NOW, t.config);
  assert.deepEqual(c.mentions, [{ id: 'erin', name: 'Erin Moss' }]);
  c = await comments.create(t.db, who('dana', 'Dana Fox', ['editors'], 'mcp'), 'task', task.id, 'hi @erin', NOW, t.config);
  assert.deepEqual(c.mentions, [], 'a token never resolves the directory');
  // what a reader sees in another author's comment is that author's choice: the id and name show to every reader
  const forGus = await comments.listFor(t.db, who('gus', 'Gus Read', []), 'task', task.id);
  assert.deepEqual(forGus[0].mentions, [{ id: 'erin', name: 'Erin Moss' }]);
  // trash withdraws a mention; restore brings it back
  const erin = who('erin', 'Erin Moss', ['editors']);
  const activity = await import('../api/lib/repo/activity.js');
  const mine = async () => (await activity.list(t.db, erin, { limit: 50, for_me: true })).items.length;
  const first = (await comments.listFor(t.db, dana, 'task', task.id))[0];
  assert.equal(await mine(), 1);
  const trashed = await comments.trash(t.db, dana, first.id, first.version, NOW);
  assert.equal(await mine(), 0);
  await comments.restore(t.db, dana, first.id, trashed.version, NOW);
  assert.equal(await mine(), 1);
  await t.close();
});
