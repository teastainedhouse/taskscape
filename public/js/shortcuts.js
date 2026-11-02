// shortcuts.js — single-key keyboard shortcuts, loaded by every page through
// page.js and switched on or off by the person's `shortcuts` preference
// (WCAG 2.1.4: a single-character shortcut must be possible to turn off).
//
//   /            focus the search box (on another page: go to the project list and focus it there)
//   n            new item: a project on the project list, a task on a project page
//   ?            this list, in a native <dialog>
//   g then h/m/w/t/p   go to Home, My tasks, What's New, Trash, Profile
//
// Keys are ignored while focus is in an input, textarea, select, or
// contenteditable element, inside an open dialog, and when Ctrl, Alt or Meta
// is held. No shortcut trashes or restores anything.

import { el, btn } from './dom.js';
import { say } from './page.js';

/** Where `g` goes. */
const GO = { h: ['index.html', 'Home (the project list)'], m: ['mine.html', 'My tasks'], w: ['whats-new.html', "What's New"], t: ['trash.html', 'Trash'], p: ['profile.html', 'Profile'] };
/** How long the second key of a sequence may take, in ms. */
const SEQUENCE_MS = 1500;

/** @type {HTMLDialogElement|null} */
let helpDialog = null;
let pendingG = 0;
/** The key whose first press fired a shortcut; its auto-repeat must not type into the field it focused. */
let firedKey = null;
/** The nodes announceKeys() marked, so unmounting clears only those. @type {Element[]} */
let marked = [];

/** True when a key press belongs to whatever has focus, not to us. @param {KeyboardEvent} ev */
function typing(ev) {
  const t = ev.target;
  if (document.querySelector('dialog[open]')) return true;
  if (!(t instanceof Element)) return true; // nothing we can judge: leave it alone
  return t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

/** Focus the search box, or go to the page that has one. */
function search() {
  const box = document.getElementById('search-q');
  if (box) { box.focus(); box.select?.(); return; }
  location.href = 'index.html#search';
}

/** Focus the new-item form this page has, if the viewer may use it. */
function create() {
  const field = document.getElementById('np-name') ?? document.getElementById('nt-title');
  const form = field?.closest('form');
  if (!field || !form || form.hidden || form.closest('[hidden]')) { say('Nothing to create from this page.'); return; }
  field.focus();
  field.scrollIntoView({ block: 'center' });
}

/** The help dialog, built once. */
function help() {
  if (!helpDialog) {
    const rows = [
      ['/', 'Search'],
      ['n', 'New project (on the project list) or new task (on a project page)'],
      ['?', 'This list'],
      ...Object.entries(GO).map(([k, [, name]]) => [`g then ${k}`, `Go to ${name}`]),
    ];
    const table = el('table', { class: 'shortcuts' },
      el('caption', { class: 'visually-hidden' }, 'Keyboard shortcuts'),
      el('tbody', null, rows.map(([keys, what]) => el('tr', null,
        el('th', { scope: 'row' }, keys.split(' then ').map((k, i) => [i ? ' then ' : null, el('kbd', null, k)])),
        el('td', null, what)))));
    const close = btn('Close', () => helpDialog?.close(), { autofocus: true }); // so Enter right after ? closes it rather than following the link
    helpDialog = /** @type {HTMLDialogElement} */ (el('dialog', { class: 'shortcuts-help', 'aria-labelledby': 'shortcuts-h' },
      el('h2', { id: 'shortcuts-h' }, 'Keyboard shortcuts'), table,
      el('p', { class: 'muted' }, 'Shortcuts never trash or restore anything. Turn them off on your ', el('a', { href: 'profile.html' }, 'profile page'), '.'),
      el('p', null, close)));
    // a click on the backdrop closes it: the dialog's own box (padding included) does not
    helpDialog.addEventListener('click', (ev) => {
      const r = helpDialog.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) helpDialog.close();
    });
    document.body.appendChild(helpDialog);
  }
  if (!helpDialog.open) helpDialog.showModal();
}

/** @param {KeyboardEvent} ev */
function onKey(ev) {
  if (ev.repeat && ev.key === firedKey) { ev.preventDefault(); return; } // holding / or n must not type into the field it focused
  if (ev.defaultPrevented || ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) return;
  if (typing(ev)) return;
  if (ev.key.length > 1) return; // Shift, CapsLock, arrows and such: not a shortcut, and they leave a pending g alone
  const key = ev.key.toLowerCase(); // Caps Lock on still works
  const now = Date.now();
  if (pendingG && now - pendingG <= SEQUENCE_MS && key !== 'g') {
    pendingG = 0;
    if (Object.hasOwn(GO, key)) { ev.preventDefault(); location.href = GO[key][0]; return; }
    // not a destination: the key means what it always means (a / or n right after a stray g still works)
  }
  pendingG = 0;
  switch (key) {
    case '/': ev.preventDefault(); firedKey = ev.key; search(); break;
    case 'n': ev.preventDefault(); firedKey = ev.key; create(); break;
    case '?': ev.preventDefault(); help(); break;
    case 'g': pendingG = now; break; // g g restarts the sequence
    default: break;
  }
}

/** @param {KeyboardEvent} ev */
function onKeyUp(ev) {
  if (ev.key === firedKey) firedKey = null;
}

/**
 * Mark the single-key targets, so assistive tech can say so. The `g` sequences are
 * not marked: aria-keyshortcuts has no way to say "g then h" (a space means "or").
 */
function announceKeys() {
  marked = [];
  for (const [id, key] of [['search-q', '/'], ['np-name', 'n'], ['nt-title', 'n']]) {
    const n = document.getElementById(id);
    if (n) { n.setAttribute('aria-keyshortcuts', key); marked.push(n); }
  }
}

let mounted = false;

/**
 * Switch the shortcuts on or off for this page. Safe to call again after a preference change.
 * @param {boolean} enabled
 */
export function mountShortcuts(enabled) {
  if (enabled && !mounted) {
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    announceKeys();
    mounted = true;
  } else if (!enabled && mounted) {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    for (const n of marked) n.removeAttribute('aria-keyshortcuts');
    marked = [];
    pendingG = 0;
    firedKey = null;
    mounted = false;
  }
  // Arriving from "/" on another page: the project list focuses its search box.
  if (enabled && location.hash === '#search') {
    const box = document.getElementById('search-q');
    if (box) { box.focus(); history.replaceState(null, '', location.pathname + location.search); }
  }
}
