// ui-escaping.test.js — the browser UI never turns text into markup.
// Reads every file under public/ and fails on any pattern that could
// inject HTML or script: HTML-setting DOM APIs, document.write, inline
// event handler attributes, script URLs, eval and friends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt', '.md']);

/** Every file under public/, recursively. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Strip HTML and JS/CSS comments so the checks only see live code. */
function stripComments(src, ext) {
  if (ext === '.html' || ext === '.svg') return src.replace(/<!--[\s\S]*?-->/g, '');
  if (ext === '.js' || ext === '.mjs' || ext === '.css') return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  return src;
}

/** Forbidden patterns for every text file. */
const FORBIDDEN = [
  { name: 'innerHTML', re: /\binnerHTML\b/ },
  { name: 'outerHTML', re: /\bouterHTML\b/ },
  { name: 'insertAdjacentHTML', re: /\binsertAdjacentHTML\b/ },
  { name: 'document.write', re: /\bdocument\s*\.\s*write(ln)?\b/ },
  { name: 'script URL', re: /javascript\s*:/i },
  { name: 'eval', re: /\beval\s*\(/ },
  { name: 'new Function', re: /\bnew\s+Function\s*\(/ },
  { name: 'srcdoc', re: /\bsrcdoc\b/i },
  { name: 'setAttribute with an event handler', re: /setAttribute\s*\(\s*['"`]on/i },
  { name: 'DOMParser / createContextualFragment', re: /\b(DOMParser|createContextualFragment)\b/ },
];

/** Inline event handler attributes, checked in markup files only. */
const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/i;

const files = walk(PUBLIC).filter((f) => TEXT_EXT.has(path.extname(f)));

test('public/ exists and has the eight pages', () => {
  const names = new Set(files.map((f) => path.relative(PUBLIC, f)));
  for (const page of ['index.html', 'mine.html', 'project.html', 'task.html', 'whats-new.html', 'trash.html', 'profile.html', 'login.html']) assert.ok(names.has(page), `missing ${page}`);
  assert.ok(names.has(path.join('js', 'dom.js')), 'missing js/dom.js');
});

for (const file of files) {
  const rel = path.relative(PUBLIC, file);
  const ext = path.extname(file);
  test(`no markup injection in ${rel}`, () => {
    const src = stripComments(readFileSync(file, 'utf8'), ext);
    for (const { name, re } of FORBIDDEN) {
      const m = re.exec(src);
      assert.equal(m, null, `${rel} uses ${name}: ${m && JSON.stringify(src.slice(Math.max(0, m.index - 40), m.index + 60))}`);
    }
    if (ext === '.html' || ext === '.svg') {
      const m = INLINE_HANDLER.exec(src);
      assert.equal(m, null, `${rel} has an inline event handler attribute: ${m && JSON.stringify(m[0].slice(0, 100))}`);
    }
  });
}

test('tag colors are applied only after #rrggbb validation', () => {
  const dom = readFileSync(path.join(PUBLIC, 'js', 'dom.js'), 'utf8');
  assert.match(dom, /\/\^#\[0-9a-fA-F\]\{6\}\$\//, 'dom.js must validate #rrggbb before setting a tag color');
  for (const file of files.filter((f) => path.extname(f) === '.js')) {
    const src = readFileSync(file, 'utf8');
    if (/style\.backgroundColor\s*=/.test(src)) assert.equal(path.basename(file), 'dom.js', `${path.relative(PUBLIC, file)} sets backgroundColor outside dom.js`);
  }
});
