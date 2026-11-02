// duplicate.test.js — POST /api/projects/:id/duplicate: a copy through the export and the import, the caller's own;
// what is copied (tasks, tags, links, unticked checklists, priorities, repeats) and what never is (comments, what
// the caller cannot see); the options; validation; one activity entry per record created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

const NOW = '2026-11-02T10:00:00.000Z';

/** Bob's public project with a task of every kind, a comment, and a task alice cannot see. */
async function setup(opts = {}) {
  const t = await createTestApp({ now: () => NOW, ...opts });
  const a = t.as('alice');
  const b = t.as('bob');
  const ops = (await b.post('/api/tags', { name: 'ops' })).body;
  const web = (await b.post('/api/tags', { name: 'web, design' })).body;
  const P = (await b.post('/api/projects', { name: 'Launch', description: 'Plan it.\n\n- with a list\n- and *emphasis*', status: 'Active', tag_ids: [ops.id] })).body;
  let T1 = (await b.post('/api/tasks', { project_id: P.id, title: 'Book the hall', status: 'Doing', priority: 'High', recurrence: 'monthly',
    due_date: '2026-11-10', notes: 'Call first.\n\n## Not a heading of the export', tag_ids: [ops.id, web.id] })).body;
  T1 = (await b.post(`/api/tasks/${T1.id}/links`, { version: T1.version, url: 'https://hall.example.test/booking', label: 'Booking' })).body;
  T1 = (await b.post(`/api/tasks/${T1.id}/checklist`, { version: T1.version, text: 'Ask about chairs' })).body;
  T1 = (await b.post(`/api/tasks/${T1.id}/checklist`, { version: T1.version, text: 'Pay the deposit' })).body;
  T1 = (await b.patch(`/api/tasks/${T1.id}/checklist/${T1.checklist[0].id}`, { version: T1.version, done: true })).body;
  const T2 = (await a.post('/api/tasks', { project_id: P.id, title: 'Alice drafts the invite', status: 'Done', due_date: '2026-10-30' })).body;
  const T3 = (await a.post('/api/tasks', { project_id: P.id, title: 'Alice private note', private: true })).body;
  await b.post('/api/tasks', { project_id: P.id, title: 'Bob private budget', private: true, notes: 'secret' });
  const gone = (await b.post('/api/tasks', { project_id: P.id, title: 'Trashed task' })).body;
  await b.delete(`/api/tasks/${gone.id}`, { version: gone.version });
  await b.post(`/api/projects/${P.id}/comments`, { body: 'A comment that must not travel' });
  await b.post(`/api/tasks/${T1.id}/comments`, { body: 'Another one' });
  return { t, a, b, P, T1, T2, T3, ops, web };
}

const byTitle = (tasks) => Object.fromEntries(tasks.map((x) => [x.title, x]));

test('duplicate: a copy of what the caller sees, theirs, with every task field; never comments or hidden tasks', async () => {
  const { t, a, P, T1, ops, web } = await setup();
  const r = await a.post(`/api/projects/${P.id}/duplicate`, {});
  assert.equal(r.status, 201);
  const { project, tasks, notes } = r.body;
  assert.notEqual(project.id, P.id);
  assert.equal(project.name, 'Launch (copy)');
  assert.equal(project.description, P.description);
  assert.equal(project.status, 'Active', 'statuses kept unless reset');
  assert.equal(project.owner_id, 'alice', 'the copy is the caller\'s, whoever owns the original');
  assert.equal(project.private, false);
  assert.deepEqual(project.tags.map((x) => x.id), [ops.id]);
  assert.deepEqual(tasks.map((x) => x.title).sort(), ['Alice drafts the invite', 'Alice private note', 'Book the hall']);
  const c = byTitle(tasks);
  const hall = c['Book the hall'];
  assert.equal(hall.project_id, project.id);
  assert.equal(hall.owner_id, 'bob', 'tasks keep their owners');
  assert.equal(hall.status, 'Doing');
  assert.equal(hall.priority, 'High');
  assert.equal(hall.recurrence, 'monthly');
  assert.equal(hall.recurred_from, null, 'a copy starts its own series');
  assert.equal(hall.due_date, '2026-11-10');
  assert.equal(hall.notes, T1.notes);
  assert.deepEqual(hall.tags.map((x) => x.id).sort(), [ops.id, web.id].sort(), 'a tag name with a comma survives the round trip');
  assert.deepEqual(hall.links.map((l) => [l.url, l.label]), [['https://hall.example.test/booking', 'Booking']]);
  assert.deepEqual(hall.checklist.map((i) => [i.text, i.done]), [['Ask about chairs', false], ['Pay the deposit', false]], 'checklists unticked');
  assert.equal(c['Alice drafts the invite'].status, 'Done');
  assert.ok(c['Alice drafts the invite'].closed_at, 'a copy made closed is closed now');
  assert.equal(c['Alice private note'].private, true);
  assert.equal(c['Alice private note'].owner_id, 'alice');
  assert.deepEqual(notes, ['1 item is private to you (private in the original, or by the site default).']);
  // nothing alice cannot see, nothing trashed, no comments
  const dump = JSON.stringify(r.body);
  for (const absent of ['Bob private budget', 'secret', 'Trashed task']) assert.equal(dump.includes(absent), false, absent);
  assert.equal((await a.get(`/api/projects/${project.id}/comments`)).body.items.length, 0);
  assert.equal((await a.get(`/api/tasks/${hall.id}/comments`)).body.items.length, 0);
  // the original is untouched
  assert.equal((await a.get(`/api/tasks/${T1.id}`)).body.checklist[0].done, true);
  // one create entry per record, by the caller, project first
  const log = (await a.get(`/api/activity?project=${project.id}`)).body.items;
  assert.deepEqual(log.map((e) => [e.item_type, e.action, e.actor_id]).reverse(),
    [['project', 'create', 'alice'], ['task', 'create', 'alice'], ['task', 'create', 'alice'], ['task', 'create', 'alice']]);
  await t.close();
});

test('duplicate: reset statuses; keep, shift or clear due dates; a name of your own', async () => {
  const { t, a, P } = await setup();
  let r = await a.post(`/api/projects/${P.id}/duplicate`, { name: '  Launch 2027  ', reset_statuses: true, due_dates: 'shift', days: 365 });
  assert.equal(r.status, 201);
  assert.equal(r.body.project.name, 'Launch 2027');
  assert.equal(r.body.project.status, 'Planned');
  let c = byTitle(r.body.tasks);
  assert.deepEqual([c['Book the hall'].status, c['Alice drafts the invite'].status], ['To do', 'To do']);
  assert.equal(c['Alice drafts the invite'].closed_at, null);
  assert.deepEqual([c['Book the hall'].due_date, c['Alice drafts the invite'].due_date, c['Alice private note'].due_date], ['2027-11-10', '2027-10-30', null]);
  r = await a.post(`/api/projects/${P.id}/duplicate`, { due_dates: 'shift', days: -10 });
  c = byTitle(r.body.tasks);
  assert.deepEqual([c['Book the hall'].due_date, c['Alice drafts the invite'].due_date], ['2026-10-31', '2026-10-20'], 'back across a month end');
  r = await a.post(`/api/projects/${P.id}/duplicate`, { due_dates: 'clear' });
  assert.deepEqual(r.body.tasks.map((x) => x.due_date), [null, null, null]);
  // a long name still fits with " (copy)"
  const long = (await a.post('/api/projects', { name: 'x'.repeat(200) })).body;
  r = await a.post(`/api/projects/${long.id}/duplicate`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.project.name, `${'x'.repeat(193)} (copy)`);
  assert.deepEqual(r.body.tasks, []);
  await t.close();
});

test('duplicate: options are checked, naming the field only; nothing is written on a refusal', async () => {
  const { t, a, P } = await setup();
  const before = (await a.get('/api/projects?limit=200')).body.items.length;
  const bad = async (body, fields) => {
    const r = await a.post(`/api/projects/${P.id}/duplicate`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(Object.keys(r.body.error.details.fields).sort(), fields, JSON.stringify(body));
    assert.equal(JSON.stringify(r.body).includes('sneaky'), false, 'never echoes a value or key');
  };
  await bad({ due_dates: 'later' }, ['due_dates']);
  await bad({ due_dates: 'shift' }, ['days']);
  await bad({ due_dates: 'shift', days: 0 }, ['days']);
  await bad({ due_dates: 'shift', days: 3651 }, ['days']);
  await bad({ due_dates: 'shift', days: 1.5 }, ['days']);
  await bad({ days: 3 }, ['days']);
  await bad({ due_dates: 'keep', days: 3 }, ['days']);
  await bad({ reset_statuses: 'yes' }, ['reset_statuses']);
  await bad({ name: '   ' }, ['name']);
  await bad({ name: 'n'.repeat(201) }, ['name']);
  await bad({ sneaky: 1 }, ['body']);
  // a shift past year 9999 is refused before anything is written
  const far = (await a.post('/api/projects', { name: 'Far' })).body;
  await a.post('/api/tasks', { project_id: far.id, title: 'Late', due_date: '9999-12-30' });
  const r = await a.post(`/api/projects/${far.id}/duplicate`, { due_dates: 'shift', days: 5 });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.error.details.fields), ['days']);
  assert.equal((await a.get('/api/projects?limit=200')).body.items.length, before + 1, 'only "Far" itself');
  await t.close();
});

test('duplicate: privacy, the trash, read-only accounts and the size cap', async () => {
  const { t, a, b, P } = await setup({ config: { limits: { max_page_size: 3 }, permissions: { edit: 'group', groups: ['editors'] }, auth: { dev: { users: [
    { id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'bob', name: 'Bob Ortiz', groups: ['editors'] }, { id: 'rita', name: 'Rita Read', groups: [] }] } } } });
  // someone else's private project is the generic 404, the same as a missing id
  const S = (await b.post('/api/projects', { name: 'Secret', private: true })).body;
  const hidden = await a.post(`/api/projects/${S.id}/duplicate`, {});
  const missing = await a.post('/api/projects/00000000-0000-4000-8000-000000000000/duplicate', {});
  assert.equal(hidden.status, 404);
  assert.equal(hidden.text, missing.text);
  // the owner's copy of their private project stays private, with every task theirs
  await b.post('/api/tasks', { project_id: S.id, title: 'In secret' });
  let r = await b.post(`/api/projects/${S.id}/duplicate`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.project.private, true);
  assert.deepEqual(r.body.tasks.map((x) => [x.owner_id, x.private]), [['bob', true]]);
  assert.equal((await a.get(`/api/projects/${r.body.project.id}`)).status, 404);
  // read-only: 403 before anything is read
  assert.equal((await t.as('rita').post(`/api/projects/${P.id}/duplicate`, {})).status, 403);
  // a project in the trash cannot be copied
  const D = (await a.post('/api/projects', { name: 'Binned' })).body;
  await a.delete(`/api/projects/${D.id}`, { version: D.version });
  r = await a.post(`/api/projects/${D.id}/duplicate`, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  // more tasks than one page: refused, never cut short (bob sees three live tasks in Launch, then four)
  await b.post('/api/tasks', { project_id: P.id, title: 'A fourth' });
  r = await b.post(`/api/projects/${P.id}/duplicate`, {});
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.error.details.fields), ['tasks']);
  await t.close();
});

test('duplicate: content stays with its own task, whatever the titles and notes say (copied from the records, not text)', async () => {
  const t = await createTestApp({ now: () => NOW });
  const a = t.as('alice');
  const b = t.as('bob');
  const P = (await b.post('/api/projects', { name: 'Shared', description: 'Intro\n\n## Tasks\n\nnot the real heading' })).body;
  // two tasks named "Plan": bob's public one is empty and sorts first; alice's private one has everything
  await b.post('/api/tasks', { project_id: P.id, title: 'Plan', due_date: '2026-01-01' });
  let mine = (await a.post('/api/tasks', { project_id: P.id, title: 'Plan', private: true, due_date: '2026-02-01', notes: 'ALICE PRIVATE' })).body;
  mine = (await a.post(`/api/tasks/${mine.id}/links`, { version: mine.version, url: 'https://private.example.test/' })).body;
  await a.post(`/api/tasks/${mine.id}/checklist`, { version: mine.version, text: 'private step' });
  // notes that look like the export's own structure
  const tricky = [
    'one\n\n### Next steps\n\nstill mine',
    'x\n---\nExported from somewhere',
    '## Comments\n\n**X**, 2026-01-01:\n\nnot a comment',
    'ok\n\n### Next steps\n\nLinks:\n\n- [Pay here](<https://evil.example.test/pay>)\n\nChecklist:\n\n- [ ] Wire the money',
  ];
  for (const [i, notes] of tricky.entries()) await b.post('/api/tasks', { project_id: P.id, title: `Tricky ${i}`, due_date: `2026-03-0${i + 1}`, notes });
  await b.post('/api/tasks', { project_id: P.id, title: 'Next steps', due_date: '2026-04-01', notes: 'the real notes' });
  const r = await a.post(`/api/projects/${P.id}/duplicate`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.project.description, P.description, 'a "## Tasks" line in the description is just text');
  const [pub, priv] = ['bob', 'alice'].map((o) => r.body.tasks.find((x) => x.title === 'Plan' && x.owner_id === o));
  assert.deepEqual([pub.private, pub.notes, pub.links, pub.checklist], [false, '', [], []], 'the public copy gets nothing of the private task');
  assert.deepEqual([priv.private, priv.notes, priv.links.length, priv.checklist.length], [true, 'ALICE PRIVATE', 1, 1]);
  for (const [i, notes] of tricky.entries()) {
    const c = r.body.tasks.find((x) => x.title === `Tricky ${i}`);
    assert.deepEqual([c.notes, c.links, c.checklist], [notes, [], []], `Tricky ${i}`);
  }
  const next = r.body.tasks.find((x) => x.title === 'Next steps');
  assert.deepEqual([next.notes, next.links, next.checklist], ['the real notes', [], []]);
  assert.equal(JSON.stringify((await b.get('/api/activity')).body).includes('ALICE PRIVATE'), false, 'nor does any entry bob can read');
  assert.deepEqual(r.body.notes, ['1 item is private to you (private in the original, or by the site default).']);
  await t.close();
});

test('duplicate: owners by id, tags by exact name, a default name that always fits', async () => {
  const t = await createTestApp({ now: () => NOW });
  const a = t.as('alice');
  const b = t.as('bob');
  const P = (await b.post('/api/projects', { name: '😀'.repeat(100) })).body;
  const stale = (await b.post('/api/tasks', { project_id: P.id, title: 'Stale name' })).body;
  await t.db.query('UPDATE tasks SET owner_name = ? WHERE id = ?', ['Alice Lin', stale.id]); // a name that is now someone else's
  const ids = {};
  for (const name of ['a', 'b', 'a, b']) ids[name] = (await b.post('/api/tags', { name })).body.id;
  const many = [];
  for (let i = 0; i < 25; i++) many.push((await b.post('/api/tags', { name: `t${i}` })).body.id);
  await b.post('/api/tasks', { project_id: P.id, title: 'Two tags', tag_ids: [ids.a, ids.b] });
  await b.post('/api/tasks', { project_id: P.id, title: 'Many tags', tag_ids: many });
  const r = await a.post(`/api/projects/${P.id}/duplicate`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.project.name.length <= 200);
  assert.ok(r.body.project.name.endsWith('😀 (copy)'), 'shortened by whole characters');
  const c = byTitle(r.body.tasks);
  assert.equal(c['Stale name'].owner_id, 'bob', 'by id, not the stored name');
  assert.deepEqual(c['Two tags'].tags.map((x) => x.name).sort(), ['a', 'b'], 'not regrouped into "a, b"');
  assert.equal(c['Many tags'].tags.length, 25, 'the import\'s per-item cap is for files');
  assert.deepEqual(r.body.notes, []);
  await t.close();
});

test('duplicate: the size budget, the cap counts only what the caller sees, the privacy default, a token needs its session', async () => {
  const t = await createTestApp({ now: () => NOW, config: { limits: { max_page_size: 2, body_bytes: 1000 }, privacy: { default_private: true } } });
  const a = t.as('alice');
  const b = t.as('bob');
  const P = (await b.post('/api/projects', { name: 'Shared', private: false })).body;
  await b.post('/api/tasks', { project_id: P.id, title: 'Bob public', private: false });
  await a.post('/api/tasks', { project_id: P.id, title: 'Alice public', private: false });
  await b.post('/api/tasks', { project_id: P.id, title: 'Bob hidden', private: true });
  assert.equal((await b.post(`/api/projects/${P.id}/duplicate`, {})).status, 400, 'bob sees three');
  let r = await a.post(`/api/projects/${P.id}/duplicate`, {});
  assert.equal(r.status, 201, 'alice sees two');
  assert.equal(r.body.project.private, true, 'the privacy default applies, as for an import');
  assert.deepEqual(r.body.tasks.map((x) => [x.owner_id, x.private]), [['alice', true], ['alice', true]]);
  assert.equal((await b.get(`/api/activity?project=${r.body.project.id}`)).body.items.length, 0, 'a private copy\'s history is hidden');
  // more text than four bodies
  const Q = (await a.post('/api/projects', { name: 'Wordy', private: false })).body;
  // (each request stays under the body limit, so the notes grow outside the API, as many small edits would)
  const long = (await a.post('/api/tasks', { project_id: Q.id, title: 'Long' })).body;
  await t.db.query('UPDATE tasks SET notes = ? WHERE id = ?', ['x'.repeat(4001), long.id]);
  r = await a.post(`/api/projects/${Q.id}/duplicate`, {});
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.error.details.fields), ['tasks']);
  // through a token: the session header rule, like every write
  const plain = (await a.post('/api/tokens', { label: 'mcp' })).body.plaintext;
  const R = (await a.post('/api/projects', { name: 'Small', private: false })).body;
  assert.equal((await t.tokenAs(plain, null).post(`/api/projects/${R.id}/duplicate`, {})).status, 400, 'no session header');
  assert.equal((await t.tokenAs(plain, 'session-1').post(`/api/projects/${R.id}/duplicate`, {})).status, 201);
  await t.close();
});

test('duplicate: General, a disabled owner under password, and text the caller cannot see', async () => {
  const t = await createTestApp({ now: () => NOW, config: { limits: { body_bytes: 1000 } } });
  const a = t.as('alice');
  const b = t.as('bob');
  // General belongs to no one; its copy is the caller's, and bob's private task there stays out
  await a.post('/api/tasks', { title: 'Alice in General', private: true });
  await b.post('/api/tasks', { title: 'Bob public in General' });
  const hidden = (await b.post('/api/tasks', { title: 'Bob private in General', private: true })).body;
  // hidden text does not count against the caller's budget
  await t.db.query('UPDATE tasks SET notes = ? WHERE id = ?', ['x'.repeat(10_000), hidden.id]);
  let r = await a.post(`/api/projects/${t.catchAllId}/duplicate`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.project.owner_id, 'alice');
  assert.deepEqual(r.body.tasks.map((x) => [x.title, x.owner_id, x.private]).sort(),
    [['Alice in General', 'alice', true], ['Bob public in General', 'bob', false]]);
  assert.equal((await b.post(`/api/projects/${t.catchAllId}/duplicate`, {})).status, 400, 'bob sees his own long notes');
  await t.close();

  // under password, a task whose owner is disabled goes to the caller, with a note
  const p = await createTestApp({ now: () => NOW, config: { auth: { provider: 'password' } } });
  const users = await import('../api/lib/repo/users.js');
  const tasks = await import('../api/lib/repo/tasks.js');
  for (const [id, name] of [['dana', 'Dana Fox'], ['eve', 'Eve Ng']]) await users.create(p.db, { id, name, email: null, groups: [] }, 'x', NOW);
  const dana = { id: 'dana', name: 'Dana Fox', groups: [], via: 'ui', auth: 'password' };
  const eve = { id: 'eve', name: 'Eve Ng', groups: [], via: 'ui', auth: 'password' };
  await tasks.create(p.db, eve, { title: 'Eve\'s task' }, p.config, NOW);
  await users.disable(p.db, 'eve', NOW);
  const { planDuplicate, runImport } = await import('../api/lib/import.js');
  const plan = await planDuplicate(p.db, dana, p.catchAllId, { reset_statuses: false, due_dates: 'keep', days: 0 }, p.config);
  const made = await runImport(p.db, dana, plan, p.config, NOW);
  assert.deepEqual(made.tasks.map((x) => x.owner_id), ['dana']);
  assert.deepEqual(plan.notes, ['1 task belongs to someone who can no longer be given one; its copy goes to you.']);
  await p.close();
});

test('duplicate: leftover statuses and priorities, one series per series, and when a closed task was closed', async () => {
  let n = 0;
  const t = await createTestApp({ now: () => new Date(Date.parse(NOW) + 86_400_000 * n++).toISOString() });
  const a = t.as('alice');
  const P = (await a.post('/api/projects', { name: 'Old ways' })).body;
  const odd = (await a.post('/api/tasks', { project_id: P.id, title: 'Odd' })).body;
  await t.db.query("UPDATE tasks SET status = 'Old', priority = 'Urgent' WHERE id = ?", [odd.id]); // names a config change removed
  // a monthly series closed twice: two closed predecessors and one open newest copy
  let rent = (await a.post('/api/tasks', { project_id: P.id, title: 'Pay rent', recurrence: 'monthly', due_date: '2026-11-01' })).body;
  const closedAt = [];
  for (let i = 0; i < 2; i++) {
    const r = (await a.patch(`/api/tasks/${rent.id}`, { version: rent.version, status: 'Done' })).body;
    closedAt.push(r.closed_at);
    rent = (await a.get(`/api/tasks/${r.recurred_to}`)).body;
  }
  const r = await a.post(`/api/projects/${P.id}/duplicate`, { reset_statuses: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const copy = r.body.tasks.find((x) => x.title === 'Odd');
  assert.deepEqual([copy.status, copy.priority], ['To do', null]);
  assert.ok(r.body.notes.some((x) => /no longer has/.test(x)));
  const rents = r.body.tasks.filter((x) => x.title === 'Pay rent');
  assert.deepEqual(rents.map((x) => x.recurrence).sort(), ['monthly', null, null], 'only the newest keeps repeating');
  assert.deepEqual(rents.filter((x) => x.status === 'Done').map((x) => x.closed_at).sort(), closedAt.sort(), 'closed when the original was');
  // with statuses reset there is still one series, and nothing looks finished
  const reset = (await a.post(`/api/projects/${P.id}/duplicate`, { reset_statuses: true })).body;
  assert.equal(reset.tasks.filter((x) => x.recurrence).length, 1);
  assert.equal(reset.tasks.filter((x) => x.closed_at).length, 0);
  await t.close();
});
