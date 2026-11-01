// guestbook.js — the Guestbook of a project or a task (docs/PLAN.md §8):
// entries oldest first, a "Sign the guestbook" form for editors, and Trash or
// Restore on the viewer's own entries. Nobody edits an entry. A trashed entry
// shows only to its author, who restores it here; the Trash page does not
// list comments. Entry text is data, rendered as text only.

import { get, post, del, itemPath, ApiError } from './api.js';
import { el, btn, setChildren, timeEl } from './dom.js';
import { say, sayError, attempt } from './page.js';

/** Matches COMMENT_MAX in api/lib/validate.js. */
const MAX = 2000;

const commentPath = (id) => `/api/comments/${encodeURIComponent(id)}`;

/**
 * A guestbook section. It loads on creation; keep the element to keep a draft
 * (the task table reuses it when it rebuilds a notes row).
 * @param {{type: 'project'|'task', id: string, label: string, heading: 'h2'|'h3', me: {id: string},
 *          canSign: () => boolean}} opts  label names the parent for screen readers
 * @returns {HTMLElement & {refresh: () => void, relabel: (label: string) => void}}  refresh() after canSign() may have changed
 */
export function guestbook({ type, id, label, heading, me, canSign }) {
  const headingId = `guestbook-${type}-${id}-h`;
  const list = el('ol', { class: 'guestbook-list' });
  const empty = el('p', { class: 'muted' }, 'Loading the guestbook…');
  const textarea = el('textarea', { id: `guestbook-${type}-${id}-body`, rows: '3', maxlength: String(MAX), required: true });
  const form = el('form', { class: 'guestbook-sign' },
    el('label', { for: textarea.id }, 'Sign the guestbook'), textarea, ' ', el('button', { type: 'submit' }, 'Sign'));
  const forWhom = el('span', { class: 'visually-hidden' }, ` for ${label}`);
  const section = /** @type {HTMLElement & {refresh: () => void, relabel: (label: string) => void}} */ (el('section', { class: 'guestbook', 'aria-labelledby': headingId },
    el(heading, { id: headingId }, 'Guestbook', forWhom), empty, list, form));

  /** @type {any[]} */
  let entries = [];
  let sending = false;
  let loaded = false;

  const show = () => {
    setChildren(list, entries.map(entry));
    empty.hidden = entries.length > 0;
    empty.textContent = 'No entries yet.';
    form.hidden = !canSign();
  };

  /** @param {any} c */
  function entry(c) {
    const mine = c.author_id === me.id;
    const trashed = !!c.deleted_at;
    const body = el('p', { class: 'guestbook-body' }, c.body);
    const actions = [];
    if (mine && canSign()) {
      actions.push(trashed
        ? btn('Restore', () => change(c, 'restore'), { 'aria-label': 'Restore your guestbook entry' })
        : btn('Trash', () => change(c, 'trash'), { 'aria-label': 'Trash your guestbook entry' }));
    }
    return el('li', { class: trashed ? 'guestbook-entry trashed' : 'guestbook-entry', id: `comment-${c.id}` },
      el('p', { class: 'guestbook-by' }, el('b', null, c.author_name), ' · ', timeEl(c.created_at),
        trashed ? el('span', { class: 'muted' }, ' · in the trash; only you see it') : null),
      body, actions.length ? el('p', { class: 'guestbook-actions' }, actions) : null);
  }

  /** Replace one entry in place and focus its button. @param {any} c */
  function put(c) {
    const i = entries.findIndex((x) => x.id === c.id);
    if (i < 0) return;
    entries[i] = c;
    const fresh = entry(c);
    document.getElementById(`comment-${c.id}`)?.replaceWith(fresh);
    fresh.querySelector('button')?.focus();
  }

  /** @param {any} c @param {'trash'|'restore'} action */
  async function change(c, action) {
    if (action === 'trash' && !confirm('Move your guestbook entry to the trash? You can restore it here.')) return;
    const rec = await attempt(() => (action === 'trash'
      ? del(commentPath(c.id), { version: c.version })
      : post(`${commentPath(c.id)}/restore`, { version: c.version })), put);
    if (rec) { put(rec); say(action === 'trash' ? 'Guestbook entry moved to the trash.' : 'Guestbook entry restored.'); }
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (sending || !textarea.value.trim()) return;
    sending = true;
    try {
      const c = await post(`${itemPath(type, id)}/comments`, { body: textarea.value });
      textarea.value = '';
      entries.push(c);
      show();
      say('Thanks for signing the guestbook!');
    } catch (err) { sayError(err, 'Could not sign the guestbook'); } finally { sending = false; }
  });

  get(`${itemPath(type, id)}/comments`).then((res) => { entries = res.items ?? []; loaded = true; show(); }, (err) => {
    empty.textContent = err instanceof ApiError && err.status === 404 ? 'No guestbook here.' : 'Could not load the guestbook.';
    form.hidden = true;
  });
  form.hidden = true;
  section.refresh = () => { if (loaded) show(); };
  section.relabel = (l) => { forWhom.textContent = ` for ${l}`; };
  return section;
}
