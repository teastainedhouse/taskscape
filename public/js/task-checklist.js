// task-checklist.js — the Checklist section of the task page (and checklistProgress() for the lists): lightweight
// subtasks. Editors tick and untick (a real checkbox, labelled by the item),
// rename (click the text, as everywhere: js/inline-edit.js), move up or down,
// and remove (which trashes the item); the add form is built once, so a
// half-typed item survives the page's redraws. Every change is one write with
// the task's version; the task comes back and the page redraws from it, or
// from `current` on a 409. Text only, through dom.js.

import { el, btn } from './dom.js';
import { inlineEdit } from './inline-edit.js';
import { say } from './page.js';

/** "3/5" for a task's checklist, or null when it has none. @param {any} t */
export function checklistProgress(t) {
  const list = t.checklist ?? [];
  if (!list.length) return null;
  return `${list.filter((x) => x.done).length}/${list.length}`;
}

/** One checklist write at a time, so a double press cannot send the same version twice. */
let busy = false;
/** @param {() => Promise<any>} fn */
async function once(fn) {
  if (busy) return false;
  busy = true;
  try { await fn(); } finally { busy = false; }
  return true;
}

/** Focus a control in an item's row after a redraw, else its other move button, else any button, else `fallback`. */
function focusAfter(itemId, selector, fallback) {
  const row = document.getElementById(`check-${itemId}`);
  const target = row?.querySelector(`${selector}:not([disabled])`) ?? row?.querySelector('[data-move]:not([disabled])') ?? row?.querySelector('button:not([disabled])');
  (target ?? document.getElementById(fallback))?.focus();
}

/**
 * The checklist (redrawn with the task).
 * @param {{task: any, canEdit: boolean, write: (method: string, path: string, body: object) => Promise<any>, taskPath: string}} opts
 * @returns {HTMLElement[]}
 */
export function checklistList({ task, canEdit, write, taskPath }) {
  const list = task.checklist ?? [];
  if (!list.length) return [el('p', { class: 'muted', id: 'checklist-empty' }, canEdit ? 'No checklist yet. Add the steps below, and tick them off as they get done.' : 'No checklist.')];
  const done = list.filter((x) => x.done).length;
  const ol = el('ol', { class: 'checklist' });
  list.forEach((item, i) => {
    const path = `${taskPath}/checklist/${encodeURIComponent(item.id)}`;
    const box = el('input', { type: 'checkbox', id: `check-box-${item.id}`, checked: item.done, disabled: !canEdit });
    box.addEventListener('change', async () => {
      // another checklist write is still on its way: put the box back, so it never shows a tick that was not saved
      if (!(await once(async () => {
      const ticked = box.checked;
      const rec = await write('PATCH', path, { version: task.version, done: ticked });
      if (rec) { say(`${ticked ? 'Ticked' : 'Unticked'}: ${item.text}.`); document.getElementById(`check-box-${item.id}`)?.focus(); }
      else box.checked = item.done;
      }))) { box.checked = item.done; say('Wait for the last change to save, then try again.'); }
    });
    const li = el('li', { id: `check-${item.id}`, class: item.done ? 'checklist__item checklist__item--done' : 'checklist__item' },
      box, ' ',
      el('label', { for: `check-box-${item.id}`, class: 'visually-hidden' }, item.text), // the checkbox itself says ticked or not
      inlineEdit({ key: `check-${item.id}-text`, label: 'Checklist item', allowed: canEdit, value: item.text,
        control: (v) => el('input', { type: 'text', value: v, maxlength: '500', size: '32', required: true }),
        save: (v) => (v.trim() ? write('PATCH', path, { version: task.version, text: v.trim() }) : (say('An item needs some text.', { error: true }), null)) }));
    if (canEdit) {
      const move = (to, dir) => once(async () => {
        if (await write('PATCH', path, { version: task.version, position: to })) { say(`Moved "${item.text}" ${dir} to ${to + 1} of ${list.length}.`); focusAfter(item.id, `[data-move="${dir}"]`, 'new-check-text'); }
      });
      li.append(' ', el('span', { class: 'row-actions' },
        btn('Move up', () => move(i - 1, 'up'), { 'aria-label': `Move "${item.text}" up`, disabled: i === 0, 'data-move': 'up' }),
        ' ', btn('Move down', () => move(i + 1, 'down'), { 'aria-label': `Move "${item.text}" down`, disabled: i === list.length - 1, 'data-move': 'down' }),
        ' ', btn('Remove', () => once(async () => {
          const next = list[i + 1] ?? list[i - 1];
          if (await write('DELETE', path, { version: task.version })) {
            say(`Removed: ${item.text}.`);
            if (next) focusAfter(next.id, 'input', 'new-check-text'); else document.getElementById('new-check-text')?.focus();
          }
        }), { 'aria-label': `Remove "${item.text}"` })));
    }
    ol.append(li);
  });
  return [el('p', { class: 'checklist-progress' }, `${done} of ${list.length} done`), ol];
}

/**
 * The "Add an item" form, built once.
 * @param {{write: (method: string, path: string, body: object) => Promise<any>, taskPath: string, version: () => number}} opts
 */
export function checklistForm({ write, taskPath, version }) {
  const text = el('input', { type: 'text', id: 'new-check-text', required: true, maxlength: '500', size: '32' });
  const form = el('form', { class: 'new-check filters', 'aria-label': 'Add a checklist item' },
    el('div', { class: 'field' }, el('label', { for: 'new-check-text' }, 'New item'), text),
    el('div', { class: 'field' }, el('button', { type: 'submit' }, 'Add item')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!text.value.trim()) { say('An item needs some text.', { error: true }); return; }
    await once(async () => {
      const rec = await write('POST', `${taskPath}/checklist`, { version: version(), text: text.value.trim() });
      if (rec) { form.reset(); say('Item added.'); text.focus(); }
    });
  });
  return form;
}
