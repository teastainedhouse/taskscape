// task-links.js — the Links section of the task page: labelled web links on a
// task. Each link opens in a new tab with rel="noopener noreferrer", and its
// href goes through safeUrl() (http and https only here; the API refuses any
// other scheme too). Editors add, rename (click the label or the URL, as
// everywhere: js/inline-edit.js), move up or down, and remove (which trashes
// the link). Every change is one write with the task's version; the task
// comes back and the page redraws from it, or from `current` on a 409.

import { el, btn, safeUrl } from './dom.js';
import { inlineEdit } from './inline-edit.js';
import { say } from './page.js';

/** The URL as a link only when it is http or https; anything else shows as text. @param {string} url */
function webHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? safeUrl(url) : null;
  } catch { return null; }
}

/** How a link reads: its label, else the URL without the scheme. @param {{url: string, label: string|null}} l */
export function linkText(l) {
  return l.label || l.url.replace(/^https?:\/\//, '');
}

/**
 * An anchor for a task link, or plain text when the URL is not http(s). A labelled link also names its host
 * beside the label, so a label cannot pass a link off as going somewhere it does not.
 * @param {{url: string, label: string|null}} l
 * @returns {Array<HTMLElement>}
 */
export function linkAnchor(l) {
  const href = webHref(l.url);
  if (!href) return [el('span', null, linkText(l))];
  const a = el('a', { href, rel: 'noopener noreferrer', target: '_blank', class: 'task-link' }, linkText(l),
    el('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
  return l.label ? [a, el('span', { class: 'muted link-host' }, ` (${new URL(href).host})`)] : [a];
}

/** One link write at a time from this list, so a double press cannot send the same version twice. */
let busy = false;
/** @param {() => Promise<any>} fn */
async function once(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; }
}

/** Focus a control in a link's row after a redraw, else its other move button, else any button in it, else `fallback`. */
function focusAfter(linkId, selector, fallback) {
  const row = document.getElementById(`link-${linkId}`);
  const target = row?.querySelector(`${selector}:not([disabled])`) ?? row?.querySelector('[data-move]:not([disabled])') ?? row?.querySelector('button:not([disabled])');
  (target ?? document.getElementById(fallback))?.focus();
}

/**
 * The list of links (redrawn with the task).
 * @param {{task: any, canEdit: boolean, write: (method: string, path: string, body: object) => Promise<any>, taskPath: string}} opts
 *   `write` does one request through attempt() and redraws the page; it resolves with the task, or null
 * @returns {HTMLElement}
 */
export function linksList({ task, canEdit, write, taskPath }) {
  const list = task.links ?? [];
  if (!list.length) return el('p', { class: 'muted', id: 'links-empty' }, canEdit ? 'No links yet. Add one below: a document, a ticket, a page this task is about.' : 'No links.');
  const ol = el('ol', { class: 'task-links' });
  list.forEach((l, i) => {
    const li = el('li', { id: `link-${l.id}` }, linkAnchor(l));
    if (canEdit) {
      const path = `${taskPath}/links/${encodeURIComponent(l.id)}`;
      const move = (to, dir) => once(async () => { if (await write('PATCH', path, { version: task.version, position: to })) focusAfter(l.id, `[data-move="${dir}"]`, 'new-link-url'); });
      li.append(el('div', { class: 'link-edit' },
        el('span', { class: 'muted' }, 'Label: '),
        inlineEdit({ key: `link-${l.id}-label`, label: 'Link label', allowed: true, value: l.label ?? '', empty: 'none',
          control: (v) => el('input', { type: 'text', value: v, maxlength: '200', size: '24' }),
          save: (v) => write('PATCH', path, { version: task.version, label: v.trim() || null }) }),
        el('br'), el('span', { class: 'muted' }, 'URL: '),
        inlineEdit({ key: `link-${l.id}-url`, label: 'Link URL', allowed: true, value: l.url,
          control: (v) => el('input', { type: 'url', value: v, maxlength: '2000', size: '32', required: true }),
          save: (v) => (v.trim() ? write('PATCH', path, { version: task.version, url: v.trim() }) : (say('A link needs a URL.', { error: true }), null)) }),
        ' ', el('span', { class: 'row-actions' },
          btn('Move up', () => move(i - 1, 'up'), { 'aria-label': `Move link ${linkText(l)} up`, disabled: i === 0, 'data-move': 'up' }),
          ' ', btn('Move down', () => move(i + 1, 'down'), { 'aria-label': `Move link ${linkText(l)} down`, disabled: i === list.length - 1, 'data-move': 'down' }),
          ' ', btn('Remove', () => once(async () => {
            const next = list[i + 1] ?? list[i - 1];
            if (await write('DELETE', path, { version: task.version })) {
              say(`Link ${linkText(l)} removed.`);
              if (next) focusAfter(next.id, 'a', 'new-link-url'); else document.getElementById('new-link-url')?.focus();
            }
          }), { 'aria-label': `Remove link ${linkText(l)}` }))));
    }
    ol.append(li);
  });
  return ol;
}

/**
 * The "Add a link" form, built once so a half-typed URL survives the page's redraws.
 * @param {{write: (method: string, path: string, body: object) => Promise<any>, taskPath: string, version: () => number}} opts
 */
export function linkForm({ write, taskPath, version }) {
  const url = el('input', { type: 'url', id: 'new-link-url', required: true, maxlength: '2000', size: '32', placeholder: 'https://' });
  const label = el('input', { type: 'text', id: 'new-link-label', maxlength: '200', size: '24' });
  const form = el('form', { class: 'new-link filters', 'aria-label': 'Add a link' },
    el('div', { class: 'field' }, el('label', { for: 'new-link-url' }, 'URL'), url),
    el('div', { class: 'field' }, el('label', { for: 'new-link-label' }, 'Label (optional)'), label),
    el('div', { class: 'field' }, el('button', { type: 'submit' }, 'Add link')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const rec = await write('POST', `${taskPath}/links`, { version: version(), url: url.value.trim(), label: label.value.trim() || null });
    if (rec) { form.reset(); say('Link added.'); url.focus(); }
  });
  return form;
}
