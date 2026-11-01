// mine.js — My tasks (mine.html): tasks assigned to me in every project I can
// see, each linked to its project. Overdue first (computed here, docs/PLAN.md
// §2 rule 8) under a static "N overdue" line, then by due date. Closed
// statuses are hidden unless "Show closed tasks" is ticked. "Load more" pages
// through the rest with the same query.

import { boot, sayError } from './page.js';
import { el, clear, setChildren, padlock, projectLink, tagChip, todayLocal } from './dom.js';
import { isOverdue, fetchOverdue } from './overdue.js';
import { createPager } from './pager.js';

const { config } = await boot({ title: 'My tasks' });
const closed = config.closed_statuses?.task ?? [];
const open = config.statuses.task.filter((s) => !closed.includes(s));

const tbody = document.querySelector('#mine tbody');
const empty = document.getElementById('mine-empty');
const line = document.getElementById('overdue-line');
const showClosed = document.getElementById('show-closed');

let shown = 0;
const pager = createPager({
  path: '/api/tasks',
  button: document.getElementById('mine-more'),
  query: () => {
    const query = { owner: 'me', sort: 'due_date', dir: 'asc' };
    if (!showClosed.checked && closed.length) query.status = open.join(',');
    return query;
  },
  onPage: (items, first) => {
    if (first) { clear(tbody); shown = 0; }
    // The list is by due date, so overdue tasks lead it; within each page they still go first.
    const today = todayLocal();
    const rows = [...items.filter((t) => isOverdue(t, config, today)).map((t) => row(t, true)),
      ...items.filter((t) => !isOverdue(t, config, today)).map((t) => row(t, false))];
    for (const r of rows) tbody.appendChild(r);
    shown += items.length;
    empty.hidden = shown > 0;
    return (rows[0] ?? tbody.lastElementChild)?.querySelector('a') ?? null;
  },
  onError: (err) => sayError(err, 'Could not load your tasks'),
});

showClosed.addEventListener('change', () => pager.reload());
await Promise.all([pager.reload(), countOverdue()]);

/** The static count comes from its own query, so it holds however many pages are loaded. */
async function countOverdue() {
  try {
    const { tasks, more } = await fetchOverdue(config, { owner: 'me' });
    line.classList.toggle('overdue-line--none', !tasks.length);
    setChildren(line, tasks.length ? el('b', null, `${tasks.length}${more ? '+' : ''} overdue`) : 'Nothing overdue.');
  } catch (err) { sayError(err, 'Could not check for overdue tasks'); }
}

/** @param {any} t @param {boolean} late */
function row(t, late) {
  return el('tr', { class: late ? 'overdue' : null },
    el('td', { class: 'col-due' }, t.due_date ?? '—', late ? ' (overdue)' : null),
    el('td', null, t.private ? padlock() : null, projectLink(t.project_id, t.title, `task-${t.id}`)),
    el('td', null, projectLink(t.project_id, t.project_name ?? 'project')),
    el('td', null, t.status),
    el('td', null, (t.tags ?? []).map((g) => tagChip(g))));
}
