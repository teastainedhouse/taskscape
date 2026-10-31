import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('search: case-insensitive substring over names, titles, descriptions, notes; wildcards are literal', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'Website Refresh', description: 'Ship by Q4 (100% done)' })).body;
  const t1 = (await a.post('/api/tasks', { title: 'Fix broken_links', project_id: p.id })).body;
  const t2 = (await a.post('/api/tasks', { title: 'Other', notes: 'see the website', project_id: p.id })).body;
  await a.post('/api/tasks', { title: 'Backslash \\ here' });
  let r = await a.get('/api/search?q=WEBSITE');
  assert.deepEqual(r.body.projects.map((x) => x.id), [p.id]);
  assert.deepEqual(r.body.tasks.map((x) => x.id), [t2.id]);
  r = await a.get('/api/search?q=100%25');
  assert.deepEqual(r.body.projects.map((x) => x.id), [p.id]);
  r = await a.get('/api/search?q=n_l');
  assert.deepEqual(r.body.tasks.map((x) => x.id), [t1.id]);
  r = await a.get('/api/search?q=x_l'); // underscore does not act as a wildcard
  assert.deepEqual(r.body.tasks, []);
  r = await a.get('/api/search?q=' + encodeURIComponent('\\'));
  assert.equal(r.status, 400); // one char is too short
  r = await a.get('/api/search?q=' + encodeURIComponent('\\ h'));
  assert.deepEqual(r.body.tasks.map((x) => x.title), ['Backslash \\ here']);
  assert.equal((await a.get('/api/search?q=ab&limit=0')).status, 400);
  assert.equal((await a.get('/api/search?q=ab&limit=1')).status, 200);
  await t.close();
});

test('search excludes trashed items and respects privacy', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const gone = (await a.post('/api/tasks', { title: 'Findable thing' })).body;
  await a.delete(`/api/tasks/${gone.id}`, { version: 1 });
  await a.post('/api/tasks', { title: 'Findable secret', private: true });
  assert.deepEqual((await a.get('/api/search?q=findable')).body.tasks.map((x) => x.title), ['Findable secret']);
  assert.deepEqual((await t.as('bob').get('/api/search?q=findable')).body.tasks, []);
  await t.close();
});
