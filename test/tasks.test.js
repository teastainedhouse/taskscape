import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('create task: defaults to the catch-all project; shape; validation', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/tasks', { title: 'Loose end' });
  assert.equal(r.status, 201);
  assert.equal(r.body.project_id, 'general');
  assert.equal(r.body.project_name, 'General');
  assert.equal(r.body.status, 'To do');
  assert.equal(r.body.owner_id, 'alice');
  assert.equal(r.body.due_date, null);
  assert.equal(r.body.notes, '');
  assert.equal(r.body.version, 1);
  r = await a.post('/api/tasks', {});
  assert.equal(r.body.error.details.fields.title, 'is required');
  r = await a.post('/api/tasks', { title: 'x', due_date: '2026-13-45' });
  assert.equal(r.body.error.details.fields.due_date, 'must be YYYY-MM-DD or null');
  r = await a.post('/api/tasks', { title: 'x', due_date: '2026-02-30' });
  assert.equal(r.status, 400);
  r = await a.post('/api/tasks', { title: 'x', status: 'Planned' }); // a project status, not a task status
  assert.equal(r.status, 400);
  r = await a.post('/api/tasks', { title: 'x', project_id: 'missing' });
  assert.equal(r.status, 404);
  r = await a.post('/api/tasks', { title: 'x', project_id: null });
  assert.equal(r.status, 201);
  assert.equal(r.body.project_id, 'general');
  await t.close();
});

test('create in a trashed project is invalid_state', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  await a.delete(`/api/projects/${p.id}`, { version: 1 });
  const r = await a.post('/api/tasks', { title: 'x', project_id: p.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  await t.close();
});

test('list: project filter, status order, due sorting with nulls last, due windows', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  const mk = (title, extra) => a.post('/api/tasks', { title, project_id: p.id, ...extra }).then((r) => r.body);
  const t1 = await mk('A', { due_date: '2026-11-05', status: 'Done' });
  const t2 = await mk('B', { due_date: null, status: 'Blocked' });
  const t3 = await mk('C', { due_date: '2026-11-01', status: 'Doing' });
  await a.post('/api/tasks', { title: 'Elsewhere' });
  let r = await a.get(`/api/tasks?project=${p.id}&sort=due_date`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t3.id, t1.id, t2.id]);
  r = await a.get(`/api/tasks?project=${p.id}&sort=due_date&dir=desc`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t1.id, t3.id, t2.id]);
  r = await a.get(`/api/tasks?project=${p.id}&sort=status&dir=asc`);
  assert.deepEqual(r.body.items.map((x) => x.status), ['Doing', 'Blocked', 'Done']);
  r = await a.get(`/api/tasks?project=${p.id}&due_before=2026-11-03`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t3.id]);
  r = await a.get(`/api/tasks?project=${p.id}&due_after=2026-11-03`);
  assert.deepEqual(r.body.items.map((x) => x.id), [t1.id]);
  r = await a.get(`/api/tasks?due_before=garbage`);
  assert.equal(r.status, 400);
  r = await a.get(`/api/tasks?project=general`);
  assert.deepEqual(r.body.items.map((x) => x.title), ['Elsewhere']);
  await t.close();
});

test('patch: edit, move between projects, reassign', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p1 = (await a.post('/api/projects', { name: 'P1' })).body;
  const p2 = (await a.post('/api/projects', { name: 'P2' })).body;
  const task = (await a.post('/api/tasks', { title: 'T', project_id: p1.id })).body;
  let r = await a.patch(`/api/tasks/${task.id}`, { version: 1, notes: 'hello', due_date: '2026-12-01' });
  assert.equal(r.body.version, 2);
  assert.equal(r.body.notes, 'hello');
  r = await a.patch(`/api/tasks/${task.id}`, { version: 2, project_id: p2.id });
  assert.equal(r.body.project_id, p2.id);
  assert.equal(r.body.project_name, 'P2');
  r = await a.patch(`/api/tasks/${task.id}`, { version: 3, project_id: 'nope' });
  assert.equal(r.status, 404);
  r = await a.patch(`/api/tasks/${task.id}`, { version: 3, project_id: null });
  assert.equal(r.status, 400);
  r = await t.as('bob').patch(`/api/tasks/${task.id}`, { version: 3, owner_id: 'bob' });
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  const act = (await a.get(`/api/activity?item_id=${task.id}`)).body.items;
  assert.deepEqual(act[0].changes, { owner_id: { from: 'alice', to: 'bob' }, owner_name: { from: 'Alice Lin', to: 'Bob Ortiz' } });
  assert.deepEqual(act[1].changes, { project_id: { from: p1.id, to: p2.id } });
  await t.close();
});

test('priority: from the config list or null; patch; sorts in config order with none last; filters', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  let r = await a.post('/api/tasks', { title: 'No priority', project_id: p.id });
  assert.equal(r.body.priority, null, 'null by default');
  const none = r.body;
  const low = (await a.post('/api/tasks', { title: 'Low one', project_id: p.id, priority: 'Low' })).body;
  const high = (await a.post('/api/tasks', { title: 'High one', project_id: p.id, priority: 'High' })).body;
  const med = (await a.post('/api/tasks', { title: 'Medium one', project_id: p.id, priority: 'Medium' })).body;
  assert.equal(high.priority, 'High');
  r = await a.post('/api/tasks', { title: 'x', priority: 'Urgent!!' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.error.details.fields, { priority: 'must be one of the configured priorities or null' });
  assert.equal(JSON.stringify(r.body).includes('Urgent'), false, 'the value is never echoed');
  r = await a.post('/api/tasks', { title: 'x', priority: 3 });
  assert.equal(r.status, 400);
  // patch, and back to none; the activity entry records the change
  r = await a.patch(`/api/tasks/${none.id}`, { version: none.version, priority: 'Medium' });
  assert.equal(r.body.priority, 'Medium');
  r = await a.patch(`/api/tasks/${none.id}`, { version: r.body.version, priority: null });
  assert.equal(r.body.priority, null);
  const acts = (await a.get(`/api/activity?item_type=task&item_id=${none.id}`)).body.items;
  assert.deepEqual(acts[0].changes, { priority: { from: 'Medium', to: null } });
  assert.deepEqual(acts.at(-1).changes.priority, { to: null }, 'create lists it');
  // sort: config order (High, Medium, Low), none last in both directions
  r = await a.get(`/api/tasks?project=${p.id}&sort=priority`);
  assert.deepEqual(r.body.items.map((x) => x.title), ['High one', 'Medium one', 'Low one', 'No priority']);
  r = await a.get(`/api/tasks?project=${p.id}&sort=priority&dir=desc`);
  assert.deepEqual(r.body.items.map((x) => x.title), ['Low one', 'Medium one', 'High one', 'No priority']);
  // filter: any of; unknown names are ignored like statuses
  r = await a.get(`/api/tasks?project=${p.id}&priority=High,Low&sort=title`);
  assert.deepEqual(r.body.items.map((x) => x.id), [high.id, low.id]);
  r = await a.get(`/api/tasks?project=${p.id}&priority=Nope`);
  assert.equal(r.body.items.length, 4);
  assert.equal(med.priority, 'Medium');
  // the public config carries the list
  assert.deepEqual((await a.get('/api/config')).body.priorities, ['High', 'Medium', 'Low']);
  await t.close();
});

test('priority: a renamed or removed priority still reads, sorts after the configured ones, and the config is checked', async () => {
  const t = await createTestApp({ config: { priorities: ['P1', 'P2'] } });
  const a = t.as('alice');
  const one = (await a.post('/api/tasks', { title: 'one', priority: 'P2' })).body;
  await t.db.query("UPDATE tasks SET priority = 'Old' WHERE id = ?", [one.id]);
  const two = (await a.post('/api/tasks', { title: 'two', priority: 'P1' })).body;
  const three = (await a.post('/api/tasks', { title: 'three', priority: 'P2' })).body;
  const none = (await a.post('/api/tasks', { title: 'none' })).body;
  const ids = [one.id, two.id, three.id, none.id];
  let r = await a.get('/api/tasks?sort=priority');
  assert.deepEqual(r.body.items.filter((x) => ids.includes(x.id)).map((x) => x.priority), ['P1', 'P2', 'Old', null]);
  r = await a.get('/api/tasks?sort=priority&dir=desc');
  assert.deepEqual(r.body.items.filter((x) => ids.includes(x.id)).map((x) => x.priority), ['P2', 'P1', 'Old', null], 'an unconfigured name never jumps ahead');
  await t.close();
  const { prepareConfig } = await import('../api/lib/config.js');
  const base = JSON.parse((await import('node:fs')).readFileSync(new URL('../taskscape.config.json', import.meta.url), 'utf8'));
  assert.throws(() => prepareConfig({ ...base, priorities: ['A', 'A'] }), /priorities has duplicates/);
  assert.throws(() => prepareConfig({ ...base, priorities: [''] }), /priorities must be/);
  assert.throws(() => prepareConfig({ ...base, priorities: ['Low, later'] }), /priorities must be/, 'a list filter splits on commas');
  assert.throws(() => prepareConfig({ ...base, priorities: [' High'] }), /priorities must be/);
  assert.throws(() => prepareConfig({ ...base, statuses: { ...base.statuses, task: ['To do', 'Done, really'] } }), /statuses.task must be names/);
  assert.deepEqual(prepareConfig({ ...base, priorities: undefined }).priorities, ['High', 'Medium', 'Low']);
  assert.deepEqual(prepareConfig({ ...base, priorities: [] }).priorities, [], 'an empty list turns priorities off');
  const off = await createTestApp({ config: { priorities: [] } });
  await off.as('alice').post('/api/tasks', { title: 'x' });
  const sorted = await off.as('alice').get('/api/tasks?sort=priority&dir=desc');
  assert.equal(sorted.status, 200, 'sorting by priority with none configured is not an error');
  assert.equal((await off.as('alice').post('/api/tasks', { title: 'y', priority: 'High' })).status, 400);
  await off.close();
});

test('a tag filter names at most 50 tags (400, field only)', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const many = Array.from({ length: 51 }, (_, i) => `t${i}`).join(',');
  let r = await a.get(`/api/tasks?tag=${many}`);
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.error.details.fields), ['tag']);
  r = await a.get(`/api/projects?tag=${many}`);
  assert.equal(r.status, 400);
  assert.equal((await a.get(`/api/tasks?tag=${Array.from({ length: 50 }, (_, i) => `t${i}`).join(',')}`)).status, 200);
  await t.close();
});
