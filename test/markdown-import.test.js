// markdown-import.test.js — the pure parser for the export format: it reads
// exactly what renderProjectExport() writes, counts comments without keeping
// them, and names field and line (never the value) when the file is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectExport } from '../api/lib/markdown.js';
import { parseProjectExport, splitCells, ImportParseError } from '../api/lib/markdown-import.js';

const project = { name: 'Site | refresh', status: 'Active', owner_name: 'Alice Lin', private: false, hit_count: 12, tags: [{ name: 'web' }, { name: 'q4' }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', description: 'Line one\n\n  indented two\n' };
const tasks = [
  { id: 't1', title: 'Fix | GIFs', status: 'To do', priority: 'High', recurrence: 'monthly', owner_name: 'Alice Lin', due_date: '2026-11-05', tags: [{ name: 'bug' }], private: false, notes: 'Notes **bold**\n\nsecond paragraph' },
  { id: 't2', title: 'Plain', status: 'Done', owner_name: 'Bob Ortiz', due_date: null, tags: [], private: true, notes: 'first Plain' },
  { id: 't3', title: 'Plain', status: 'Doing', owner_name: 'Carol Nkemelu', due_date: null, tags: [], private: false, notes: 'second Plain has notes' },
  { id: 't4', title: 'Commented only', status: 'To do', owner_name: 'Alice Lin', due_date: null, tags: [], private: false, notes: '' },
];
const comments = { project: [{ author_name: 'Bob', created_at: '2026-01-03T00:00:00Z', body: 'Hi\n### not a heading' }],
  tasks: new Map([['t1', [{ author_name: 'Carol', created_at: '2026-01-03T00:00:00Z', body: 'On the task' }]], ['t4', [{ author_name: 'D', created_at: '2026-01-04T00:00:00Z', body: 'x' }, { author_name: 'E', created_at: '2026-01-04T00:00:00Z', body: 'y' }]]]) };

test('splitCells undoes the export\'s pipe escape and trims', () => {
  assert.deepEqual(splitCells('| a \\| b | c |  | d |'), ['a | b', 'c', '', 'd']);
  assert.deepEqual(splitCells('| Field | Value |'), ['Field', 'Value']);
});

test('what renderProjectExport writes, parseProjectExport reads back', () => {
  const md = renderProjectExport(project, tasks, { userName: 'Alice Lin', date: '2026-01-05' }, comments);
  const out = parseProjectExport(md);
  assert.deepEqual(out.project, { name: 'Site | refresh', description: 'Line one\n\n  indented two', status: 'Active', owner_name: 'Alice Lin', private: false, tags: ['web', 'q4'] });
  assert.deepEqual(out.tasks.map((t) => [t.title, t.status, t.owner_name, t.due_date, t.tags, t.private, t.notes]), [
    ['Fix | GIFs', 'To do', 'Alice Lin', '2026-11-05', ['bug'], false, 'Notes **bold**\n\nsecond paragraph'],
    ['Plain', 'Done', 'Bob Ortiz', null, [], true, 'first Plain'],
    ['Plain', 'Doing', 'Carol Nkemelu', null, [], false, 'second Plain has notes'],
    ['Commented only', 'To do', 'Alice Lin', null, [], false, ''],
  ]);
  assert.deepEqual(out.tasks.map((t) => t.priority), ['High', null, null, null]);
  assert.deepEqual(out.tasks.map((t) => t.recurrence), ['monthly', null, null, null]);
  assert.ok(out.tasks.every((t) => Number.isInteger(t.line) && t.line > 1));
  assert.equal(out.comments_skipped, 4, 'one on the project, three on tasks: counted, never kept');
  assert.equal(JSON.stringify(out).includes('On the task'), false);
});

test('an empty project, a project with no description, and an older "Guestbook" export', () => {
  const empty = renderProjectExport({ ...project, description: '', tags: [] }, [], { userName: 'A', date: '2026-01-05' });
  const out = parseProjectExport(empty);
  assert.deepEqual(out.tasks, []);
  assert.equal(out.project.description, '');
  assert.deepEqual(out.project.tags, []);
  const old = renderProjectExport(project, tasks.slice(0, 1), { userName: 'A', date: '2026-01-05' }, comments).replace('Comments:', 'Guestbook:').replace('## Comments', '## Guestbook');
  assert.equal(parseProjectExport(old).comments_skipped, 2);
});

test('a hand-written file works too, and problems name field and line only', () => {
  const out = parseProjectExport('# Hand made\n\nJust a description.\n\n## Tasks\n\n| Title | Status |\n| --- | --- |\n| One | To do |\n| Two |  |\n');
  assert.equal(out.project.status, null);
  assert.deepEqual(out.tasks.map((t) => [t.title, t.status, t.line]), [['One', 'To do', 9], ['Two', null, 10]]);
  for (const [text, field, line] of [
    ['no heading\n## Tasks\n', 'name', 1],
    ['# P\n\nno tasks section\n', 'tasks', 3],
    ['# P\n\n## Tasks\n\n| Status |\n| --- |\n| x |\n', 'tasks', 5],
    ['# P\n\n## Tasks\n\n| Title | Status |\n| --- | --- |\n|  | To do |\n', 'title', 7],
    ['# P\n\n## Tasks\n\n_No tasks._\n\nstray words SECRET\n', 'tasks', 7],
  ]) {
    assert.throws(() => parseProjectExport(text), (e) => e instanceof ImportParseError && e.field === field && e.line === line, text);
  }
  try { parseProjectExport('# P\n\n## Tasks\n\n_No tasks._\n\nstray words SECRET\n'); assert.fail('should throw'); } catch (e) {
    assert.ok(e instanceof ImportParseError);
    assert.equal(e.field, 'tasks');
    assert.equal(e.line, 7);
    assert.equal(e.message.includes('SECRET'), false);
  }
});

test('a file of many same-title rows and sections parses in linear time, and stops at the task cap', () => {
  const n = 26_000; // fits in the 256 KB body limit
  const text = `# P\n\n## Tasks\n\n| Title |\n| --- |\n${'| a |\n'.repeat(n)}\n${'### a\n\n'.repeat(n)}`;
  let t0 = performance.now();
  const parsed = parseProjectExport(text);
  assert.equal(parsed.tasks.length, n);
  assert.ok(performance.now() - t0 < 5_000, 'was a minute (a per-task scan of every task)');
  t0 = performance.now();
  assert.throws(() => parseProjectExport(text, { maxTasks: 1000 }), (e) => e.field === 'tasks' && e.line === 1007);
  assert.ok(performance.now() - t0 < 1_000);
});
