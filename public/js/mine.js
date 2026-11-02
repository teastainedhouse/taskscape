// mine.js — My tasks (mine.html): tasks assigned to me in every project I can
// see, each linked to its task page. Overdue first (computed here, docs/PLAN.md
// §2 rule 8) under a static "N overdue" line, then by due date. Closed
// statuses are hidden unless "Show closed tasks" is ticked. Status, due date
// and tags are edited in place (js/inline-edit.js, js/tags.js): marking
// things done from here is the main solo workflow. A row whose status just
// closed stays, marked, until the list reloads. "Load more" pages through
// the rest with the same query.

import { boot, sayError, attempt } from './page.js';
import { patch, taskPath } from './api.js';
import { el, clear, setChildren, padlock, projectLink, taskLink, todayLocal } from './dom.js';
import { inlineEdit, selectFor, redraw } from './inline-edit.js';
import { tagEditor } from './tags.js';
import { isOverdue, fetchOverdue } from './overdue.js';
import { createPager } from './pager.js';

const { config, me } = await boot({ title: 'My tasks' });
const closed = config.closed_statuses?.task ?? [];
const open = config.statuses.task.filter((s) => !closed.includes(s));
const canEdit = !!me.can_edit;

const tbody = document.querySelector('#mine tbody');
const empty = document.getElementById('mine-empty');
const line = document.getElementById('overdue-line');
const showClosed = document.getElementById('show-closed');

/** @type {any[]} */ let tasks = [];
const pager = createPager({
  path: '/api/tasks',
  button: document.getElementById('mine-more'),
  query: () => {
    const query = { owner: 'me', sort: 'due_date', dir: 'asc' };
    if (!showClosed.checked && closed.length) query.status = open.join(',');
    return query;
  },
  onPage: (items, first) => {
    if (first) { clear(tbody); tasks = []; }
    tasks.push(...items);
    // The list is by due date, so overdue tasks lead it; within each page they still go first.
    const today = todayLocal();
    const rows = [...items.filter((t) => isOverdue(t, config, today)), ...items.filter((t) => !isOverdue(t, config, today))].map(row);
    for (const r of rows) tbody.appendChild(r);
    empty.hidden = tasks.length > 0;
    if (!tasks.length && showClosed.checked) empty.querySelector('p').textContent = 'Nothing on your plate, open or closed. Tasks assigned to you in any project you can see show up here.';
    else if (!tasks.length) empty.querySelector('p').textContent = 'Nothing on your plate. Tasks assigned to you in any project you can see show up here, overdue first; tick "Show closed tasks" to see finished ones.';
    return (rows[0] ?? tbody.lastElementChild)?.querySelector('a') ?? null;
  },
  onError: (err) => sayError(err, 'Could not load your tasks'),
});

showClosed.addEventListener('change', () => pager.reload());
await Promise.all([pager.reload(), countOverdue()]);

/** The static count comes from its own query, so it holds however many pages are loaded. */
async function countOverdue() {
  try {
    const { tasks: late, more } = await fetchOverdue(config, { owner: 'me' });
    line.classList.toggle('overdue-line--none', !late.length);
    setChildren(line, late.length ? el('b', null, `${late.length}${more ? '+' : ''} overdue`) : 'Nothing overdue.');
  } catch (err) { sayError(err, 'Could not check for overdue tasks'); }
}

/** @param {any} t */
function row(t) {
  const late = isOverdue(t, config);
  const tr = el('tr', { id: `task-${t.id}`, class: late ? 'overdue' : null },
    el('td', { class: 'col-due' }, inlineEdit({ key: `task-${t.id}-due`, label: 'Due date', allowed: canEdit, value: t.due_date, empty: '—',
      control: (v) => el('input', { type: 'date', value: v ?? '' }),
      save: (v) => patchTask(t, { due_date: v || null }) }), late ? ' (overdue)' : null),
    el('td', { class: 'col-title' }, t.private ? padlock() : null, taskLink(t.id, t.title)),
    el('td', null, projectLink(t.project_id, t.project_name ?? 'project')),
    el('td', { class: 'col-status' }, inlineEdit({ key: `task-${t.id}-status`, label: 'Status', allowed: canEdit, value: t.status,
      control: (v) => selectFor(config.statuses.task.map((s) => ({ value: s })), v),
      save: (v) => patchTask(t, { status: v }) })),
    el('td', null, tagEditor({ type: 'task', item: t, canEdit, compact: true, config, onUpdated: replaceTask })));
  if (!showClosed.checked && closed.includes(t.status)) tr.classList.add('filtered-out');
  return tr;
}

/**
 * PATCH with the version the row was drawn with; the row is redrawn from the
 * response, or from the current record on a 409. A task that just closed
 * stays in the list, marked, until the next reload, so it never vanishes
 * from under the cursor; the announcement says so.
 * @param {any} t @param {object} fields
 */
async function patchTask(t, fields) {
  const rec = await attempt(() => patch(taskPath(t.id), { version: t.version, ...fields }), replaceTask);
  if (!rec) return null;
  replaceTask(rec);
  countOverdue();
  const closedNow = !showClosed.checked && closed.includes(rec.status) && !closed.includes(t.status);
  return { note: closedNow ? 'Closed tasks are hidden here, so it leaves the list on reload.' : null };
}

/** @param {any} rec */
function replaceTask(rec) {
  const i = tasks.findIndex((x) => x.id === rec.id);
  // A changed due date can move the row past the loaded range; stepping the pager back never skips a row.
  if (i >= 0 && rec.version !== tasks[i].version) pager.removed();
  if (i >= 0) tasks[i] = rec; else tasks.push(rec);
  const old = document.getElementById(`task-${rec.id}`);
  if (!old) { tbody.appendChild(row(rec)); return; }
  const fresh = row(rec);
  redraw(old, [...fresh.children]); // an open editor in another cell, and focus, survive
  old.className = fresh.className;
}
