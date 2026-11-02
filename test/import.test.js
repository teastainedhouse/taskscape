// import.test.js — POST /api/projects/import: the export round-trips, the dry
// run writes nothing, comments are skipped and said so, owners map only on an
// exact unique name, statuses are checked with field and line, the whole
// thing is one transaction, and the body rules (text/markdown, size, cross-site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, tickingClock } from './helpers.js';

const MD = { 'content-type': 'text/markdown; charset=utf-8' };

/** The lines of an export that are not ids or timestamps. @param {string} md */
const stable = (md) => md.split('\n').filter((l) => !/^\| (Hits|Created|Updated) \|/.test(l) && !/^Exported from /.test(l)).join('\n');

/** Seed a project with tasks, tags, notes and comments as alice, with bob and carol owning some tasks. */
async function seeded(t) {
  const a = t.as('alice');
  const web = (await a.post('/api/tags', { name: 'web' })).body;
  const p = (await a.post('/api/projects', { name: 'Site | refresh', description: 'Line one\n\n  indented two', status: 'Active', tag_ids: [web.id] })).body;
  const t1 = (await a.post('/api/tasks', { project_id: p.id, title: 'Fix | GIFs', priority: 'Medium', due_date: '2026-11-05', notes: 'Notes **bold**\n\nsecond paragraph', tag_ids: [web.id] })).body;
  // distinct due dates: the export orders by due date, and undated tasks would tie
  await a.post('/api/tasks', { project_id: p.id, title: 'Bob does this', owner_id: 'bob', status: 'Doing', recurrence: 'weekly', due_date: '2026-11-06' });
  await a.post('/api/tasks', { project_id: p.id, title: 'Carol does that', owner_id: 'carol', status: 'Done', due_date: '2026-11-07' });
  let v = t1.version;
  v = (await a.post(`/api/tasks/${t1.id}/links`, { version: v, url: 'https://example.test/spec?a=1&b=2#top', label: 'Spec [v2] \\ (draft) *x* <b>' })).body.version;
  v = (await a.post(`/api/tasks/${t1.id}/links`, { version: v, url: 'https://example.test/plain' })).body.version;
  v = (await a.post(`/api/tasks/${t1.id}/checklist`, { version: v, text: 'Find the [old] GIF *now*' })).body.version;
  const item = (await a.post(`/api/tasks/${t1.id}/checklist`, { version: v, text: '- [x] looks done but is text' })).body;
  await a.patch(`/api/tasks/${t1.id}/checklist/${item.checklist[0].id}`, { version: item.version, done: true });
  await a.post(`/api/projects/${p.id}/comments`, { body: 'Project comment' });
  await t.as('bob').post(`/api/tasks/${t1.id}/comments`, { body: 'Task comment' });
  return { a, p };
}

test('round trip: export, import, export again; same text apart from ids, dates and comments', async () => {
  const t = await createTestApp({ now: tickingClock() });
  const { a, p } = await seeded(t);
  const first = (await a.get(`/api/projects/${p.id}/export.md`)).text;
  const r = await a.post('/api/projects/import', first, MD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.project.name, 'Site | refresh');
  assert.equal(r.body.tasks.length, 3);
  assert.equal(r.body.comments_skipped, 2);
  assert.ok(r.body.notes.some((n) => n.startsWith('2 comments were not imported')));
  assert.notEqual(r.body.project.id, p.id);
  const second = (await a.get(`/api/projects/${r.body.project.id}/export.md`)).text;
  // the original has comments; the copy cannot: compare the first export without its comment blocks
  const withoutComments = (md) => md.replace(/\n(Comments:|## Comments)\n[\s\S]*?(?=\n### |\n---\n|$)/g, '\n').replace(/\n{3,}/g, '\n\n');
  assert.equal(stable(withoutComments(second)), stable(withoutComments(first)));
  // owners mapped by exact unique name, tags by name (the same tag row), notes kept
  const copies = (await a.get(`/api/tasks?project=${r.body.project.id}`)).body.items;
  const byTitle = Object.fromEntries((await a.get(`/api/tasks?project=${r.body.project.id}`)).body.items.map((x) => [x.title, x]));
  assert.equal(byTitle['Bob does this'].owner_id, 'bob');
  assert.equal(byTitle['Carol does that'].owner_id, 'carol');
  assert.equal(byTitle['Fix | GIFs'].notes, 'Notes **bold**\n\nsecond paragraph');
  assert.equal(byTitle['Fix | GIFs'].tags[0].name, 'web');
  assert.equal(byTitle['Fix | GIFs'].priority, 'Medium');
  assert.deepEqual(byTitle['Fix | GIFs'].links.map((l) => [l.url, l.label, l.position]), [
    ['https://example.test/spec?a=1&b=2#top', 'Spec [v2] \\ (draft) *x* <b>', 0], ['https://example.test/plain', null, 1]]);
  assert.deepEqual(byTitle['Fix | GIFs'].checklist.map((c) => [c.text, c.done]), [['Find the [old] GIF *now*', true], ['- [x] looks done but is text', false]]);
  assert.ok(first.includes('Checklist:\n\n- [x] Find the \\[old\\] GIF \\*now\\*\n- [ ] - \\[x\\] looks done but is text\n'), first);
  assert.ok(first.includes('Links:\n\n- [Spec \\[v2\\] \\\\ \\(draft\\) \\*x\\* \\<b\\>](<https://example.test/spec?a=1&b=2#top>)\n- <https://example.test/plain>\n'), first);
  assert.equal(byTitle['Bob does this'].priority, null);
  assert.equal(byTitle['Bob does this'].recurrence, 'weekly');
  assert.equal(byTitle['Bob does this'].recurred_from, null, 'an import starts a new series');
  assert.equal(copies.length, 3);
  assert.equal((await a.get('/api/tags')).body.items.length, 1, 'no second "web" tag');
  // one activity entry per created item, by the importer
  const acts = (await a.get(`/api/activity?project=${r.body.project.id}`)).body.items;
  assert.deepEqual(acts.map((x) => x.action), ['create', 'create', 'create', 'create']);
  assert.ok(acts.every((x) => x.actor_id === 'alice'));
  await t.close();
});

test('dry run answers with the plan and writes nothing', async () => {
  const t = await createTestApp();
  const { a, p } = await seeded(t);
  const md = (await a.get(`/api/projects/${p.id}/export.md`)).text;
  const before = (await a.get('/api/projects')).body.items.length;
  const r = await a.post('/api/projects/import?dry_run=true', md, MD);
  assert.equal(r.status, 200);
  assert.equal(r.body.dry_run, true);
  assert.equal(r.body.project.name, 'Site | refresh');
  assert.equal(r.body.project.id, undefined, 'nothing has an id yet');
  assert.deepEqual(r.body.tasks.map((x) => [x.title, x.owner_id, x.line > 1]), [['Fix | GIFs', 'alice', true], ['Bob does this', 'bob', true], ['Carol does that', 'carol', true]]);
  assert.equal(r.body.comments_skipped, 2);
  assert.equal((await a.get('/api/projects')).body.items.length, before);
  assert.equal((await a.get('/api/activity?item_type=project')).body.items.filter((x) => x.item_title === 'Site | refresh').length, 1, 'only the original create');
  assert.equal((await a.post('/api/projects/import?dry_run=maybe', md, MD)).status, 400);
  await t.close();
});

test('owners: an unknown or ambiguous name goes to the importer; private makes everything the importer\'s', async () => {
  const t = await createTestApp({ config: { auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] },
    { id: 'bob2', name: 'Bob Ortiz', groups: ['editors'] }] } } } });
  const a = t.as('alice');
  const md = '# Handover\n\n| Field | Value |\n| --- | --- |\n| Owner | Nobody Known |\n\n## Tasks\n\n| Title | Status | Owner |\n| --- | --- | --- |\n| One | To do | Bob Ortiz |\n| Two | To do | Zed |\n| Three | To do |  |\n';
  const r = await a.post('/api/projects/import', md, MD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.project.owner_id, 'alice');
  assert.deepEqual(r.body.tasks.map((x) => x.owner_id), ['alice', 'alice', 'alice'], 'two Bobs is ambiguous');
  assert.ok(r.body.notes.some((n) => /items named an owner nobody here matches/.test(n)));
  assert.equal(JSON.stringify(r.body.notes).includes('Zed'), false, 'notes never echo names');
  const t2 = await createTestApp();
  const r2 = await t2.as('alice').post('/api/projects/import?private=true', md, MD);
  assert.equal(r2.status, 201);
  assert.equal(r2.body.project.private, true);
  assert.ok(r2.body.tasks.every((x) => x.private && x.owner_id === 'alice'));
  assert.equal((await t2.as('bob').get(`/api/projects/${r2.body.project.id}`)).status, 404);
  await t.close();
  await t2.close();
});

test('private in the file stays private: nothing an export marked private is published by importing it', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'Secret', private: true })).body;
  await a.post('/api/tasks', { project_id: p.id, title: 'Hidden task', private: true, notes: 'quiet' });
  const md = (await a.get(`/api/projects/${p.id}/export.md`)).text;
  assert.match(md, /\| Private \| yes \|/);
  const plan = (await a.post('/api/projects/import?dry_run=true', md, MD)).body;
  assert.equal(plan.project.private, true);
  assert.deepEqual(plan.tasks.map((x) => x.private), [true]);
  assert.ok(plan.notes.some((n) => /private to you/.test(n)));
  const r = await a.post('/api/projects/import', md, MD);
  assert.equal((await t.as('bob').get(`/api/projects/${r.body.project.id}`)).status, 404);
  // a private task in a public project stays private too, and goes to the importer even if the file names someone else
  const pub = (await a.post('/api/projects', { name: 'Pub' })).body;
  await a.post('/api/tasks', { project_id: pub.id, title: 'Mine only', private: true });
  await a.post('/api/tasks', { project_id: pub.id, title: 'Open', owner_id: 'bob' });
  const md2 = (await a.get(`/api/projects/${pub.id}/export.md`)).text.replace('| Mine only | To do | Alice Lin |', '| Mine only | To do | Bob Ortiz |');
  const r2 = await a.post('/api/projects/import', md2, MD);
  const copies = Object.fromEntries((await a.get(`/api/tasks?project=${r2.body.project.id}`)).body.items.map((x) => [x.title, x]));
  assert.equal(copies['Mine only'].private, true);
  assert.equal(copies['Mine only'].owner_id, 'alice');
  assert.equal(copies.Open.owner_id, 'bob');
  assert.equal(copies.Open.private, false);
  assert.equal((await t.as('bob').get(`/api/tasks?project=${r2.body.project.id}`)).body.items.length, 1);
  // new tag names are announced: they are public even in a private import
  const tagged = '# T\n\n| Field | Value |\n| --- | --- |\n| Tags | brand-new-tag |\n\n## Tasks\n\n_No tasks._\n';
  const plan2 = (await a.post('/api/projects/import?dry_run=true&private=true', tagged, MD)).body;
  assert.ok(plan2.notes.some((n) => /1 tag name is new/.test(n)));
  assert.equal(JSON.stringify(plan2.notes).includes('brand-new-tag'), false);
  // tag names are checked like POST /api/tags
  const longTag = tagged.replace('brand-new-tag', 'x'.repeat(41));
  const bad = await a.post('/api/projects/import', longTag, MD);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.details.fields.tags, /line 5/);
  await t.close();
});

test('validation names the field and the line, never the value; a bad task undoes the whole import', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const before = (await a.get('/api/projects')).body.items.length;
  const bad = '# P\n\n## Tasks\n\n| Title | Status | Due |\n| --- | --- | --- |\n| Fine | To do |  |\n| Broken | Sleeping | 2026-13-45 |\n';
  const r = await a.post('/api/projects/import', bad, MD);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.error.details.fields, { status: 'must be one of the configured task statuses (line 8)', due_date: 'must be YYYY-MM-DD or null (line 8)' });
  assert.equal(JSON.stringify(r.body).includes('Sleeping'), false);
  assert.equal((await a.get('/api/projects')).body.items.length, before, 'nothing created');
  const noHeading = await a.post('/api/projects/import', 'just words\n', MD);
  assert.equal(noHeading.status, 400);
  assert.deepEqual(Object.keys(noHeading.body.error.details.fields), ['name']);
  const badProject = await a.post('/api/projects/import', '# P\n\n| Field | Value |\n| --- | --- |\n| Status | Zzz |\n\n## Tasks\n\n_No tasks._\n', MD);
  assert.equal(badProject.body.error.details.fields.status, 'must be one of the configured project statuses (line 5)');
  await t.close();
});

test('body rules: text/markdown only from a browser, size limit, cross-site, read-only, tokens may import', async () => {
  const t = await createTestApp({ config: { limits: { body_bytes: 2000 }, permissions: { edit: 'group', groups: ['editors'] },
    auth: { dev: { users: [{ id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'ro', name: 'Read Only', groups: [] }] } } } });
  const a = t.as('alice');
  const md = '# Small\n\n## Tasks\n\n_No tasks._\n';
  assert.equal((await a.post('/api/projects/import', md, { 'content-type': 'text/plain' })).status, 415, 'a form could send text/plain');
  assert.equal((await a.post('/api/projects/import', md, { ...MD, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await a.post('/api/projects/import', '# Big\n\n' + 'x'.repeat(3000) + '\n\n## Tasks\n\n_No tasks._\n', MD)).status, 413);
  assert.equal((await t.as('ro').post('/api/projects/import', md, MD)).status, 403);
  const json = await a.post('/api/projects/import', { markdown: md });
  assert.equal(json.status, 415, 'the body is a Markdown file, not JSON');
  const tok = t.tokenAs((await a.post('/api/tokens', { label: 'x' })).body.plaintext);
  assert.equal((await tok.post('/api/projects/import', md, MD)).status, 201);
  assert.equal((await a.post('/api/projects/import', md, MD)).status, 201);
  await t.close();
});

test('limits and hostile files: long lines, too many tasks, too many tags, a second "## Tasks", a non-UTF-8 charset', async () => {
  const t = await createTestApp({ config: { limits: { max_page_size: 5, body_bytes: 400000 } } });
  const a = t.as('alice');
  const head = '# P\n\n## Tasks\n\n| Title | Status | Tags |\n| --- | --- | --- |\n';
  const row = (n, tags = '') => `| T${n} | To do | ${tags} |\n`;
  const field = async (md, query = '') => { const r = await a.post('/api/projects/import' + query, md, MD); return [r.status, r.body.error?.details?.fields]; };
  assert.deepEqual(await field(head + row(1) + '| ' + 'x'.repeat(20001) + ' | To do |  |\n'), [400, { body: 'a line is longer than 20000 characters (line 8)' }]);
  assert.deepEqual(await field(head + [1, 2, 3, 4, 5, 6].map((n) => row(n)).join('')), [400, { tasks: 'at most 5 tasks per import (line 12)' }]);
  assert.deepEqual(await field(head + row(1, Array.from({ length: 21 }, (_, i) => `t${i}`).join(', '))), [400, { tags: 'at most 20 tags on one item (line 7)' }]);
  assert.equal((await field(head + [1, 2, 3].map((n) => row(n, Array.from({ length: 20 }, (_, i) => `n${n}-${i}`).join(', '))).join('')))[1].tags, 'at most 50 new tag names per import');
  assert.deepEqual(await field('# P\n\nIntro\n\n## Tasks\n\n| Title |\n| --- |\n| Injected |\n\n## Tasks\n\n_No tasks._\n'), [400, { description: 'has a line that reads as the "## Tasks" heading; change or indent it (line 11)' }]);
  assert.deepEqual(await field('# P\n\n## Tasks\n\n| Title |\n| --- |\n| A |\n\n### A\n\nnotes with\n## Tasks\ninside\n'), [400, { notes: 'has a line that reads as the "## Tasks" heading; change or indent it (line 12)' }]);
  // Private in any case; anything else is an error naming field and line, never the value
  assert.equal((await a.post('/api/projects/import?dry_run=true', '# P\n\n| Field | Value |\n| --- | --- |\n| Private | YES |\n\n## Tasks\n\n| Title | Private |\n| --- | --- |\n| T | Yes |\n', MD)).body.tasks[0].private, true);
  assert.deepEqual(await field('# P\n\n| Field | Value |\n| --- | --- |\n| Private | maybe |\n\n## Tasks\n\n_No tasks._\n'), [400, { private: 'must be yes or no (line 5)' }]);
  assert.equal((await a.post('/api/projects/import', head + row(1), { 'content-type': 'text/markdown; charset=utf-16' })).status, 415);
  assert.equal((await a.post('/api/projects/import', '\ufeff' + head + row(1), { 'content-type': 'TEXT/MARKDOWN; charset="UTF-8"' })).status, 201, 'a BOM and an upper-case type are fine');
  await t.close();
});

test('notes survive export markers inside them; comma tags regroup; titles with odd whitespace keep their notes', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  await a.post('/api/tags', { name: 'a, b' });
  const p = (await a.post('/api/projects', { name: 'Markers', description: 'Has ### a heading-looking line\nand --- a rule' })).body;
  await a.post('/api/tasks', { project_id: p.id, title: 'First', notes: 'Intro\n### Steps\n1. do it\nComments:\nnot really' });
  await a.post('/api/tasks', { project_id: p.id, title: 'Second   one', notes: 'two' });
  const r = (await a.post('/api/projects/import?dry_run=true', (await a.get(`/api/projects/${p.id}/export.md`)).text, MD)).body;
  assert.equal(r.project.description, 'Has ### a heading-looking line\nand --- a rule');
  assert.deepEqual(Object.fromEntries(r.tasks.map((x) => [x.title, x.notes])), { First: 'Intro\n### Steps\n1. do it\nComments:\nnot really', 'Second   one': 'two' });
  const tagged = (await a.post('/api/projects/import?dry_run=true', '# T\n\n| Field | Value |\n| --- | --- |\n| Tags | a, b, c |\n\n## Tasks\n\n_No tasks._\n', MD)).body;
  assert.deepEqual(tagged.project.tags, ['a, b', 'c'], 'the existing "a, b" tag is kept whole');
  await t.close();
});

test('under the password provider an import never hands an item to a disabled account', async () => {
  const { hashPassword } = await import('../api/lib/auth/passwords.js');
  const users = await import('../api/lib/repo/users.js');
  const sessions = await import('../api/lib/repo/sessions.js');
  const t = await createTestApp({ config: { auth: { provider: 'password' } } });
  const now = '2026-11-02T10:00:00.000Z';
  for (const [id, name] of [['dana', 'Dana Fox'], ['eve', 'Eve Ash']]) await users.create(t.db, { id, name, email: null, groups: [] }, await hashPassword('correct horse battery'), now);
  const cookieFor = async (id) => (await sessions.create(t.db, id, now, 30)).plaintext;
  const dana = t.withHeaders({ cookie: `__Host-taskscape_session=${await cookieFor('dana')}` });
  const eve = t.withHeaders({ cookie: `__Host-taskscape_session=${await cookieFor('eve')}` });
  await eve.post('/api/projects', { name: 'Eve owns this' }); // eve is a visible owner now
  const md = '# H\n\n## Tasks\n\n| Title | Owner |\n| --- | --- |\n| For Eve | Eve Ash |\n';
  assert.deepEqual((await dana.post('/api/projects/import?dry_run=true', md, MD)).body.tasks.map((x) => x.owner_id), ['eve']);
  await users.disable(t.db, 'eve', now);
  const after = (await dana.post('/api/projects/import?dry_run=true', md, MD)).body;
  assert.deepEqual(after.tasks.map((x) => x.owner_id), ['dana'], 'a disabled account cannot be given an item');
  assert.ok(after.notes.some((n) => /nobody here matches/.test(n)));
  await t.close();
});

test('createIn refuses to run outside a transaction', async () => {
  const projects = await import('../api/lib/repo/projects.js');
  const t = await createTestApp();
  await assert.rejects(projects.createIn(t.db, { id: 'alice', name: 'Alice', via: 'ui', auth: 'dev' }, { name: 'X' }, t.config, '2026-11-02T10:00:00.000Z'), /inside db\.transaction/);
  await t.close();
});

test('a tag cell with thousands of commas is refused quickly, not regrouped slowly', async () => {
  const t = await createTestApp();
  const started = Date.now();
  const r = await t.as('alice').post('/api/projects/import?dry_run=true', '# P\n\n| Field | Value |\n| --- | --- |\n| Tags | ' + Array.from({ length: 5000 }, () => 'a').join(',') + ' |\n\n## Tasks\n\n_No tasks._\n', MD);
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.fields.tags, /at most 20 tags/);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  await t.close();
});

test('import: an unknown priority names the field and the line; an empty cell is none', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const md = '# P\n\n## Tasks\n\n| Title | Status | Priority |\n| --- | --- | --- |\n| One | To do | Whenever |\n';
  let r = await a.post('/api/projects/import?dry_run=true', md, MD);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.fields.priority, 'must be one of the configured priorities or null (line 7)');
  r = await a.post('/api/projects/import?dry_run=true', md.replace('Whenever', ''), MD);
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks[0].priority, null);
  r = await a.post('/api/projects/import?dry_run=true', md.replace('Whenever', 'Low'), MD);
  assert.equal(r.body.tasks[0].priority, 'Low');
  await t.close();
});

test('import: links must be http(s), named with their line; a "Links:" line deep in the notes stays notes', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const head = '# P\n\n## Tasks\n\n| Title | Status |\n| --- | --- |\n| One | To do |\n\n### One\n\n';
  let r = await a.post('/api/projects/import?dry_run=true', head + 'Links:\n\n- [x](<javascript:alert(1)>)\n', MD);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.fields.links, 'must be http or https URLs without a user name or password (line 13)');
  assert.equal(JSON.stringify(r.body).includes('alert'), false);
  r = await a.post('/api/projects/import?dry_run=true', head + 'Links:\n\n- <https://example.test/a>\n- [B](<https://example.test/b>)\n\nSome notes.\n\nLinks:\n\n- <https://example.test/not-a-link>\n', MD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tasks[0].links, [{ url: 'https://example.test/a', label: null }, { url: 'https://example.test/b', label: 'B' }]);
  assert.equal(r.body.tasks[0].notes, 'Some notes.\n\nLinks:\n\n- <https://example.test/not-a-link>', 'only the block before the notes is structure');
  await t.close();
});

test('import: notes that start like a Links block stay notes through a round trip; one block only', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const sneaky = 'Links:\n\n- [Click](<https://evil.test/>)\n\nreal notes';
  const t1 = (await a.post('/api/tasks', { project_id: p.id, title: 'No links', notes: sneaky })).body;
  const t2 = (await a.post('/api/tasks', { project_id: p.id, title: 'Has links', notes: sneaky })).body;
  await a.post(`/api/tasks/${t2.id}/links`, { version: t2.version, url: 'https://example.test/real\\path?q=a\\b' });
  const md = (await a.get(`/api/projects/${p.id}/export.md`)).text;
  assert.ok(md.includes('### No links\n\nLinks:\n\n_None._\n\nChecklist:\n\n_None._\n\nLinks:\n\n- [Click]'), 'empty blocks shield the notes');
  assert.ok(md.includes('(<https://example.test/real/path?q=a%5Cb>)') || md.includes('- <https://example.test/real/path?q=a%5Cb>'), 'a backslash is encoded');
  const r = await a.post('/api/projects/import', md, MD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const byTitle = Object.fromEntries(r.body.tasks.map((x) => [x.title, x]));
  assert.equal(byTitle['No links'].notes, sneaky);
  assert.deepEqual(byTitle['No links'].links, []);
  assert.equal(byTitle['Has links'].notes, sneaky);
  assert.deepEqual(byTitle['Has links'].links.map((l) => l.url), ['https://example.test/real/path?q=a%5Cb']);
  // a hand-written second Links block is notes, not more links
  const two = '# Q\n\n## Tasks\n\n| Title |\n| --- |\n| One |\n\n### One\n\nLinks:\n\n- <https://example.test/a>\n\nLinks:\n\n- <https://example.test/b>\n';
  const r2 = await a.post('/api/projects/import?dry_run=true', two, MD);
  assert.deepEqual(r2.body.tasks[0].links.map((l) => l.url), ['https://example.test/a']);
  assert.equal(r2.body.tasks[0].notes, 'Links:\n\n- <https://example.test/b>');
  await t.close();
});

test('import: checklist items must be one line within the limit; a "Checklist:" deeper in the notes stays notes', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const head = '# P\n\n## Tasks\n\n| Title | Status |\n| --- | --- |\n| One | To do |\n\n### One\n\n';
  let r = await a.post('/api/projects/import?dry_run=true', head + 'Checklist:\n\n- [ ] ' + 'x'.repeat(501) + '\n', MD);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.fields.checklist, 'items must be one line of 1 to 500 characters (line 13)');
  r = await a.post('/api/projects/import?dry_run=true', head + 'Links:\n\n- <https://example.test/a>\n\nChecklist:\n\n- [x] Done thing\n- [ ] Open thing\n\nNotes here.\n\nChecklist:\n\n- [ ] not an item\n', MD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tasks[0].checklist, [{ text: 'Done thing', done: true }, { text: 'Open thing', done: false }]);
  assert.equal(r.body.tasks[0].links.length, 1);
  assert.equal(r.body.tasks[0].notes, 'Notes here.\n\nChecklist:\n\n- [ ] not an item');
  await t.close();
});

test('an imported closed task has no closed_at: a file does not say when it was closed', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const P = (await a.post('/api/projects', { name: 'Done things' })).body;
  await a.post('/api/tasks', { project_id: P.id, title: 'Finished', status: 'Done' });
  const md = (await a.get(`/api/projects/${P.id}/export.md`)).text;
  const r = await a.post('/api/projects/import', md, MD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.tasks.map((x) => [x.status, x.closed_at]), [['Done', null]], 'so it never shows as finished this week');
  await t.close();
});

test('a series round-trips as one series: Repeats only on the task still carrying it', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const P = (await a.post('/api/projects', { name: 'Rent' })).body;
  let rent = (await a.post('/api/tasks', { project_id: P.id, title: 'Pay rent', recurrence: 'monthly', due_date: '2027-01-31' })).body;
  for (let i = 0; i < 2; i++) rent = (await a.get(`/api/tasks/${(await a.patch(`/api/tasks/${rent.id}`, { version: rent.version, status: 'Done' })).body.recurred_to}`)).body;
  const md = (await a.get(`/api/projects/${P.id}/export.md`)).text;
  assert.deepEqual(md.split('\n').filter((l) => l.startsWith('| Pay rent')).map((l) => l.split('|')[6].trim()), ['', '', 'monthly']);
  const r = await a.post('/api/projects/import', md, MD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.tasks.map((x) => [x.status, x.due_date, x.recurrence]),
    [['Done', '2027-01-31', null], ['Done', '2027-02-28', null], ['To do', '2027-03-31', 'monthly']]);
  // a closed task reopened and closed again makes no second series
  const done = r.body.tasks[1];
  const reopened = (await a.patch(`/api/tasks/${done.id}`, { version: done.version, status: 'To do' })).body;
  assert.equal((await a.patch(`/api/tasks/${reopened.id}`, { version: reopened.version, status: 'Done' })).body.recurred_to, null);
  await t.close();
});
