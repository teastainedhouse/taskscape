// calendar.js — the month of due dates (calendar.html). A real table: a caption
// with the month, a header row of weekdays, and a button in every day that has
// tasks ("3 due, 1 overdue"), so Tab and Enter reach everything. Choosing a day
// lists its tasks below, each linked to its task page. Previous, Next and Today
// move the month (also in the URL, ?month=YYYY-MM). At phone width the grid
// gives way to a plain list of the days that have tasks. Overdue is said in
// words, by the server's rule (Me.today); "today" is marked in words too.

import { boot, sayError } from './page.js';
import { get } from './api.js';
import { el, btn, setChildren, taskLink, projectLink, padlock } from './dom.js';
import { isOverdue } from './overdue.js';
import { recurrenceMark } from './task-columns.js';

const { config, me } = await boot({ title: 'Calendar' });
const today = me.today ?? new Date().toISOString().slice(0, 10);
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const fmtMonth = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const pad = (n) => String(n).padStart(2, '0');

const params = new URLSearchParams(location.search);
let [year, month] = (/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month') ?? '') ? params.get('month') : today.slice(0, 7)).split('-').map(Number);
let onlyMine = false;
try { onlyMine = localStorage.getItem(`taskscape_calendar_mine:${me.id}`) === '1'; } catch { /* everything */ }
/** @type {Map<string, any[]>} tasks by due date, for the shown month */
let byDay = new Map();
let selected = null;

const grid = document.getElementById('cal-grid');
const list = document.getElementById('cal-list');
const dayHost = document.getElementById('cal-day');
const mine = document.getElementById('cal-mine');
mine.checked = onlyMine;
mine.addEventListener('change', () => {
  onlyMine = mine.checked;
  try { localStorage.setItem(`taskscape_calendar_mine:${me.id}`, onlyMine ? '1' : '0'); } catch { /* this page only */ }
  load();
});
document.getElementById('cal-prev').addEventListener('click', () => move(-1));
document.getElementById('cal-next').addEventListener('click', () => move(1));
document.getElementById('cal-today').addEventListener('click', () => { [year, month] = today.slice(0, 7).split('-').map(Number); selected = today; load(); });

/** @param {number} delta months */
function move(delta) {
  const t = year * 12 + (month - 1) + delta;
  year = Math.floor(t / 12); month = (t % 12) + 1;
  selected = null;
  load();
}

async function load() {
  const first = `${year}-${pad(month)}-01`;
  const last = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  history.replaceState(null, '', `?month=${year}-${pad(month)}`);
  document.getElementById('cal-title').textContent = fmtMonth(year, month);
  try {
    const res = await get('/api/tasks', { due_after: first, due_before: last, sort: 'due_date', dir: 'asc', limit: config.limits?.max_page_size, ...(onlyMine ? { owner: 'me' } : {}) });
    byDay = new Map();
    for (const t of res.items ?? []) { if (!byDay.has(t.due_date)) byDay.set(t.due_date, []); byDay.get(t.due_date).push(t); }
    renderGrid();
    renderList();
    renderDay(selected);
    const n = res.items?.length ?? 0;
    document.getElementById('cal-summary').textContent = n
      ? `${n}${n >= (res.limit ?? Infinity) ? '+' : ''} task${n === 1 ? '' : 's'} due in ${fmtMonth(year, month)}${onlyMine ? ', yours' : ''}.`
      : `Nothing is due in ${fmtMonth(year, month)}${onlyMine ? ' for you' : ''}. Give a task a due date and it shows up here.`;
  } catch (err) { sayError(err, 'Could not load the month'); }
}

/** "3 due, 1 overdue" for a day's tasks. @param {any[]} tasks */
function countWords(tasks) {
  const late = tasks.filter((t) => isOverdue(t, config, today)).length;
  return `${tasks.length} due${late ? `, ${late} overdue` : ''}`;
}

function renderGrid() {
  const firstDow = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = [];
  let cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(el('td', { class: 'cal-blank' }));
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${pad(month)}-${pad(d)}`;
    const tasks = byDay.get(date) ?? [];
    const late = tasks.some((t) => isOverdue(t, config, today));
    const label = el('span', { class: 'cal-num' }, String(d), date === today ? el('span', { class: 'cal-today-word' }, ' today') : null);
    const cell = el('td', { class: ['cal-day', date === today ? 'cal-day--today' : '', late ? 'cal-day--late' : '', date === selected ? 'cal-day--selected' : ''].join(' ').trim(), 'data-date': date },
      label, tasks.length ? el('br') : null,
      tasks.length ? btn(countWords(tasks), () => { selected = date; renderGrid(); renderDay(date, true); }, { class: 'cal-count', 'aria-label': `${fmtDay(date)}: ${countWords(tasks)}`, 'aria-pressed': String(date === selected) }) : null);
    cells.push(cell);
    if (cells.length === 7) { rows.push(el('tr', null, cells)); cells = []; }
  }
  if (cells.length) { while (cells.length < 7) cells.push(el('td', { class: 'cal-blank' })); rows.push(el('tr', null, cells)); }
  const focusedDate = document.activeElement?.closest?.('td.cal-day')?.dataset.date;
  setChildren(grid, [
    el('caption', { class: 'visually-hidden' }, `Due dates in ${fmtMonth(year, month)}. Days with tasks have a button that lists them.`),
    el('thead', null, el('tr', null, WEEKDAYS.map((w) => el('th', { scope: 'col', abbr: w }, el('span', { 'aria-hidden': 'true' }, w.slice(0, 3)), el('span', { class: 'visually-hidden' }, w))))),
    el('tbody', null, rows),
  ]);
  if (focusedDate) grid.querySelector(`td[data-date="${focusedDate}"] button`)?.focus();
}

/** The phone-width view: only the days that have tasks, in order, each with its tasks. */
function renderList() {
  const days = [...byDay.keys()].sort();
  setChildren(list, days.map((d) => el('li', null, el('h3', null, fmtDay(d), d === today ? ' (today)' : ''), taskItems(byDay.get(d)))));
}

/** @param {any[]} tasks */
function taskItems(tasks) {
  return el('ul', { class: 'cal-tasks' }, tasks.map((t) => el('li', null, t.private ? padlock() : null, taskLink(t.id, t.title), recurrenceMark(t),
    ` — ${t.status}`, isOverdue(t, config, today) ? el('b', { class: 'overdue-mark' }, ' (overdue)') : null,
    t.project_name ? [', ', projectLink(t.project_id, t.project_name)] : null)));
}

/** @param {string|null} date @param {boolean} [focus] */
function renderDay(date, focus = false) {
  if (!date || !byDay.has(date)) { setChildren(dayHost, []); dayHost.hidden = true; return; }
  dayHost.hidden = false;
  setChildren(dayHost, [el('h2', { id: 'cal-day-h', tabindex: '-1' }, `Due on ${fmtDay(date)}`), taskItems(byDay.get(date))]);
  if (focus) document.getElementById('cal-day-h').focus();
}

await load();
