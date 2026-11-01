// pager.test.js — paging through lists with offset (docs/API.md §5): the API
// with a small page size, and the browser's "Load more" helper
// (public/js/pager.js) driven by a fake button against the real app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { createPager } from '../public/js/pager.js';

const small = () => createTestApp({ config: { limits: { page_size: 2 } } });

/** Every page of a list route, following offset until a page comes back short. */
async function allPages(client, path) {
  const out = [];
  for (let offset = 0; ; ) {
    const r = await client.get(`${path}${path.includes('?') ? '&' : '?'}offset=${offset}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.limit, 2);
    assert.equal(r.body.offset, offset);
    out.push(...r.body.items);
    if (r.body.items.length < r.body.limit) return out;
    offset += r.body.items.length;
  }
}

test('lists page by offset at limits.page_size, keeping sort and filters across pages', async () => {
  const t = await small();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'P' })).body;
  for (const [title, due, status] of [['e', '2026-11-05', 'To do'], ['a', '2026-11-01', 'Done'], ['d', '2026-11-04', 'To do'],
    ['b', '2026-11-02', 'To do'], ['c', '2026-11-03', 'Doing']]) {
    await a.post('/api/tasks', { title, project_id: p.id, due_date: due, status });
  }
  for (const name of ['Q', 'R', 'S']) await a.post('/api/projects', { name });
  assert.equal((await a.get('/api/tasks')).body.items.length, 2, 'one page is page_size long');
  const byDue = await allPages(a, `/api/tasks?project=${p.id}&sort=due_date`);
  assert.deepEqual(byDue.map((x) => x.title), ['a', 'b', 'c', 'd', 'e']);
  const open = await allPages(a, `/api/tasks?project=${p.id}&sort=title&dir=desc&status=To%20do,Doing`);
  assert.deepEqual(open.map((x) => x.title), ['e', 'd', 'c', 'b']);
  const projects = await allPages(a, '/api/projects?sort=name');
  assert.deepEqual(projects.map((x) => x.name), ['General', 'P', 'Q', 'R', 'S']);
  await t.close();
});

test('another user pages through full pages with private rows interleaved, and sees none of them', async () => {
  const t = await small();
  const a = t.as('alice');
  const c = t.as('carol');
  const p = (await a.post('/api/projects', { name: 'Shared' })).body;
  for (const n of [1, 2, 3]) {
    await a.post('/api/tasks', { title: `public ${n}`, project_id: p.id });
    await c.post('/api/tasks', { title: `secret ${n}`, project_id: p.id, private: true });
    await a.post('/api/projects', { name: `Open ${n}` });
    await c.post('/api/projects', { name: `Hidden ${n}`, private: true });
  }
  const b = t.as('bob');
  for (const sort of ['title', 'updated_at', 'created_at']) {
    const tasks = await allPages(b, `/api/tasks?project=${p.id}&sort=${sort}`);
    assert.deepEqual(tasks.map((x) => x.title).sort(), ['public 1', 'public 2', 'public 3'], sort);
  }
  const projects = await allPages(b, '/api/projects?sort=name');
  assert.deepEqual(projects.map((x) => x.name), ['General', 'Open 1', 'Open 2', 'Open 3', 'Shared']);
  const past = await b.get(`/api/tasks?project=${p.id}&offset=1000`);
  assert.deepEqual(past.body, { items: [], limit: 2, offset: 1000 });
  await t.close();
});

/** A stand-in for the Load more button. */
function fakeButton() {
  const b = { hidden: false, ariaDisabled: null, click: null, addEventListener: (type, fn) => { if (type === 'click') b.click = fn; } };
  return b;
}

test('the Load more helper keeps the first query, hides at the end, and steps back after a removal', async () => {
  const t = await small();
  const a = t.as('alice');
  for (const title of ['a', 'b', 'c', 'd', 'e']) await a.post('/api/tasks', { title });
  const seen = [];
  const queries = [];
  const button = fakeButton();
  let sort = 'title';
  const pager = createPager({
    path: '/api/tasks',
    button,
    query: () => ({ sort }),
    onPage: (items, first) => { if (first) seen.length = 0; seen.push(...items.map((x) => x.title)); },
    onError: (err) => { throw err; },
    fetchPage: async (path, query) => {
      queries.push(query);
      const qs = new URLSearchParams(query).toString();
      return (await a.get(`${path}?${qs}`)).body;
    },
  });
  assert.equal(button.hidden, true, 'hidden until a full page arrives');
  await pager.reload();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(button.hidden, false);
  sort = 'updated_at'; // a later change does not leak into the next page of this list
  await button.click();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.deepEqual(queries.at(-1), { sort: 'title', offset: 2 });
  // "b" is trashed from the loaded list: the next page starts one earlier, so nothing is skipped
  const b = (await a.get('/api/tasks?q=b')).body.items[0];
  await a.delete(`/api/tasks/${b.id}`, { version: b.version });
  pager.removed();
  await button.click();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(button.hidden, true, 'a short page ends the list');
  // starting over takes the query as it is now
  await pager.reload();
  assert.deepEqual(queries.at(-1), { sort: 'updated_at' });
  assert.equal(seen.length, 2);
  await t.close();
});

test('a response for an abandoned list is dropped', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const button = fakeButton();
  const pages = [];
  let n = 0;
  const pager = createPager({
    path: '/x', button, query: () => ({}),
    onPage: (items) => { pages.push(items[0]); },
    onError: () => {},
    fetchPage: async () => { n++; if (n === 1) { await slow; return { items: ['old'], limit: 1 }; } return { items: ['new'], limit: 1 }; },
  });
  const first = pager.reload();
  await pager.reload();
  release();
  await first;
  assert.deepEqual(pages, ['new']);
});

test('a row that an edit moved past the offset is not shown twice', async () => {
  const t = await small();
  const a = t.as('alice');
  for (const title of ['a', 'b', 'c', 'd']) await a.post('/api/tasks', { title });
  const seen = [];
  const button = fakeButton();
  const pager = createPager({
    path: '/api/tasks', button, query: () => ({ sort: 'title' }),
    onPage: (items) => { seen.push(...items.map((x) => x.title)); },
    onError: (err) => { throw err; },
    fetchPage: async (path, query) => (await a.get(`${path}?${new URLSearchParams(query)}`)).body,
  });
  await pager.reload();
  assert.deepEqual(seen, ['a', 'b']);
  const first = (await a.get('/api/tasks?q=a&sort=title')).body.items[0];
  await a.patch(`/api/tasks/${first.id}`, { version: first.version, title: 'zz' }); // now sorts after the offset
  pager.removed(); // what the task table does after any edit of a loaded row
  await button.click();
  await button.click();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'], 'nothing skipped, and the renamed row is not shown twice');
  await t.close();
});

test('Load more stays focusable while a page loads and ignores clicks meanwhile', async () => {
  let release;
  const button = fakeButton();
  let calls = 0;
  const pager = createPager({
    path: '/x', button, query: () => ({}),
    onPage: () => null,
    onError: () => {},
    fetchPage: async () => { calls++; if (calls === 2) await new Promise((r) => { release = r; }); return { items: [{ id: calls }], limit: 1 }; },
  });
  await pager.reload();
  const loading = button.click();
  assert.equal(button.ariaDisabled, 'true', 'marked busy, not disabled, so focus stays on it');
  assert.equal('disabled' in button && button.disabled, false);
  button.click();
  assert.equal(calls, 2, 'a second click while busy sends nothing');
  release();
  await loading;
  assert.equal(button.ariaDisabled, null);
});

test('an offset beyond the safe integer range is a 400 on offset, not a 500', async () => {
  const t = await small();
  const a = t.as('alice');
  for (const path of ['/api/tasks', '/api/projects']) {
    for (const bad of ['1e19', '9223372036854775807', '9007199254740992']) {
      const r = await a.get(`${path}?offset=${bad}`);
      assert.equal(r.status, 400, `${path} ${bad}`);
      assert.deepEqual(r.body.error.details, { fields: { offset: 'must be a non-negative integer' } });
    }
    assert.equal((await a.get(`${path}?offset=9007199254740991`)).status, 200);
  }
  await t.close();
});
