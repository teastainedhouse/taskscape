// guestbook.js — the comments on a project or a task (docs/PLAN.md §8):
// oldest first, an "Add a comment" form for editors, and Trash or Restore on
// the viewer's own. Nobody edits a comment. A trashed comment shows only to
// its author, who restores it here; the Trash page does not list comments.
// Comment text is data, rendered as text only. The words come from
// commentWords(): "Comments" by default, "Guestbook" for those who prefer
// the old sign-the-guestbook flavour (a personal preference).

import { get, post, del, itemPath, ApiError } from './api.js';
import { el, btn, setChildren, timeEl } from './dom.js';
import { say, sayError, attempt } from './page.js';

/** Matches COMMENT_MAX in api/lib/validate.js. */
const MAX = 2000;

const commentPath = (id) => `/api/comments/${encodeURIComponent(id)}`;

/**
 * Every word the UI uses for comments, in one of the two flavours.
 * @param {'Comments'|'Guestbook'|string|undefined} label  the comments_label preference
 */
export function commentWords(label) {
  const gb = label === 'Guestbook';
  return {
    label: gb ? 'Guestbook' : 'Comments',
    one: gb ? 'guestbook entry' : 'comment',
    sign: gb ? 'Sign the guestbook' : 'Add a comment',
    button: gb ? 'Sign' : 'Comment',
    loading: gb ? 'Loading the guestbook…' : 'Loading comments…',
    none: gb ? 'No entries yet.' : 'No comments yet.',
    noneCanSign: gb ? 'No entries yet. Be the first to sign.' : 'No comments yet. Add the first one below.',
    noneHere: gb ? 'No guestbook here.' : 'No comments here.',
    loadFailed: gb ? 'Could not load the guestbook.' : 'Could not load the comments.',
    thanks: gb ? 'Thanks for signing the guestbook!' : 'Comment added.',
    signFailed: gb ? 'Could not sign the guestbook' : 'Could not add the comment',
    trashConfirm: gb ? 'Move your guestbook entry to the trash? You can restore it here.' : 'Move your comment to the trash? You can restore it here.',
    trashed: gb ? 'Guestbook entry moved to the trash.' : 'Comment moved to the trash.',
    restored: gb ? 'Guestbook entry restored.' : 'Comment restored.',
    trashLabel: gb ? 'Trash your guestbook entry' : 'Trash your comment',
    restoreLabel: gb ? 'Restore your guestbook entry' : 'Restore your comment',
    /** activity wording; `where` is 'task "Title"' or '(task no longer visible)' */
    signed: (where) => (gb ? `signed the guestbook of ${where}` : `commented on ${where}`),
    trashedOn: (where) => (gb ? `trashed a guestbook entry on ${where}` : `trashed a comment on ${where}`),
    restoredOn: (where) => (gb ? `restored a guestbook entry on ${where}` : `restored a comment on ${where}`),
    otherOn: (action, where) => (gb ? `${action} a guestbook entry on ${where}` : `${action} a comment on ${where}`),
  };
}

/**
 * A comments section. It loads on creation and keeps its draft for the life of the page.
 * @param {{type: 'project'|'task', id: string, label: string, heading: 'h2'|'h3', me: {id: string},
 *          canSign: () => boolean, words?: ReturnType<typeof commentWords>}} opts  label names the parent for screen readers
 * @returns {HTMLElement & {refresh: () => void}}  refresh() after canSign() may have changed
 */
export function guestbook({ type, id, label, heading, me, canSign, words = commentWords('Comments') }) {
  const headingId = `guestbook-${type}-${id}-h`;
  const list = el('ol', { class: 'guestbook-list' });
  const empty = el('p', { class: 'muted empty' }, words.loading);
  const textarea = el('textarea', { id: `guestbook-${type}-${id}-body`, rows: '3', maxlength: String(MAX), required: true });
  const form = el('form', { class: 'guestbook-sign' },
    el('label', { for: textarea.id }, words.sign), textarea, ' ', el('button', { type: 'submit' }, words.button));
  const forWhom = el('span', { class: 'visually-hidden' }, ` for ${label}`);
  const section = /** @type {HTMLElement & {refresh: () => void}} */ (el('section', { class: 'guestbook', 'aria-labelledby': headingId },
    el(heading, { id: headingId }, words.label, forWhom), empty, list, form));

  /** @type {any[]} */
  let entries = [];
  let sending = false;
  let loaded = false;

  const show = () => {
    setChildren(list, entries.map(entry));
    empty.hidden = entries.length > 0;
    empty.textContent = canSign() ? words.noneCanSign : words.none;
    form.hidden = !canSign();
  };

  /** @param {any} c */
  function entry(c) {
    const mine = c.author_id === me.id;
    const trashed = !!c.deleted_at;
    const body = el('p', { class: 'guestbook-body' }, c.body);
    const actions = [];
    // the author can always take an entry back; bringing one back needs an open guestbook and edit rights
    if (mine && !trashed) actions.push(btn('Trash', () => change(c, 'trash'), { 'aria-label': words.trashLabel }));
    if (mine && trashed && canSign()) actions.push(btn('Restore', () => change(c, 'restore'), { 'aria-label': words.restoreLabel }));
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
    if (action === 'trash' && !confirm(words.trashConfirm)) return;
    const rec = await attempt(() => (action === 'trash'
      ? del(commentPath(c.id), { version: c.version })
      : post(`${commentPath(c.id)}/restore`, { version: c.version })), put);
    if (rec) { put(rec); say(action === 'trash' ? words.trashed : words.restored); }
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
      say(words.thanks);
    } catch (err) { sayError(err, words.signFailed); } finally { sending = false; }
  });

  get(`${itemPath(type, id)}/comments`).then((res) => { entries = res.items ?? []; loaded = true; show(); }, (err) => {
    empty.textContent = err instanceof ApiError && err.status === 404 ? words.noneHere : words.loadFailed;
    form.hidden = true;
  });
  form.hidden = true;
  section.refresh = () => { if (loaded) show(); };
  return section;
}
