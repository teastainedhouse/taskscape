// overdue.js — overdue is computed in the browser (docs/PLAN.md §2, rule 8):
// due_date before today's local date and status not in config.closed_statuses.task.
// The marquee is a CSS animation on a span; base.css stops it under reduced motion.

import { el, projectLink, setChildren, todayLocal } from './dom.js';
import { get } from './api.js';

/**
 * @param {{due_date: string|null, status: string}} task
 * @param {{closed_statuses: {task: string[]}}} config
 * @param {string} [today]
 */
export function isOverdue(task, config, today = todayLocal()) {
  if (!task.due_date) return false;
  const closed = config?.closed_statuses?.task ?? [];
  return task.due_date < today && !closed.includes(task.status);
}

/**
 * Fetch tasks due before today (the API filter is inclusive, so filter again) that are still open.
 * @param {any} config
 * @param {string} [projectId]  limit to one project
 */
export async function fetchOverdue(config, projectId) {
  const today = todayLocal();
  const res = await get('/api/tasks', { due_before: today, project: projectId, sort: 'due_date', dir: 'asc' });
  return (res.items ?? []).filter((t) => isOverdue(t, config, today));
}

/**
 * Render the marquee into `host` (emptied when nothing is overdue).
 * @param {HTMLElement} host
 * @param {Array<any>} tasks
 * @param {{showProject?: boolean}} [opts]
 */
export function renderMarquee(host, tasks, opts = {}) {
  if (!host) return;
  if (!tasks.length) { setChildren(host, []); host.hidden = true; return; }
  host.hidden = false;
  const parts = [el('span', { class: 'marquee__label' }, `*** ${tasks.length} OVERDUE ***`), ' '];
  tasks.forEach((t, i) => {
    if (i) parts.push(' • ');
    parts.push(projectLink(t.project_id, t.title, `task-${t.id}`));
    parts.push(` (due ${t.due_date}`);
    if (opts.showProject && t.project_name) parts.push(`, ${t.project_name}`);
    parts.push(')');
  });
  const track = el('span', { class: 'marquee__track' }, parts);
  setChildren(host, [el('div', { class: 'marquee', role: 'region', 'aria-label': 'Overdue tasks' }, track)]);
}
