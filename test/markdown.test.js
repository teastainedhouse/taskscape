import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdCell, mdInline, slug, renderProjectExport } from '../api/lib/markdown.js';

test('mdCell escapes pipes and flattens newlines', () => {
  assert.equal(mdCell('a | b\nc\r\nd'), 'a \\| b c d');
  assert.equal(mdCell(null), '');
});

test('mdInline keeps a heading on one line even with injected markdown', () => {
  const title = 'Real title\n# injected heading\n| fake | row |';
  const out = mdInline(title);
  assert.equal(out.includes('\n'), false);
  assert.equal(out, 'Real title # injected heading | fake | row |');
});

test('slug is ASCII, lowercase, bounded, never empty', () => {
  assert.equal(slug('Ünïcode / Project!'), 'unicode-project');
  assert.equal(slug('日本語'), 'project');
  assert.equal(slug('x'.repeat(100)).length, 60);
});

test('renderProjectExport never lets a task title start a new heading or break the table', () => {
  const project = { name: 'P', status: 'Active', owner_name: 'A', private: false, hit_count: 0, tags: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', description: '' };
  const tasks = [{ title: 'Evil\n# Not a heading', status: 'To do', owner_name: 'A', due_date: null, tags: [], private: false, notes: 'n' }];
  const md = renderProjectExport(project, tasks, { userName: 'A', date: '2026-01-02' });
  const headings = md.split('\n').filter((l) => l.startsWith('#'));
  assert.deepEqual(headings, ['# P', '## Tasks', '### Evil # Not a heading']);
  assert.ok(md.includes('| Evil # Not a heading | To do |'));
});
