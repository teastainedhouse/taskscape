// overdue.js — overdue is computed in the browser (docs/PLAN.md §2, rule 8):
// due_date before today's local date and status not in config.closed_statuses.task.
// The signal is a static line in the page (count plus links); the marquee in the
// toolbar repeats it as decoration only: plain text, hidden from assistive tech,
// a CSS animation that base.css stops under reduced motion, and a Stop button
// beside it for everyone else.

import { el, taskLink, setChildren, todayLocal } from './dom.js';
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
 * Fetch open tasks due before today (the API filter is inclusive, so filter again).
 * Asks for the open statuses only, so closed tasks cannot crowd the page out, and
 * takes the largest page; `more` says it came back full, so there may be more.
 * @param {any} config
 * @param {{project?: string, owner?: string}} [filters]  e.g. one project, or owner "me"
 * @returns {Promise<{tasks: any[], more: boolean}>}
 */
export async function fetchOverdue(config, filters = {}) {
  const today = todayLocal();
  const closed = config.closed_statuses?.task ?? [];
  const status = closed.length ? config.statuses.task.filter((s) => !closed.includes(s)).join(',') : undefined;
  const limit = config.limits?.max_page_size;
  const res = await get('/api/tasks', { ...filters, status, limit, due_before: today, sort: 'due_date', dir: 'asc' });
  const items = res.items ?? [];
  return { tasks: items.filter((t) => isOverdue(t, config, today)), more: items.length >= res.limit };
}

/** Bumped by every refreshOverdue(), so only the latest answer is drawn. */
let latest = 0;

/**
 * Fetch and show overdue tasks. When several refreshes overlap, only the
 * latest one draws; if it fails, the line says the check failed instead of
 * keeping an older list as if it were current.
 * @param {any} config
 * @param {{project?: string, owner?: string}} [filters]
 * @param {{showProject?: boolean}} [opts]
 */
export async function refreshOverdue(config, filters, opts) {
  const mine = ++latest;
  try {
    const found = await fetchOverdue(config, filters);
    if (mine === latest) showOverdue(found, opts);
  } catch (err) {
    if (mine !== latest) return;
    showOverdue({ tasks: [] });
    const line = document.getElementById('overdue-line');
    if (line) { line.hidden = false; line.classList.add('overdue-line--none'); setChildren(line, 'Could not check for overdue tasks.'); }
    throw err;
  }
}

/** How many overdue tasks the static line names before "and N more". */
const LINE_LIMIT = 10;

/**
 * Show overdue tasks: the static line in `#overdue-line` (the signal) and the
 * marquee in `#marquee` (decoration). Both are hidden when nothing is overdue.
 * @param {{tasks: Array<any>, more?: boolean}} overdue  from fetchOverdue()
 * @param {{showProject?: boolean}} [opts]
 */
export function showOverdue({ tasks, more = false }, opts = {}) {
  const o = { ...opts, plus: more ? '+' : '' };
  renderLine(document.getElementById('overdue-line'), tasks, o);
  renderMarquee(document.getElementById('marquee'), tasks, o);
}

/** "2 overdue: Fix broken GIFs (due 2026-10-30, Website refresh); …" with a link per task. */
function renderLine(host, tasks, o) {
  if (!host) return;
  host.hidden = tasks.length === 0;
  host.classList.remove('overdue-line--none');
  if (!tasks.length) { setChildren(host, []); return; }
  const parts = [el('b', null, `${tasks.length}${o.plus} overdue:`), ' '];
  tasks.slice(0, LINE_LIMIT).forEach((t, i) => {
    if (i) parts.push('; ');
    parts.push(taskLink(t.id, t.title), ` (due ${t.due_date}${o.showProject && t.project_name ? `, ${t.project_name}` : ''})`);
  });
  if (tasks.length > LINE_LIMIT) parts.push(`; and ${tasks.length - LINE_LIMIT}${o.plus} more`);
  setChildren(host, parts);
}

/** Whether the viewer stopped the ticker (a per-browser nicety; storage may be refused). */
function tickerStopped() {
  try { return localStorage.getItem('taskscape_ticker') === 'stopped'; } catch { return false; }
}

/**
 * The scrolling ticker: text only and aria-hidden, since the static line says it all,
 * plus a toolbar Stop / Play button so nobody has to watch it move.
 */
function renderMarquee(host, tasks, o) {
  if (!host) return;
  if (!tasks.length) { setChildren(host, []); host.hidden = true; return; }
  host.hidden = false;
  const words = tasks.map((t) => `${t.title} (due ${t.due_date}${o.showProject && t.project_name ? `, ${t.project_name}` : ''})`);
  const track = el('span', { class: 'marquee__track' },
    el('span', { class: 'marquee__label' }, `*** ${tasks.length}${o.plus} OVERDUE ***`), ' ', words.join(' • '));
  const ticker = el('div', { class: 'marquee', 'aria-hidden': 'true' }, track);
  const stop = el('button', { type: 'button', class: 'marquee__stop' });
  const set = (stopped) => {
    ticker.classList.toggle('marquee--stopped', stopped);
    stop.textContent = stopped ? 'Play' : 'Stop';
    stop.setAttribute('aria-label', stopped ? 'Play the overdue ticker' : 'Stop the overdue ticker');
  };
  stop.addEventListener('click', () => {
    const stopped = !ticker.classList.contains('marquee--stopped');
    set(stopped);
    try { localStorage.setItem('taskscape_ticker', stopped ? 'stopped' : 'moving'); } catch { /* the choice lasts for this page only */ }
  });
  set(tickerStopped());
  setChildren(host, [ticker, stop]);
}
