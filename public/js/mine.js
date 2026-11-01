// mine.js — My tasks (mine.html): tasks assigned to me in every project I can
// see, each linked to its project. Overdue first (computed here, docs/PLAN.md
// §2 rule 8) under a static "N overdue" line, then by due date. Closed
// statuses are hidden unless "Show closed tasks" is ticked.

import { boot, sayError } from './page.js';
import { get } from './api.js';
import { el, clear, setChildren, padlock, projectLink, tagChip, todayLocal } from './dom.js';
import { isOverdue } from './overdue.js';

const { config } = await boot({ title: 'My tasks' });
const closed = config.closed_statuses?.task ?? [];
const open = config.statuses.task.filter((s) => !closed.includes(s));

const tbody = document.querySelector('#mine tbody');
const empty = document.getElementById('mine-empty');
const line = document.getElementById('overdue-line');
const showClosed = document.getElementById('show-closed');

showClosed.addEventListener('change', () => load());
await load();

async function load() {
  const query = { owner: 'me', sort: 'due_date', dir: 'asc' };
  if (!showClosed.checked && closed.length) query.status = open.join(',');
  let items;
  try { items = (await get('/api/tasks', query)).items ?? []; } catch (err) { sayError(err, 'Could not load your tasks'); return; }
  const today = todayLocal();
  const overdue = items.filter((t) => isOverdue(t, config, today));
  const rest = items.filter((t) => !isOverdue(t, config, today));
  clear(tbody);
  for (const t of overdue) tbody.appendChild(row(t, true));
  for (const t of rest) tbody.appendChild(row(t, false));
  empty.hidden = items.length > 0;
  line.classList.toggle('has-overdue', overdue.length > 0);
  setChildren(line, overdue.length ? `${overdue.length} overdue` : 'Nothing overdue.');
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
