import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY, tickingClock } from './helpers.js';
import * as users from '../api/lib/repo/users.js';
import * as tokens from '../api/lib/repo/tokens.js';
import * as sessions from '../api/lib/repo/sessions.js';

/** alice: public project P {T1 public, T2 private}; carol: private project S {S1}. bob is the outsider. */
async function seed(t) {
  const a = t.as('alice'); const c = t.as('carol');
  const P = (await a.post('/api/projects', { name: 'Public plan', description: 'open to all' })).body;
  const T1 = (await a.post('/api/tasks', { title: 'Visible task', project_id: P.id, notes: 'hello world' })).body;
  const T2 = (await a.post('/api/tasks', { title: 'Hidden task', project_id: P.id, private: true, notes: 'secret notes' })).body;
  const S = (await c.post('/api/projects', { name: 'Secret reorg', private: true, description: 'confidential' })).body;
  const S1 = (await c.post('/api/tasks', { title: 'Secret task', project_id: S.id, notes: 'classified' })).body;
  return { a, c, b: t.as('bob'), P, T1, T2, S, S1 };
}

test('every read path hides other people\'s private items, and 404s are byte-identical to missing ids', async () => {
  const t = await createTestApp();
  const { b, c, P, T1, T2, S, S1 } = await seed(t);
  const missing = await b.get('/api/projects/no-such-id');
  const ids = (list) => list.map((x) => x.id);

  // lists
  assert.deepEqual(ids((await b.get('/api/projects')).body.items).sort(), [P.id, 'general'].sort());
  assert.deepEqual(ids((await b.get('/api/tasks')).body.items), [T1.id]);
  assert.deepEqual(ids((await b.get(`/api/tasks?project=${S.id}`)).body.items), []);
  assert.deepEqual(ids((await b.get('/api/tasks?include_trashed=true')).body.items), [T1.id]);
  // gets: same bytes as a missing id
  for (const path of [`/api/projects/${S.id}`, `/api/tasks/${T2.id}`, `/api/tasks/${S1.id}`, `/api/projects/${S.id}/export.md`]) {
    const r = await b.get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.text, missing.text, path);
    assert.deepEqual(r.body, NOT_FOUND_BODY);
  }
  // search
  const s = (await b.get('/api/search?q=secret')).body;
  assert.deepEqual(s, { projects: [], tasks: [] });
  const s2 = (await b.get('/api/search?q=classified')).body;
  assert.deepEqual(s2.tasks, []);
  assert.deepEqual(ids((await b.get('/api/search?q=hidden')).body.tasks), []);
  assert.deepEqual(ids((await b.get('/api/search?q=visible')).body.tasks), [T1.id]);
  // export of the public project omits the private task
  const md = (await b.get(`/api/projects/${P.id}/export.md`)).text;
  assert.ok(md.includes('Visible task'));
  assert.equal(md.includes('Hidden task'), false);
  assert.equal(md.includes('secret notes'), false);
  // activity: nothing about S, S1, or T2 for bob; everything for the owners
  const bobAct = (await b.get('/api/activity')).body.items;
  assert.equal(bobAct.some((e) => [S.id, S1.id, T2.id].includes(e.item_id)), false);
  assert.equal(bobAct.some((e) => e.item_id === T1.id), true);
  const carolAct = (await c.get('/api/activity')).body.items;
  assert.equal(carolAct.some((e) => e.item_id === S1.id), true);
  // activity filtered by project id does not leak either
  assert.deepEqual((await b.get(`/api/activity?project=${S.id}`)).body.items, []);
  // trash: carol trashes S1; bob's trash is empty
  await c.delete(`/api/tasks/${S1.id}`, { version: 1 });
  assert.deepEqual((await b.get('/api/trash')).body, { projects: [], tasks: [] });
  assert.deepEqual(ids((await c.get('/api/trash')).body.tasks), [S1.id]);
  // error messages never mention the item
  const all = JSON.stringify([missing.body, s, bobAct]);
  for (const word of ['Secret', 'Hidden', 'classified', 'confidential']) assert.equal(all.includes(word), false, word);
  await t.close();
});

test('write paths against a private item are the same 404', async () => {
  const t = await createTestApp();
  const { b, a, S, S1, T2, T1 } = await seed(t);
  const tag = (await b.post('/api/tags', { name: 'x' })).body;
  const missing = (await b.get('/api/projects/no-such-id')).text;
  const attempts = [
    b.patch(`/api/projects/${S.id}`, { version: 1, name: 'pwned' }),
    b.delete(`/api/projects/${S.id}`, { version: 1 }),
    b.post(`/api/projects/${S.id}/restore`, { version: 1 }),
    b.put(`/api/projects/${S.id}/tags/${tag.id}`, { version: 1 }),
    b.post(`/api/projects/${S.id}/hit`),
    b.post('/api/tasks', { title: 'sneak in', project_id: S.id }),
    b.patch(`/api/tasks/${T1.id}`, { version: 1, project_id: S.id }),
    b.patch(`/api/tasks/${T2.id}`, { version: 1, title: 'pwned' }),
    b.patch(`/api/tasks/${S1.id}`, { version: 1, title: 'pwned' }),
    b.delete(`/api/tasks/${T2.id}`, { version: 1 }),
    b.put(`/api/tasks/${T2.id}/tags/${tag.id}`, { version: 1 }),
  ];
  for (const r of await Promise.all(attempts)) {
    assert.equal(r.status, 404);
    assert.equal(r.text, missing);
  }
  // nothing changed
  assert.equal((await a.get(`/api/tasks/${T2.id}`)).body.title, 'Hidden task');
  assert.equal((await a.get(`/api/tasks/${T1.id}`)).body.project_id, (await a.get(`/api/tasks/${T1.id}`)).body.project_id);
  await t.close();
});

test('a private task in a public project is hidden; tags on it do not surface it via tag filters', async () => {
  const t = await createTestApp();
  const { a, b, P, T2 } = await seed(t);
  const tag = (await a.post('/api/tags', { name: 'q4' })).body;
  await a.put(`/api/tasks/${T2.id}/tags/${tag.id}`, { version: 1 });
  assert.equal((await b.get(`/api/projects/${P.id}`)).status, 200);
  assert.deepEqual((await b.get('/api/tasks?tag=q4')).body.items, []);
  const tags = (await b.get('/api/tags')).body.items;
  assert.deepEqual(tags.map((x) => x.name), ['q4']); // names are public, counts do not exist
  assert.equal('count' in tags[0], false);
  await t.close();
});

test('only the owner can flip private; flipping hides and reveals the full history', async () => {
  const t = await createTestApp();
  const { a, b, T1 } = await seed(t);
  let r = await b.patch(`/api/tasks/${T1.id}`, { version: 1, private: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
  await b.patch(`/api/tasks/${T1.id}`, { version: 1, status: 'Doing' }); // bob may still edit other fields
  const entriesBefore = (await b.get(`/api/activity?item_id=${T1.id}`)).body.items.length;
  assert.equal(entriesBefore, 2);
  r = await a.patch(`/api/tasks/${T1.id}`, { version: 2, private: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.private, true);
  assert.deepEqual((await b.get('/api/tasks')).body.items, []);
  assert.deepEqual((await b.get(`/api/activity?item_id=${T1.id}`)).body.items, []);
  assert.equal((await b.get(`/api/tasks/${T1.id}`)).status, 404);
  r = await a.patch(`/api/tasks/${T1.id}`, { version: 3, private: false });
  assert.equal(r.status, 200);
  assert.equal((await b.get(`/api/tasks/${T1.id}`)).status, 200);
  const after = (await b.get(`/api/activity?item_id=${T1.id}`)).body.items;
  assert.equal(after.length, 4); // create, bob's edit, flip on, flip off: all visible again
  await t.close();
});

test('reassigning a private item passes it, and its history, to the new owner', async () => {
  const t = await createTestApp();
  const { a, b, T2 } = await seed(t);
  const r = await a.patch(`/api/tasks/${T2.id}`, { version: 1, owner_id: 'bob', owner_name: 'Bob Ortiz' });
  assert.equal(r.status, 200); // the writer sees the result once
  assert.equal(r.body.owner_id, 'bob');
  assert.equal((await a.get(`/api/tasks/${T2.id}`)).status, 404);
  assert.equal((await b.get(`/api/tasks/${T2.id}`)).status, 200);
  assert.equal((await b.get(`/api/activity?item_id=${T2.id}`)).body.items.length, 2);
  assert.deepEqual((await a.get(`/api/activity?item_id=${T2.id}`)).body.items, []);
  // bob, now the owner, can make it public; alice could not have
  assert.equal((await b.patch(`/api/tasks/${T2.id}`, { version: 2, private: false })).status, 200);
  await t.close();
});

test('creating a private item for someone else is refused', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/projects', { name: 'Gift', private: true, owner_id: 'bob', owner_name: 'Bob' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  r = await a.post('/api/tasks', { title: 'Gift', private: true, owner_id: 'bob', owner_name: 'Bob' });
  assert.equal(r.status, 400);
  assert.equal((await t.as('bob').get('/api/trash')).body.projects.length, 0);
  assert.equal((await a.get('/api/projects')).body.items.length, 1); // only General
  await t.close();
});

test('a private project only contains its owner\'s tasks: flipping moves the others to the catch-all', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const { a, b, P } = await seed(t);
  const B1 = (await b.post('/api/tasks', { title: 'Bob in P', project_id: P.id })).body;
  const B2 = (await b.post('/api/tasks', { title: 'Bob trashed in P', project_id: P.id })).body;
  await b.delete(`/api/tasks/${B2.id}`, { version: 1 });
  const r = await a.patch(`/api/projects/${P.id}`, { version: 1, private: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.private, true);
  assert.equal(r.body.moved_tasks, 2);
  // bob still owns them, now under General, with a visible activity entry written by alice
  const b1 = (await b.get(`/api/tasks/${B1.id}`)).body;
  assert.equal(b1.project_id, 'general');
  assert.equal(b1.version, 2);
  const entry = (await b.get(`/api/activity?item_id=${B1.id}`)).body.items[0];
  assert.equal(entry.actor_id, 'alice');
  assert.deepEqual(entry.changes, { project_id: { from: null, to: 'general' } }); // P is private to alice now, so bob sees no id
  const b2 = (await b.get(`/api/tasks/${B2.id}`)).body;
  assert.equal(b2.project_id, 'general');
  assert.ok(b2.deleted_at);
  // alice's own tasks stayed; bob sees nothing of P now
  assert.deepEqual((await a.get(`/api/tasks?project=${P.id}`)).body.items.map((x) => x.title).sort(), ['Hidden task', 'Visible task']);
  assert.equal((await b.get(`/api/projects/${P.id}`)).status, 404);
  assert.equal((await b.get(`/api/activity?item_id=${P.id}`)).body.items.length, 0);
  // the invariant is enforced on the other doors
  let x = await a.post('/api/tasks', { title: 'for bob', project_id: P.id, owner_id: 'bob', owner_name: 'Bob' });
  assert.equal(x.status, 400); assert.equal(x.body.error.code, 'invalid_state');
  const mine = (await a.post('/api/tasks', { title: 'mine', project_id: P.id })).body;
  x = await a.patch(`/api/tasks/${mine.id}`, { version: 1, owner_id: 'bob', owner_name: 'Bob' });
  assert.equal(x.status, 400); assert.equal(x.body.error.code, 'invalid_state');
  x = await a.patch(`/api/tasks/${B1.id}`, { version: 2, project_id: P.id });
  assert.equal(x.status, 400); assert.equal(x.body.error.code, 'invalid_state');
  assert.equal(JSON.stringify(x.body).includes('Bob'), false);
  // flipping back public: no moves, no count
  const back = await a.patch(`/api/projects/${P.id}`, { version: 2, private: false });
  assert.equal(back.body.moved_tasks, undefined);
  await t.close();
});

test('moved_tasks never counts tasks the flipper could not see', async () => {
  const t = await createTestApp();
  const a = t.as('alice'); const b = t.as('bob'); const c = t.as('carol');
  const P = (await a.post('/api/projects', { name: 'Public plan' })).body;
  await b.post('/api/tasks', { title: 'Bob public', project_id: P.id });
  const secret = (await b.post('/api/tasks', { title: 'Bob secret', project_id: P.id, private: true })).body;
  await c.post('/api/tasks', { title: 'Carol secret', project_id: P.id, private: true });
  const r = await a.patch(`/api/projects/${P.id}`, { version: 1, private: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved_tasks, 1); // three moved, one was visible to alice
  assert.equal((await b.get(`/api/tasks/${secret.id}`)).body.project_id, 'general'); // but they did all move
  // non-owner takeover: bob takes a public project with alice's private task and flips it
  const Q = (await a.post('/api/projects', { name: 'Q' })).body;
  await a.post('/api/tasks', { title: 'alice secret in Q', project_id: Q.id, private: true });
  await b.patch(`/api/projects/${Q.id}`, { version: 1, owner_id: 'bob', owner_name: 'Bob Ortiz' });
  const flip = await b.patch(`/api/projects/${Q.id}`, { version: 2, private: true });
  assert.equal(flip.body.moved_tasks, 0);
  await t.close();
});

test('a task\'s history does not keep the id of a project that went private', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const a = t.as('alice'); const b = t.as('bob'); const c = t.as('carol');
  const S = (await c.post('/api/projects', { name: 'S' })).body;
  const T = (await a.post('/api/tasks', { title: 'Alice in S', project_id: S.id })).body;
  await c.patch(`/api/projects/${S.id}`, { version: 1, private: true });
  for (const who of [a, b]) {
    const items = (await who.get(`/api/activity?item_id=${T.id}`)).body.items;
    assert.equal(items.length, 2);
    assert.equal(JSON.stringify(items).includes(S.id), false);
    assert.deepEqual(items[0].changes, { project_id: { from: null, to: 'general' } });
    assert.deepEqual(items[1].changes.project_id, { to: null });
  }
  // carol, the owner, still sees the id
  const own = (await c.get(`/api/activity?item_id=${T.id}`)).body.items;
  assert.deepEqual(own[0].changes, { project_id: { from: S.id, to: 'general' } });
  await t.close();
});

test('reassigning a private project moves tasks the new owner does not own', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const P = (await a.post('/api/projects', { name: 'Mine', private: true })).body;
  const mine = (await a.post('/api/tasks', { title: 'mine', project_id: P.id })).body;
  const r = await a.patch(`/api/projects/${P.id}`, { version: 1, owner_id: 'bob', owner_name: 'Bob Ortiz' });
  assert.equal(r.status, 200);
  assert.equal(r.body.owner_id, 'bob');
  assert.equal(r.body.moved_tasks, 1);
  assert.equal((await a.get(`/api/projects/${P.id}`)).status, 404);
  assert.equal((await a.get(`/api/tasks/${mine.id}`)).body.project_id, 'general');
  assert.equal((await t.as('bob').get(`/api/projects/${P.id}`)).status, 200);
  await t.close();
});

test('the catch-all project is always public and always there', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  for (const body of [{ version: 1, private: true }, { version: 1, owner_id: 'alice' }]) {
    const r = await a.patch('/api/projects/general', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, 'invalid_state');
  }
  const ok = await a.patch('/api/projects/general', { version: 1, name: 'Inbox', status: 'Active' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Inbox');
  assert.equal((await a.post('/api/tasks', { title: 'orphan' })).body.project_name, 'Inbox');
  await t.close();
});

test('people never includes owners known only through private items', async () => {
  const t = await createTestApp({ config: { auth: { provider: 'headers' } } });
  const as = (id, name) => t.withHeaders({ 'x-forwarded-user': id, 'x-forwarded-preferred-username': name });
  await as('ghost', 'Ghost').post('/api/projects', { name: 'Haunted', private: true });
  await as('dave', 'Dave').post('/api/projects', { name: 'Open' });
  const seen = (await as('bob', 'Bob').get('/api/people')).body.items.map((p) => p.id).sort();
  assert.deepEqual(seen, ['bob', 'dave']);
  await t.close();
});

test('a token sees exactly what its owner sees', async () => {
  const t = await createTestApp();
  const { a, b, T2, S } = await seed(t);
  const { plaintext: aliceTok } = (await a.post('/api/tokens', { label: 'a' })).body;
  const { plaintext: bobTok } = (await b.post('/api/tokens', { label: 'b' })).body;
  assert.equal((await t.tokenAs(aliceTok).get(`/api/tasks/${T2.id}`)).status, 200);
  assert.equal((await t.tokenAs(bobTok).get(`/api/tasks/${T2.id}`)).status, 404);
  assert.equal((await t.tokenAs(aliceTok).get(`/api/projects/${S.id}`)).status, 404);
  await t.close();
});

test('people under the password provider: directory rows, never owners known only through private items', async () => {
  const t = await createTestApp({ config: { auth: { provider: 'password' } } });
  const now = '2026-11-01T09:00:00.000Z';
  for (const [id, name] of [['dana', 'Dana Fox'], ['eli', 'Eli Moss']]) await users.create(t.db, { id, name, groups: [] }, 'scrypt$x', now);
  const token = async (u) => t.tokenAs((await tokens.issue(t.db, u, 'test', now)).plaintext);
  const dana = await token({ id: 'dana', name: 'Dana Fox', groups: [] });
  const eli = await token({ id: 'eli', name: 'Eli Moss', groups: [] });
  // dana's private project holds a task assigned to an id with no users row: that name exists only inside private items
  const secret = (await dana.post('/api/projects', { name: 'Secret', private: true })).body;
  await dana.post('/api/tasks', { title: 'Hidden', project_id: secret.id, private: true });
  // ghost has no users row (say, from before a switch to password) and owns only a private project
  await dana.post('/api/projects', { name: 'Ghost', owner_id: 'ghost', owner_name: 'Ghost Writer' });
  await t.db.query("UPDATE projects SET private = 1 WHERE owner_id = 'ghost'"); // ghost cannot sign in to flip it, so the test does
  // eli in the browser, an editor, gets the directory for the owner picker
  const session = await sessions.create(t.db, 'eli', new Date().toISOString(), 1);
  const eliBrowser = t.withHeaders({ cookie: `${t.config.auth.password.cookie_name}=${session.plaintext}` });
  const seen = (await eliBrowser.get('/api/people')).body.items;
  assert.deepEqual(seen.map((p) => p.id).sort(), ['dana', 'eli']);
  assert.equal(seen.some((p) => p.name === 'Ghost Writer'), false);
  assert.equal(seen.some((p) => p.id === 'system'), false);
  // a token has no owner picker, so it is not handed the directory (usernames are not secret: see people.js)
  assert.deepEqual((await eli.get('/api/people')).body.items.map((p) => p.id), ['eli']);
  await t.close();
});

test('people: a read-only account gets no directory, only owners of what it can see', async () => {
  const t = await createTestApp({ config: {
    permissions: { edit: 'group', groups: ['editors'] },
    auth: { dev: { users: [
      { id: 'alice', name: 'Alice Lin', groups: ['editors'] },
      { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] },
      { id: 'zed', name: 'Zed', groups: ['viewers'] },
    ] } },
  } });
  await t.as('alice').post('/api/projects', { name: 'Open' });
  assert.deepEqual((await t.as('zed').get('/api/people')).body.items.map((p) => p.id).sort(), ['alice', 'zed']);
  assert.deepEqual((await t.as('alice').get('/api/people')).body.items.map((p) => p.id).sort(), ['alice', 'bob', 'zed']);
  await t.close();
});

test('owner fields on a write: a private id and a missing id answer byte for byte the same', async () => {
  const t = await createTestApp({ config: { auth: { provider: 'password' } } });
  const now = '2026-11-01T09:00:00.000Z';
  for (const [id, name] of [['dana', 'Dana Fox'], ['eli', 'Eli Moss']]) await users.create(t.db, { id, name, groups: [] }, 'scrypt$x', now);
  const dana = t.tokenAs((await tokens.issue(t.db, { id: 'dana', name: 'Dana Fox', groups: [] }, 'd', now)).plaintext);
  const eli = t.tokenAs((await tokens.issue(t.db, { id: 'eli', name: 'Eli Moss', groups: [] }, 'e', now)).plaintext);
  const P = (await dana.post('/api/projects', { name: 'Secret', private: true })).body;
  const T = (await dana.post('/api/tasks', { title: 'Secret', project_id: P.id })).body;
  for (const body of [{ owner_id: 'dana' }, { owner_id: 'eli' }, { owner_id: 'nobody', owner_name: 'N' }, { owner_id: 'dana', owner_name: 'X' }, { version: 9, owner_id: 'dana' }]) {
    for (const [kind, id] of [['projects', P.id], ['tasks', T.id]]) {
      const hidden = await eli.patch(`/api/${kind}/${id}`, { version: 1, ...body });
      const missing = await eli.patch(`/api/${kind}/no-such-id`, { version: 1, ...body });
      assert.equal(hidden.status, missing.status, JSON.stringify(body));
      assert.equal(hidden.text, missing.text, JSON.stringify(body));
    }
  }
  await t.close();
});

test('the task owner filter (My tasks) stacks on the privacy predicate', async () => {
  const t = await createTestApp();
  const { a, b, c, P, T2, S, S1 } = await seed(t);
  const mineBob = (await b.post('/api/tasks', { title: 'Bob public', project_id: P.id })).body;
  const ids = async (client, owner) => (await client.get(`/api/tasks?owner=${owner}`)).body.items.map((x) => x.id);
  assert.deepEqual(await ids(b, 'me'), [mineBob.id]);
  assert.deepEqual(await ids(b, 'carol'), []); // S1 sits in carol's private project
  assert.equal((await ids(b, 'alice')).includes(T2.id), false); // alice's private task
  assert.ok((await ids(a, 'me')).includes(T2.id));
  assert.deepEqual(await ids(c, 'me'), [S1.id]);
  assert.ok(S.private);
  await t.close();
});

test('for=me uses the same read-time visibility: what I no longer own or can no longer see drops out', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const { a, b, c, P, T2, S, S1 } = await seed(t);
  // bob owns a task in alice's public project and a project of his own
  const BT = (await b.post('/api/tasks', { title: 'Bob in P', project_id: P.id })).body;
  const BQ = (await b.post('/api/projects', { name: 'Bob plan' })).body;
  await a.patch(`/api/tasks/${BT.id}`, { version: BT.version, status: 'Doing' });
  await c.patch(`/api/projects/${BQ.id}`, { version: BQ.version, status: 'Active' });
  const ids = async () => (await b.get('/api/activity?for=me')).body.items.map((e) => e.item_id);
  assert.deepEqual((await ids()).sort(), [BT.id, BQ.id].sort());
  // nothing about other people's private items, even asked for directly
  for (const id of [T2.id, S.id, S1.id]) assert.deepEqual((await b.get(`/api/activity?for=me&item_id=${id}`)).body.items, []);
  // alice flips P private: bob's task moves to General; the entry stays his, without naming the private project
  const p = (await a.get(`/api/projects/${P.id}`)).body;
  await a.patch(`/api/projects/${P.id}`, { version: p.version, private: true });
  const moved = (await b.get(`/api/activity?for=me&item_id=${BT.id}`)).body.items[0];
  assert.equal(moved.actor_id, 'alice');
  assert.deepEqual(moved.changes, { project_id: { from: null, to: 'general' } });
  // bob hands his project to carol, who makes it private: its history leaves bob's view entirely
  const q = (await b.get(`/api/projects/${BQ.id}`)).body;
  await b.patch(`/api/projects/${BQ.id}`, { version: q.version, owner_id: 'carol' });
  const q2 = (await c.get(`/api/projects/${BQ.id}`)).body;
  await c.patch(`/api/projects/${BQ.id}`, { version: q2.version, private: true });
  assert.equal((await ids()).includes(BQ.id), false);
  assert.deepEqual((await b.get(`/api/activity?item_id=${BQ.id}`)).body.items, []);
  await t.close();
});

test('handing over a private project keeps the old owner\'s moved tasks hidden, with their history and guestbooks', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const [a, b, c] = ['alice', 'bob', 'carol'].map((u) => t.as(u));
  const S = (await c.post('/api/projects', { name: 'Reorg', private: true })).body;
  const CT = (await c.post('/api/tasks', { title: 'Layoff list', project_id: S.id, notes: 'names here' })).body;
  await c.post(`/api/tasks/${CT.id}/comments`, { body: 'draft: cut team X' });
  const TT = (await c.post('/api/tasks', { title: 'Trashed secret', project_id: S.id })).body;
  await c.delete(`/api/tasks/${TT.id}`, { version: TT.version });
  const PT = (await c.post('/api/tasks', { title: 'Already private', project_id: S.id, private: true })).body;
  const handed = await c.patch(`/api/projects/${S.id}`, { version: S.version, owner_id: 'alice', owner_name: 'Alice Lin' });
  assert.equal(handed.status, 200);
  assert.equal(handed.body.moved_tasks, 3);
  const missing = await b.get('/api/tasks/no-such-id');
  for (const path of [`/api/tasks/${CT.id}`, `/api/tasks/${CT.id}/comments`, `/api/tasks/${TT.id}`, `/api/tasks/${PT.id}`]) {
    for (const who of [a, b]) assert.equal((await who.get(path)).text, missing.text, path);
  }
  for (const who of [a, b]) {
    const seen = JSON.stringify([(await who.get('/api/activity?limit=200')).body, (await who.get('/api/activity?for=me')).body,
      (await who.get(`/api/activity?project=${S.id}`)).body, (await who.get('/api/trash')).body, (await who.get(`/api/projects/${t.catchAllId}/export.md`)).text]);
    for (const words of ['Layoff list', 'names here', 'cut team X', 'Trashed secret', 'Already private', CT.id, PT.id]) assert.equal(seen.includes(words), false, words);
  }
  // carol keeps them, private, in the catch-all, and the move says so
  const mine = (await c.get(`/api/tasks/${CT.id}`)).body;
  assert.deepEqual([mine.project_id, mine.private], [t.catchAllId, true]);
  const move = (await c.get(`/api/activity?item_id=${CT.id}`)).body.items[0];
  assert.deepEqual(move.changes.private, { from: false, to: true });
  const already = (await c.get(`/api/activity?item_id=${PT.id}`)).body.items[0];
  assert.deepEqual(Object.keys(already.changes), ['project_id'], 'a task that was already private only moves');
  await t.close();
});

test('one PATCH cannot make an item private for someone else; handing over an already private item still works', async () => {
  const t = await createTestApp();
  const a = t.as('alice'); const b = t.as('bob');
  const P = (await a.post('/api/projects', { name: 'Open' })).body;
  const T = (await a.post('/api/tasks', { title: 'x', project_id: P.id })).body;
  for (const [path, rec] of [[`/api/tasks/${T.id}`, T], [`/api/projects/${P.id}`, P]]) {
    const r = await a.patch(path, { version: rec.version, owner_id: 'bob', owner_name: 'Bob Ortiz', private: true });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error.code, 'invalid_state');
    assert.equal((await b.get(path)).status, 200, 'nothing changed');
  }
  const mineFirst = (await a.patch(`/api/tasks/${T.id}`, { version: T.version, private: true })).body;
  assert.equal((await a.patch(`/api/tasks/${T.id}`, { version: mineFirst.version, owner_id: 'bob', owner_name: 'Bob Ortiz' })).status, 200);
  assert.equal((await b.get(`/api/tasks/${T.id}`)).body.private, true);
  await t.close();
});

test('moving a public task out of a private project reveals its history, as making it public would', async () => {
  const t = await createTestApp();
  const c = t.as('carol');
  const b = t.as('bob');
  const r = (await c.post('/api/projects', { name: 'R', private: true })).body;
  const task = (await c.post('/api/tasks', { title: 'plan', project_id: r.id })).body;
  const v2 = (await c.patch(`/api/tasks/${task.id}`, { version: task.version, title: 'secret plan' })).body;
  assert.equal((await b.get(`/api/activity?item_id=${task.id}`)).body.items.length, 0, 'hidden while in the private project');
  await c.patch(`/api/tasks/${task.id}`, { version: v2.version, project_id: t.catchAllId });
  const seen = (await b.get(`/api/activity?item_id=${task.id}`)).body.items;
  assert.equal(seen.length, 3, 'the move reveals the create, the rename and the move');
  assert.ok(seen.some((e) => e.changes?.title?.to === 'secret plan'), 'old values included: the task page asks before a move like this');
  await t.close();
});
