// recurrence.test.js — recurring tasks: the date arithmetic, and the next copy a close creates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { nextDue, addMonths, addDays, isMonthEnd, dateInZone } from '../api/lib/recurrence.js';

test('date arithmetic: month ends, leap years, year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(nextDue('2026-02-28', 'daily'), '2026-03-01');
  assert.equal(nextDue('2028-02-28', 'daily'), '2028-02-29');
  assert.equal(nextDue('2026-12-29', 'weekly'), '2027-01-05');
  assert.equal(nextDue('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextDue('2028-01-31', 'monthly'), '2028-02-29');
  assert.equal(nextDue('2026-02-28', 'monthly', 31), '2026-03-31', 'the anchor brings the 31st back');
  assert.equal(nextDue('2026-03-31', 'monthly'), '2026-04-30');
  assert.equal(nextDue('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(nextDue('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(nextDue('2031-02-28', 'yearly', 29), '2032-02-29');
  assert.equal(addMonths('2026-01-30', 1), '2026-02-28');
  assert.ok(isMonthEnd('2026-02-28') && !isMonthEnd('2028-02-28') && isMonthEnd('2028-02-29'));
  assert.equal(dateInZone(new Date('2026-11-02T23:30:00Z'), 'Pacific/Kiritimati'), '2026-11-03');
  assert.equal(dateInZone(new Date('2026-11-02T02:30:00Z'), 'America/Los_Angeles'), '2026-11-01');
  assert.equal(dateInZone(new Date('2026-11-02T02:30:00Z'), 'Not/AZone'), '2026-11-02', 'an unknown zone is UTC');
  assert.equal(addDays('0050-03-01', 1), '0050-03-02', 'the years 0 to 99 stay themselves');
  assert.equal(nextDue('0099-12-31', 'daily'), '0100-01-01');
  assert.equal(nextDue('0004-01-31', 'monthly'), '0004-02-29');
});

/** An app whose clock is fixed, and a recurring task made by alice. */
async function setup(now = '2026-01-31T10:00:00.000Z', extra = {}) {
  const t = await createTestApp({ now: () => now });
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'chores' })).body;
  let task = (await a.post('/api/tasks', { title: 'Pay rent', recurrence: 'monthly', due_date: '2026-01-31', priority: 'High', notes: 'Bank transfer', tag_ids: [tag.id], ...extra })).body;
  task = (await a.post(`/api/tasks/${task.id}/links`, { version: task.version, url: 'https://example.test/bank', label: 'Bank' })).body;
  task = (await a.post(`/api/tasks/${task.id}/checklist`, { version: task.version, text: 'Check the amount' })).body;
  task = (await a.patch(`/api/tasks/${task.id}/checklist/${task.checklist[0].id}`, { version: task.version, done: true })).body;
  return { t, a, task };
}

/** Close a task and return [the closed task, its copy]. */
async function close(client, task) {
  const r = await client.patch(`/api/tasks/${task.id}`, { version: task.version, status: 'Done' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const copy = r.body.recurred_to ? (await client.get(`/api/tasks/${r.body.recurred_to}`)).body : null;
  return [r.body, copy];
}

test('closing a recurring task creates the next copy in the same write: fields copied, checklist unticked, default status', async () => {
  const { t, a, task } = await setup();
  const [closed, copy] = await close(a, task);
  assert.ok(closed.recurred_to);
  assert.equal(copy.recurred_from, task.id);
  assert.equal(copy.recurred_to, null);
  assert.deepEqual(
    { title: copy.title, project: copy.project_id, owner: copy.owner_id, priority: copy.priority, private: copy.private, notes: copy.notes, recurrence: copy.recurrence, status: copy.status, due: copy.due_date },
    { title: 'Pay rent', project: 'general', owner: 'alice', priority: 'High', private: false, notes: 'Bank transfer', recurrence: 'monthly', status: 'To do', due: '2026-02-28' });
  assert.deepEqual(copy.tags.map((x) => x.name), ['chores']);
  assert.deepEqual(copy.links.map((l) => [l.url, l.label]), [['https://example.test/bank', 'Bank']]);
  assert.deepEqual(copy.checklist.map((c) => [c.text, c.done]), [['Check the amount', false]]);
  assert.equal(task.checklist[0].done, true, 'the closed task keeps its ticks');
  // activity for both: the close names the copy, the copy's create names where it came from
  const acts = (await a.get('/api/activity?item_type=task&limit=200')).body.items;
  const closeEntry = acts.find((x) => x.item_id === task.id && x.action === 'update' && x.changes.status);
  assert.deepEqual(closeEntry.changes.recurred_to, { from: null, to: copy.id });
  const created = acts.find((x) => x.item_id === copy.id);
  assert.equal(created.action, 'create');
  assert.deepEqual(created.changes.recurred_from, { to: task.id });
  assert.deepEqual(created.changes.checklist, { to: [{ text: 'Check the amount', done: false }] });
  await t.close();
});

test('month ends keep the day the series means: 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May', async () => {
  const { t, a, task } = await setup();
  const dues = [task.due_date];
  let cur = task;
  for (let i = 0; i < 4; i++) {
    const [, copy] = await close(a, cur);
    dues.push(copy.due_date);
    cur = copy;
  }
  assert.deepEqual(dues, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  await t.close();
});

test('leap years: a yearly task on 29 February comes back on the 28th, then the 29th in the next leap year', async () => {
  const t = await createTestApp({ now: () => '2028-02-29T12:00:00.000Z' });
  const a = t.as('alice');
  let cur = (await a.post('/api/tasks', { title: 'Leap day', recurrence: 'yearly', due_date: '2028-02-29' })).body;
  const dues = [cur.due_date];
  for (let i = 0; i < 4; i++) { const [, copy] = await close(a, cur); dues.push(copy.due_date); cur = copy; }
  assert.deepEqual(dues, ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  // weekly and daily cross month and year ends
  let w = (await a.post('/api/tasks', { title: 'Weekly', recurrence: 'weekly', due_date: '2028-12-28' })).body;
  assert.equal((await close(a, w))[1].due_date, '2029-01-04');
  w = (await a.post('/api/tasks', { title: 'Daily', recurrence: 'daily', due_date: '2028-02-28' })).body;
  assert.equal((await close(a, w))[1].due_date, '2028-02-29');
  await t.close();
});

test('close, reopen and close again never makes a second copy; nor does closing again after the copy was trashed', async () => {
  const { t, a, task } = await setup();
  const [closed, copy] = await close(a, task);
  let r = await a.patch(`/api/tasks/${task.id}`, { version: closed.version, status: 'Doing' });
  assert.equal(r.body.recurred_to, copy.id, 'reopening keeps the link');
  r = await a.patch(`/api/tasks/${task.id}`, { version: r.body.version, status: 'Done' });
  assert.equal(r.body.recurred_to, copy.id);
  const trashed = (await a.delete(`/api/tasks/${copy.id}`, { version: copy.version })).body;
  r = await a.patch(`/api/tasks/${task.id}`, { version: r.body.version, status: 'To do' });
  r = await a.patch(`/api/tasks/${task.id}`, { version: r.body.version, status: 'Done' });
  assert.equal(r.body.recurred_to, copy.id, 'the trashed copy is still the copy: restore it rather than make another');
  const all = (await a.get('/api/tasks?q=Pay%20rent&include_trashed=true')).body.items;
  assert.equal(all.length, 2);
  assert.ok(trashed.deleted_at);
  // closing the copy makes the copy's own next one
  await a.post(`/api/tasks/${copy.id}/restore`, { version: trashed.version });
  const [, third] = await close(a, (await a.get(`/api/tasks/${copy.id}`)).body);
  assert.equal(third.recurred_from, copy.id);
  // moving between two closed statuses, or closing a task that does not repeat, makes nothing
  const plain = (await a.post('/api/tasks', { title: 'Once', due_date: '2026-02-01' })).body;
  assert.equal((await close(a, plain))[1], null);
  await t.close();
});

test('a private task\'s copy is private to its owner; others see neither task nor any entry', async () => {
  const { t, a, task } = await setup('2026-01-31T10:00:00.000Z', { private: true });
  const [, copy] = await close(a, task);
  assert.equal(copy.private, true);
  const b = t.as('bob');
  assert.equal((await b.get(`/api/tasks/${copy.id}`)).status, 404);
  const feed = JSON.stringify((await b.get('/api/activity?limit=200')).body);
  assert.equal(feed.includes(copy.id) || feed.includes(task.id), false);
  await t.close();
});

test('someone else closing a public recurring task: the copy stays its owner\'s, named as before', async () => {
  const { t, task } = await setup();
  const [, copy] = await close(t.as('bob'), task);
  assert.equal(copy.owner_id, 'alice');
  assert.equal(copy.owner_name, 'Alice Lin');
  const created = (await t.as('bob').get(`/api/activity?item_type=task&item_id=${copy.id}`)).body.items[0];
  assert.equal(created.actor_id, 'bob');
  await t.close();
});

test('no due date: the next one counts from today in the owner\'s time zone', async () => {
  // 23:30 UTC on 2 November is already 3 November in Kiritimati (UTC+14)
  const t = await createTestApp({ now: () => '2026-11-02T23:30:00.000Z' });
  const a = t.as('alice');
  await a.patch('/api/me/preferences', { time_zone: 'Pacific/Kiritimati' });
  const daily = (await a.post('/api/tasks', { title: 'Water plants', recurrence: 'daily' })).body;
  assert.equal((await close(a, daily))[1].due_date, '2026-11-04');
  // bob, on the site default (UTC), closes his own: 2 November + 1
  const b = t.as('bob');
  const his = (await b.post('/api/tasks', { title: 'His plants', recurrence: 'daily' })).body;
  assert.equal((await close(b, his))[1].due_date, '2026-11-03');
  await t.close();
});

test('validation: recurrence is one of the rules or null; recurred_from and recurred_to are read-only', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  let r = await a.post('/api/tasks', { title: 'x', recurrence: 'fortnightly' });
  assert.deepEqual(r.body.error.details.fields, { recurrence: 'must be daily, weekly, monthly, yearly, or null' });
  r = await a.post('/api/tasks', { title: 'x', recurred_from: 'abc' });
  assert.deepEqual(r.body.error.details.fields, { recurred_from: 'read-only' });
  const task = (await a.post('/api/tasks', { title: 'x', recurrence: 'weekly' })).body;
  r = await a.patch(`/api/tasks/${task.id}`, { version: task.version, recurred_to: 'abc' });
  assert.equal(r.status, 400);
  r = await a.patch(`/api/tasks/${task.id}`, { version: task.version, recurrence: null, status: 'Done' });
  assert.equal(r.body.recurred_to, null, 'stopping the repeat and closing in one write makes no copy');
  await t.close();
});

test('edge cases: the year 9999, a trashed project, a private task handed over and closed in one write', async () => {
  const t = await createTestApp({ now: () => '2026-11-02T10:00:00.000Z' });
  const a = t.as('alice');
  const far = (await a.post('/api/tasks', { title: 'Far', recurrence: 'daily', due_date: '9999-12-31' })).body;
  let r = await a.patch(`/api/tasks/${far.id}`, { version: far.version, status: 'Done' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_state');
  assert.equal((await a.get(`/api/tasks/${far.id}`)).body.status, 'To do', 'nothing was written');
  // a trashed project: the close goes through, and no copy is made (nor promised)
  const p = (await a.post('/api/projects', { name: 'Old' })).body;
  const inOld = (await a.post('/api/tasks', { title: 'In old', project_id: p.id, recurrence: 'weekly', due_date: '2026-11-05' })).body;
  await a.delete(`/api/projects/${p.id}`, { version: p.version });
  r = await a.patch(`/api/tasks/${inOld.id}`, { version: inOld.version, status: 'Done' });
  assert.equal(r.status, 200);
  assert.equal(r.body.recurred_to, null);
  // a private task handed to bob and closed in the same write: closed and handed over, no copy
  const mine = (await a.post('/api/tasks', { title: 'Private chore', recurrence: 'weekly', private: true })).body;
  r = await a.patch(`/api/tasks/${mine.id}`, { version: mine.version, owner_id: 'bob', status: 'Done' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recurred_to, null);
  // unknown keys never reach createIn
  r = await a.post('/api/tasks', { title: 'x', copyOwnerName: 'Mallory', owner_id: 'bob' });
  assert.equal(r.body.owner_name, 'Bob Ortiz');
  await t.close();
});

test('privacy: recurred_to and recurred_from never name a task the reader cannot see, in reads, lists or activity', async () => {
  const t = await createTestApp({ now: () => '2026-01-31T10:00:00.000Z' });
  const a = t.as('alice');
  const b = t.as('bob');
  // (a) the copy goes private: bob sees the closed task, but not where it led
  const t1 = (await a.post('/api/tasks', { title: 'Weekly sync', recurrence: 'weekly', due_date: '2026-02-02' })).body;
  const [, t2] = await close(a, t1);
  await a.patch(`/api/tasks/${t2.id}`, { version: t2.version, private: true });
  assert.equal((await b.get(`/api/tasks/${t1.id}`)).body.recurred_to, null);
  assert.equal((await b.get('/api/tasks?q=Weekly')).body.items.find((x) => x.id === t1.id).recurred_to, null);
  assert.equal((await a.get(`/api/tasks/${t1.id}`)).body.recurred_to, t2.id, 'the owner still sees the link');
  let feed = JSON.stringify((await b.get(`/api/activity?item_id=${t1.id}`)).body);
  assert.equal(feed.includes(t2.id), false);
  // (b) the original goes private: bob sees the copy, not where it came from
  const u1 = (await a.post('/api/tasks', { title: 'Daily standup', recurrence: 'daily', due_date: '2026-02-01' })).body;
  const [u1closed, u2] = await close(a, u1);
  await a.patch(`/api/tasks/${u1.id}`, { version: u1closed.version, private: true });
  assert.equal((await b.get(`/api/tasks/${u2.id}`)).body.recurred_from, null);
  feed = JSON.stringify((await b.get(`/api/activity?item_id=${u2.id}`)).body);
  assert.equal(feed.includes(u1.id), false);
  // (c) handing over a private copy: neither side names the other's task
  const v1 = (await b.post('/api/tasks', { title: 'Bob private', recurrence: 'daily', private: true, due_date: '2026-02-01' })).body;
  const [, v2] = await close(b, v1);
  const handed = await b.patch(`/api/tasks/${v2.id}`, { version: v2.version, owner_id: 'alice' });
  assert.equal(handed.status, 200);
  assert.equal((await a.get(`/api/tasks/${v2.id}`)).body.recurred_from, null);
  assert.equal((await b.get(`/api/tasks/${v1.id}`)).body.recurred_to, null);
  // a hidden copy still counts: closing again does not make a second one
  const reopened = (await b.patch(`/api/tasks/${v1.id}`, { version: (await b.get(`/api/tasks/${v1.id}`)).body.version, status: 'To do' })).body;
  const again = (await b.patch(`/api/tasks/${v1.id}`, { version: reopened.version, status: 'Done' })).body;
  assert.equal(again.recurred_to, null);
  assert.equal((await a.get('/api/tasks?q=Bob%20private')).body.items.length, 1, 'still one copy');
  await t.close();
});

test('the owner\'s zone, not the closer\'s; no copy for closed-to-closed moves or tasks that start closed', async () => {
  const t = await createTestApp({ now: () => '2026-11-02T23:30:00.000Z', config: { statuses: { task: ['To do', 'Done', 'Dropped'] }, closed_statuses: { task: ['Done', 'Dropped'] }, attention_statuses: { task: [] } } });
  const a = t.as('alice');
  const b = t.as('bob');
  await a.patch('/api/me/preferences', { time_zone: 'Pacific/Kiritimati' });
  const undated = (await a.post('/api/tasks', { title: 'Hers', recurrence: 'daily' })).body;
  assert.equal((await close(b, undated))[1].due_date, '2026-11-04', 'bob closes it, alice\'s day counts');
  const done = (await a.post('/api/tasks', { title: 'Born closed', recurrence: 'weekly', status: 'Done', due_date: '2026-11-05' })).body;
  let r = await a.patch(`/api/tasks/${done.id}`, { version: done.version, status: 'Dropped' });
  assert.equal(r.body.recurred_to, null, 'closed to closed makes nothing');
  const late = (await a.post('/api/tasks', { title: 'Late repeat', status: 'Done' })).body;
  r = await a.patch(`/api/tasks/${late.id}`, { version: late.version, recurrence: 'daily' });
  assert.equal(r.body.recurred_to, null, 'giving a closed task a repeat makes nothing');
  await t.close();
});

test('privacy: handing a task over never answers with the id of a pair task the writer cannot see', async () => {
  const t = await createTestApp({ now: () => '2026-01-31T10:00:00.000Z' });
  const a = t.as('alice');
  const c = t.as('carol');
  const t1 = (await c.post('/api/tasks', { title: 'Weekly sync', recurrence: 'weekly', due_date: '2026-02-02' })).body;
  const [closed, t2] = await close(c, t1);
  await c.patch(`/api/tasks/${t2.id}`, { version: t2.version, private: true }); // the copy is carol's alone
  const handed = (await c.patch(`/api/tasks/${t1.id}`, { version: closed.version, owner_id: 'alice' })).body;
  assert.equal(handed.recurred_to, t2.id, 'carol, who can see the copy, is told');
  // alice hands it back: her answer is read as carol for the row, but judged by alice for the link
  const back = await a.patch(`/api/tasks/${t1.id}`, { version: handed.version, owner_id: 'carol' });
  assert.equal(back.status, 200);
  assert.equal(back.body.recurred_to, null);
  assert.equal(JSON.stringify(back.body).includes(t2.id), false);
  await t.close();
});
