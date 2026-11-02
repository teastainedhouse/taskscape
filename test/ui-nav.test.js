// ui-nav.test.js — every page with the main toolbar has the same entries, in
// the same order, and every entry has a pixel icon in the theme. The overdue
// marquee in the toolbar is decoration: a page that has it also has the static line.
// Browser storage is touched only inside try; the For you badge rides on boot().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NAV = ['index.html', 'mine.html', 'whats-new.html', 'trash.html', 'profile.html'];

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
  for (const page of [...NAV, 'project.html', 'task.html']) assert.ok(pages.includes(page), `login.js PAGES lacks ${page}`);
});

test('the overdue marquee is never the only overdue signal', () => {
  const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  let withMarquee = 0;
  for (const page of pages) {
    const html = readFileSync(path.join(PUBLIC, page), 'utf8');
    if (!html.includes('id="marquee"')) continue;
    withMarquee++;
    assert.match(html, /id="overdue-line"/, `${page} has the marquee but no static overdue line`);
  }
  assert.ok(withMarquee >= 2);
  const overdue = readFileSync(path.join(PUBLIC, 'js', 'overdue.js'), 'utf8');
  assert.match(overdue, /class: 'marquee', 'aria-hidden': 'true'/, 'the marquee is hidden from assistive tech');
  assert.match(overdue, /class: 'marquee__stop'/, 'the marquee has a Stop button for keyboard and pointer users');
  const base = readFileSync(path.join(PUBLIC, 'css', 'base.css'), 'utf8');
  assert.match(base, /prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/, 'reduced motion stops every animation');
});

test('browser storage is only ever touched inside try, so blocked storage costs a convenience, not the page', () => {
  const dir = path.join(PUBLIC, 'js');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || !/\b(localStorage|sessionStorage)\s*\./.test(line)) return;
      assert.match(line, /\btry\s*\{/, `${file}:${i + 1} reaches storage outside a one-line try`);
    });
  }
});

test('every toolbar page has the avatar link to the profile page, and no page says who is signed in in the header', () => {
  for (const page of readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(path.join(PUBLIC, page), 'utf8');
    if (page === 'login.html') { assert.match(html, /class="avatar" aria-hidden="true"/, 'the sign-in page shows the mark as decoration'); continue; }
    assert.match(html, /<a href="profile.html" class="avatar" id="avatar" aria-label="Your profile"><\/a>/, `${page} lacks the avatar link`);
    assert.match(html, /id="sign-out"/, `${page} lacks the Sign out button`);
    assert.doesNotMatch(html, /whoami/, `${page} still has the "Signed in as" span`);
  }
  const page = readFileSync(path.join(PUBLIC, 'js', 'page.js'), 'utf8');
  assert.match(page, /mountAvatar\(document\.getElementById\('avatar'\), me\)/);
});

test('the What\'s New toolbar entry carries the For you badge from every page', () => {
  const page = readFileSync(path.join(PUBLIC, 'js', 'page.js'), 'utf8');
  assert.match(page, /refreshBadge\(me\)\.catch\(/, 'boot() refreshes the badge and never fails over it');
  const css = readFileSync(path.join(PUBLIC, 'css', 'theme-toolbar.css'), 'utf8');
  assert.match(css, /\.nav-badge\s*\{/);
});
