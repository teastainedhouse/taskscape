import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdCell, mdInline, mdText, slug, renderProjectExport } from '../api/lib/markdown.js';

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

test('a bare \\r is a line break: cells and headings flatten it', () => {
  assert.equal(mdCell('a\rb'), 'a b');
  assert.equal(mdInline('Title\r# not a heading'), 'Title # not a heading');
});

test('mdText escapes Markdown punctuation, so a name cannot add a link or emphasis', () => {
  assert.equal(mdText('Eve** [x](https://example.invalid) **'), 'Eve\\*\\* \\[x\\]\\(https://example.invalid\\) \\*\\*');
  assert.equal(mdText('Ana_Lee'), 'Ana\\_Lee');
});

test('renderProjectExport keeps guestbook text quoted and names escaped, even with a stored bare \\r', () => {
  const project = { name: 'P', status: 'Active', owner_name: 'A', private: false, hit_count: 0, tags: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', description: 'see [docs]' };
  const comment = { author_name: 'Eve** [re-download](https://example.invalid) **', created_at: '2026-01-01T00:00:00Z',
    body: 'hi\r# Injected\r[docs]: https://example.invalid/phish' };
  const md = renderProjectExport(project, [], { userName: 'Mallory [x](https://example.invalid)', date: '2026-01-02' }, { project: [comment] });
  const lines = md.split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('#')), ['# P', '## Tasks', '## Guestbook']);
  assert.ok(lines.includes('> \\[docs]: https://example.invalid/phish'));
  assert.ok(lines.includes('**Eve\\*\\* \\[re-download\\]\\(https://example.invalid\\) \\*\\***, 2026-01-01:'));
  assert.ok(md.includes('by Mallory \\[x\\]\\(https://example.invalid\\).'));
  assert.equal(md.includes('\r'), false);
});
