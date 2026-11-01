// comments.test.js — guestbook comments: create, validation, author-only
// trash and restore with compare-and-set, activity, and privacy through the
// parent (activity, search, export, byte-identical 404s).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, NOT_FOUND_BODY, tickingClock } from './helpers.js';
import { MAX_PER_GUESTBOOK } from '../api/lib/repo/comments.js';
import * as tokens from '../api/lib/repo/tokens.js';

async function setup(opts = {}) {
  const t = await createTestApp({ now: tickingClock(), ...opts });
  const a = t.as('alice'); const b = t.as('bob'); const c = t.as('carol');
  const P = (await a.post('/api/projects', { name: 'Open house' })).body;
  const T = (await a.post('/api/tasks', { title: 'Paint the fence', project_id: P.id })).body;
  return { t, a, b, c, P, T };
}

test('sign a guestbook: 201 with the documented shape, trimmed, oldest first', async () => {
  const { t, a, b, P, T } = await setup();
  const r = await b.post(`/api/projects/${P.id}/comments`, { body: '  Nice page!\nLove the GIFs.  ' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(),
    ['author_id', 'author_name', 'body', 'created_at', 'deleted_at', 'id', 'item_id', 'item_type', 'updated_at', 'version']);
  assert.equal(r.body.body, 'Nice page!\nLove the GIFs.');
  assert.equal(r.body.author_id, 'bob');
  assert.equal(r.body.author_name, 'Bob Ortiz');
  assert.equal(r.body.item_type, 'project');
  assert.equal(r.body.version, 1);
  assert.equal(r.body.deleted_at, null);
  await a.post(`/api/projects/${P.id}/comments`, { body: 'Thanks!' });
  await b.post(`/api/tasks/${T.id}/comments`, { body: 'Which colour?' });
  const list = (await a.get(`/api/projects/${P.id}/comments`)).body.items;
  assert.deepEqual(list.map((x) => x.body), ['Nice page!\nLove the GIFs.', 'Thanks!']);
  assert.deepEqual((await a.get(`/api/tasks/${T.id}/comments`)).body.items.map((x) => [x.item_type, x.body]), [['task', 'Which colour?']]);
  // signing the guestbook is not an edit of the parent
  assert.equal((await a.get(`/api/projects/${P.id}`)).body.version, P.version);
  await t.close();
});

test('validation names the field only; read-only accounts cannot sign; trashed parents are closed', async () => {
  const { t, a, b, P, T } = await setup({
    config: {
      permissions: { edit: 'group', groups: ['editors'] },
      auth: { dev: { users: [
        { id: 'alice', name: 'Alice Lin', groups: ['editors'] },
        { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] },
        { id: 'carol', name: 'Carol Nkemelu', groups: ['editors'] },
        { id: 'zed', name: 'Zed', groups: ['viewers'] },
      ] } },
    },
  });
  for (const bad of [{}, { body: '' }, { body: '   ' }, { body: 42 }, { body: 'x'.repeat(2001) }]) {
    const r = await b.post(`/api/tasks/${T.id}/comments`, bad);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.error.details, { fields: { body: 'must be 1 to 2000 characters' } });
  }
  assert.equal((await b.post(`/api/tasks/${T.id}/comments`, { body: 'é'.repeat(2000) })).status, 201, '2000 characters, not bytes');
  const zed = await t.as('zed').post(`/api/tasks/${T.id}/comments`, { body: 'hi' });
  assert.equal(zed.status, 403);
  assert.equal((await t.as('zed').get(`/api/tasks/${T.id}/comments`)).status, 200, 'but they can read it');
  const task = (await a.get(`/api/tasks/${T.id}`)).body;
  await a.delete(`/api/tasks/${T.id}`, { version: task.version });
  const closed = await b.post(`/api/tasks/${T.id}/comments`, { body: 'too late' });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.error.code, 'invalid_state');
  const project = (await a.get(`/api/projects/${P.id}`)).body;
  await a.delete(`/api/projects/${P.id}`, { version: project.version });
  assert.equal((await b.post(`/api/projects/${P.id}/comments`, { body: 'gone' })).body.error.code, 'invalid_state');
  await t.close();
});

test('only the author trashes and restores, each a compare-and-set; a trashed comment shows only to its author', async () => {
  const { t, a, b, P } = await setup();
  const C = (await b.post(`/api/projects/${P.id}/comments`, { body: 'oops' })).body;
  // not the author: 403, whoever owns the parent
  const forbidden = await a.delete(`/api/comments/${C.id}`, { version: 1 });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.message.includes('oops'), false);
  // stale version: 409 with the current record
  const trashed = await b.delete(`/api/comments/${C.id}`, { version: 1 });
  assert.equal(trashed.status, 200);
  assert.equal(trashed.body.version, 2);
  assert.ok(trashed.body.deleted_at);
  const again = await b.delete(`/api/comments/${C.id}`, { version: 2 });
  assert.equal(again.body.error.code, 'invalid_state');
  const stale = await b.post(`/api/comments/${C.id}/restore`, { version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.version, 2);
  // the author still sees it (to restore it); nobody else does, and to them it does not exist
  assert.deepEqual((await b.get(`/api/projects/${P.id}/comments`)).body.items.map((x) => x.id), [C.id]);
  assert.deepEqual((await a.get(`/api/projects/${P.id}/comments`)).body.items, []);
  const hidden = await a.post(`/api/comments/${C.id}/restore`, { version: 2 });
  const missing = await a.post('/api/comments/no-such-id/restore', { version: 2 });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.text, missing.text);
  const back = await b.post(`/api/comments/${C.id}/restore`, { version: 2 });
  assert.equal(back.status, 200);
  assert.equal(back.body.deleted_at, null);
  assert.equal(back.body.version, 3);
  // there is no edit and no hard delete
  assert.equal((await b.patch(`/api/comments/${C.id}`, { version: 3, body: 'edited' })).status, 405);
  await t.close();
});

test('two authors racing the same version: one wins, the other gets 409', async () => {
  const { t, b, P } = await setup();
  const C = (await b.post(`/api/projects/${P.id}/comments`, { body: 'twice' })).body;
  const [r1, r2] = await Promise.all([
    b.delete(`/api/comments/${C.id}`, { version: 1 }),
    b.delete(`/api/comments/${C.id}`, { version: 1 }),
  ]);
  // the loser either fails the version check (409) or, serialised behind the winner, finds it already trashed (400)
  const statuses = [r1.status, r2.status].sort();
  assert.ok(statuses[0] === 200 && [400, 409].includes(statuses[1]), String(statuses));
  const current = (await b.get(`/api/projects/${P.id}/comments`)).body.items[0];
  assert.equal(current.version, 2, 'exactly one trash happened');
  assert.equal((await b.get('/api/activity?item_type=comment')).body.items.filter((e) => e.action === 'trash').length, 1);
  await t.close();
});

test('activity: entries name the parent, never the text; For you and the project filter include them', async () => {
  const { t, a, b, P, T } = await setup();
  const C = (await b.post(`/api/tasks/${T.id}/comments`, { body: 'a secret thought' })).body;
  await b.delete(`/api/comments/${C.id}`, { version: 1 });
  const entries = (await a.get('/api/activity?item_type=comment')).body.items;
  assert.deepEqual(entries.map((e) => [e.action, e.actor_id, e.item_title, e.project_id]), [
    ['trash', 'bob', 'Paint the fence', P.id],
    ['create', 'bob', 'Paint the fence', P.id],
  ]);
  for (const e of entries) assert.deepEqual(e.changes, { on: { type: 'task', id: T.id } });
  assert.equal(JSON.stringify(entries).includes('secret thought'), false);
  const forMe = (await a.get('/api/activity?for=me&item_type=comment')).body.items;
  assert.equal(forMe.length, 2, 'comments on my task are for me');
  assert.equal((await b.get('/api/activity?for=me&item_type=comment')).body.items.length, 0, 'my own comments are not');
  assert.equal((await a.get(`/api/activity?project=${P.id}&item_type=comment`)).body.items.length, 2);
  assert.equal((await a.get('/api/activity?item_type=sticker')).status, 400);
  await t.close();
});

test('privacy: comments follow their parent through every door', async () => {
  const { t, a, b, c, P } = await setup();
  // a private task of alice's in a public project, and carol's private project
  const PT = (await a.post('/api/tasks', { title: 'Private chore', project_id: P.id, private: true })).body;
  const S = (await c.post('/api/projects', { name: 'Reorg', private: true })).body;
  await a.post(`/api/tasks/${PT.id}/comments`, { body: 'note to self: hidden words' });
  await c.post(`/api/projects/${S.id}/comments`, { body: 'confidential guestbook' });
  const missingGet = await b.get('/api/tasks/no-such-id/comments');
  const missingPost = await b.post('/api/projects/no-such-id/comments', { body: 'hi' });
  for (const [path, missing] of [[`/api/tasks/${PT.id}/comments`, missingGet], [`/api/projects/${S.id}/comments`, missingGet]]) {
    const r = await b.get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.text, missing.text, path);
    assert.deepEqual(r.body, NOT_FOUND_BODY);
  }
  for (const path of [`/api/tasks/${PT.id}/comments`, `/api/projects/${S.id}/comments`]) {
    const r = await b.post(path, { body: 'hi' });
    assert.equal(r.status, 404, path);
    assert.equal(r.text, missingPost.text, path);
  }
  // activity: nothing about comments on items bob cannot see
  const feed = JSON.stringify((await b.get('/api/activity')).body);
  for (const id of [PT.id, S.id]) assert.equal(feed.includes(id), false);
  assert.equal((await b.get('/api/activity?item_type=comment')).body.items.length, 0);
  assert.equal((await b.get(`/api/activity?project=${S.id}`)).body.items.length, 0);
  // search does not look in comments at all
  for (const q of ['hidden words', 'confidential']) assert.deepEqual((await b.get(`/api/search?q=${encodeURIComponent(q)}`)).body, { projects: [], tasks: [] });
  // export: bob's copy of the public project carries public comments, nothing from the private task, and no trashed comments
  await b.post(`/api/projects/${P.id}/comments`, { body: 'Signed by Bob' });
  const gone = (await b.post(`/api/projects/${P.id}/comments`, { body: 'Regretted words' })).body;
  await b.delete(`/api/comments/${gone.id}`, { version: 1 });
  const md = (await b.get(`/api/projects/${P.id}/export.md`)).text;
  assert.match(md, /## Guestbook\n\n\*\*Bob Ortiz\*\*, \d{4}-\d{2}-\d{2}:\n\n> Signed by Bob\n/);
  for (const words of ['hidden words', 'Private chore', 'Regretted words']) assert.equal(md.includes(words), false, words);
  assert.match((await a.get(`/api/projects/${P.id}/export.md`)).text, /### Private chore\n\nGuestbook:\n\n\*\*Alice Lin\*\*.*\n\n> note to self: hidden words/);
  // a project that goes private takes its guestbook with it, even from the comments' authors
  const p = (await a.get(`/api/projects/${P.id}`)).body;
  await a.patch(`/api/projects/${P.id}`, { version: p.version, private: true });
  assert.equal((await b.get(`/api/projects/${P.id}/comments`)).status, 404);
  assert.equal((await b.get('/api/activity?item_type=comment')).body.items.length, 0);
  await t.close();
});

test('a comment body cannot start a heading, define a link, or break out of its quote in the export', async () => {
  const { t, a, b, P } = await setup();
  await b.post(`/api/projects/${P.id}/comments`, { body: 'line one\n# Not a heading\n\n---' });
  // a bare \r is a line break to CommonMark; the API stores \n instead
  const cr = await b.post(`/api/projects/${P.id}/comments`, { body: 'hello\r# Injected\r\n[docs]: https://example.invalid/x\r> [y]: https://example.invalid/y' });
  assert.equal(cr.body.body, 'hello\n# Injected\n[docs]: https://example.invalid/x\n> [y]: https://example.invalid/y');
  const md = (await a.get(`/api/projects/${P.id}/export.md`)).text;
  assert.match(md, /> line one\n> # Not a heading\n>\n> ---\n/);
  assert.match(md, /> hello\n> # Injected\n> \\\[docs\]: https:\/\/example\.invalid\/x\n> > \\\[y\]: /);
  assert.equal(md.includes('\r'), false);
  assert.equal(/^#+ (Not a heading|Injected)/m.test(md), false);
  await t.close();
});

test('closed guestbooks name what is in the trash', async () => {
  const { t, a, b, P, T } = await setup();
  const C = (await b.post(`/api/tasks/${T.id}/comments`, { body: 'hi' })).body;
  const gone = (await b.delete(`/api/comments/${C.id}`, { version: 1 })).body;
  const p = (await a.get(`/api/projects/${P.id}`)).body;
  await a.delete(`/api/projects/${P.id}`, { version: p.version });
  // the task itself is live; its project is what is in the trash
  assert.equal((await b.post(`/api/comments/${C.id}/restore`, { version: gone.version })).body.error.message, 'Restore the project first.');
  assert.equal((await b.post(`/api/tasks/${T.id}/comments`, { body: 'hi' })).body.error.message, 'This project is in the trash.');
  await t.close();
});

test('privacy: hidden comments are the generic 404 for trash, restore, and stale versions; handing over a private item hands over its guestbook', async () => {
  const { t, a, b, c, P } = await setup();
  const missing = await b.delete('/api/comments/no-such-id', { version: 1 });
  // someone else's trashed comment: DELETE and restore both look missing
  const C = (await a.post(`/api/projects/${P.id}/comments`, { body: 'mine' })).body;
  await a.delete(`/api/comments/${C.id}`, { version: 1 });
  assert.equal((await b.delete(`/api/comments/${C.id}`, { version: 2 })).text, missing.text);
  // a comment whose parent went private, with a stale version: 404, never 409
  const S = (await c.post('/api/projects', { name: 'Soon private' })).body;
  const D = (await b.post(`/api/projects/${S.id}/comments`, { body: 'hello' })).body;
  await c.patch(`/api/projects/${S.id}`, { version: S.version, private: true });
  for (const r of [await b.delete(`/api/comments/${D.id}`, { version: 99 }), await b.post(`/api/comments/${D.id}/restore`, { version: 99 })]) {
    assert.equal(r.status, 404);
    assert.equal(r.text, missing.text);
  }
  // alice's note on her private task goes with the task to bob
  const PT = (await a.post('/api/tasks', { title: 'Mine', project_id: P.id, private: true })).body;
  await a.post(`/api/tasks/${PT.id}/comments`, { body: 'note to self' });
  const handed = await a.patch(`/api/tasks/${PT.id}`, { version: PT.version, owner_id: 'bob', owner_name: 'Bob Ortiz' });
  assert.equal(handed.status, 200);
  assert.deepEqual((await b.get(`/api/tasks/${PT.id}/comments`)).body.items.map((x) => x.body), ['note to self']);
  assert.equal((await a.get(`/api/tasks/${PT.id}/comments`)).status, 404);
  await t.close();
});

test('a guestbook holds at most MAX_PER_GUESTBOOK live comments; restore counts too', async () => {
  const { t, b, P } = await setup();
  const C = (await b.post(`/api/projects/${P.id}/comments`, { body: 'keep me' })).body;
  await b.delete(`/api/comments/${C.id}`, { version: 1 });
  for (let i = 1; i < MAX_PER_GUESTBOOK; i++) {
    await t.db.query(`INSERT INTO comments (id, item_type, item_id, author_id, author_name, body, version, created_at, updated_at)
      VALUES (?, 'project', ?, 'bob', 'Bob Ortiz', 'x', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`, [`filler-${i}`, P.id]);
  }
  assert.equal((await b.post(`/api/projects/${P.id}/comments`, { body: 'last one' })).status, 201);
  const full = await b.post(`/api/projects/${P.id}/comments`, { body: 'one too many' });
  assert.equal(full.status, 400);
  assert.equal(full.body.error.message, 'This guestbook is full.');
  assert.equal((await b.post(`/api/comments/${C.id}/restore`, { version: 2 })).body.error.message, 'This guestbook is full.');
  await t.close();
});

test('an author without edit rights can still trash their comment, but not restore it', async () => {
  const { t, b, P } = await setup({ config: { permissions: { edit: 'group', groups: ['editors'] }, auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] },
    { id: 'carol', name: 'Carol Nkemelu', groups: ['editors'] }] } } } });
  const C = (await b.post(`/api/projects/${P.id}/comments`, { body: 'mine' })).body;
  // a token issued after bob left the editors group carries no edit rights
  const readOnly = t.tokenAs((await tokens.issue(t.db, { id: 'bob', name: 'Bob Ortiz', groups: [] }, 'ro', '2026-11-01T09:00:00.000Z')).plaintext);
  assert.equal((await readOnly.post(`/api/projects/${P.id}/comments`, { body: 'new' })).status, 403);
  const gone = await readOnly.delete(`/api/comments/${C.id}`, { version: 1 });
  assert.equal(gone.status, 200);
  assert.equal((await readOnly.post(`/api/comments/${C.id}/restore`, { version: 2 })).status, 403);
  await t.close();
});
