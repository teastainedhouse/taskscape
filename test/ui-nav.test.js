// ui-nav.test.js — every page with the main toolbar has the same entries, in
// the same order, and every entry has a pixel icon in the theme.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NAV = ['index.html', 'mine.html', 'whats-new.html', 'trash.html', 'tokens.html'];

/** The hrefs inside <nav aria-label="Main">, or null when the page has none. */
function navLinks(html) {
  const m = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(html);
  return m ? [...m[1].matchAll(/<a href="([^"]+)"/g)].map((x) => x[1]) : null;
}

test('every toolbar page lists the same entries, and each entry page has the toolbar', () => {
  const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const links = navLinks(readFileSync(path.join(PUBLIC, page), 'utf8'));
    if (page === 'login.html') { assert.equal(links, null, 'the sign-in page has no toolbar'); continue; }
    assert.deepEqual(links, NAV, page);
  }
  for (const target of NAV) assert.ok(pages.includes(target), `missing ${target}`);
});

test('each toolbar entry has an icon in theme-toolbar.css', () => {
  const css = readFileSync(path.join(PUBLIC, 'css', 'theme-toolbar.css'), 'utf8');
  for (const href of NAV) assert.match(css, new RegExp(`nav a\\[href="${href.replace('.', '\\.')}"\\] \\{ --icon: var\\(--icon-[a-z]+\\); \\}`), href);
});

test('sign-in can send people back to every toolbar page and the project page', () => {
  const login = readFileSync(path.join(PUBLIC, 'js', 'login.js'), 'utf8');
  const m = /const PAGES = new Set\(\[([^\]]*)\]\)/.exec(login);
  assert.ok(m, 'login.js has a PAGES allowlist');
  const pages = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  for (const page of [...NAV, 'project.html']) assert.ok(pages.includes(page), `login.js PAGES lacks ${page}`);
});
