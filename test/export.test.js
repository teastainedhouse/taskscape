import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

test('export: markdown attachment with the documented layout', async () => {
  const t = await createTestApp({ now: () => '2026-11-02T12:00:00.000Z' });
  const a = t.as('alice');
  const tag = (await a.post('/api/tags', { name: 'web' })).body;
  const p = (await a.post('/api/projects', { name: 'Ünïcode / Project!', description: 'Line one\n\nLine two', status: 'Active', tag_ids: [tag.id] })).body;
  await a.post('/api/tasks', { title: 'Pipe | in title', project_id: p.id, priority: 'High', recurrence: 'weekly', due_date: '2026-11-05', notes: 'Some **notes**\nover lines' });
  await a.post('/api/tasks', { title: 'Second', project_id: p.id, status: 'Done' });
  const trashed = (await a.post('/api/tasks', { title: 'Trashed', project_id: p.id })).body;
  await a.delete(`/api/tasks/${trashed.id}`, { version: 1 });
  const r = await a.get(`/api/projects/${p.id}/export.md`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="unicode-project.md"');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const md = r.text;
  assert.ok(md.startsWith('# Ünïcode / Project!\n\n| Field | Value |\n| --- | --- |\n| Status | Active |\n| Owner | Alice Lin |\n| Private | no |\n| Hits | 0 |\n| Tags | web |\n'));
  assert.ok(md.includes('Line one\n\nLine two\n'));
  assert.ok(md.includes('| Pipe \\| in title | To do | High | Alice Lin | 2026-11-05 | weekly |  | no |'));
  assert.ok(md.includes('| Second | Done |  | Alice Lin |  |  |  | no |'));
  assert.ok(md.includes('### Pipe | in title\n\nSome **notes**\nover lines\n'));
  assert.equal(md.includes('Trashed'), false);
  assert.ok(md.endsWith('---\nExported from Taskscape on 2026-11-02 by Alice Lin.\n'));
  // due date sort: dated task first
  assert.ok(md.indexOf('Pipe') < md.indexOf('Second'));
  await t.close();
});

test('export of an empty project and of a private project', async () => {
  const t = await createTestApp();
  const c = t.as('carol');
  const p = (await c.post('/api/projects', { name: 'Empty', private: true })).body;
  const r = await c.get(`/api/projects/${p.id}/export.md`);
  assert.ok(r.text.includes('## Tasks\n\n_No tasks._\n'));
  assert.ok(r.text.includes('| Private | yes |'));
  assert.equal((await t.as('bob').get(`/api/projects/${p.id}/export.md`)).status, 404);
  await t.close();
});

test('a trashed project exports the tasks that went with it, not those trashed on their own', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const p = (await a.post('/api/projects', { name: 'Gone' })).body;
  await a.post('/api/tasks', { title: 'Went with it', project_id: p.id });
  const own = (await a.post('/api/tasks', { title: 'Own trash', project_id: p.id })).body;
  await a.delete(`/api/tasks/${own.id}`, { version: own.version });
  await a.delete(`/api/projects/${p.id}`, { version: p.version });
  const md = (await a.get(`/api/projects/${p.id}/export.md`)).text;
  assert.ok(md.includes('| Went with it |'));
  assert.equal(md.includes('Own trash'), false);
  await t.close();
});
