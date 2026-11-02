// today.js — the home page (today.html): what needs you today, at a glance.
// Sections: overdue, due this week, needs attention (config.attention_statuses),
// finished in the last 7 days, and what Claude changed since your last visit.
// "Assigned to you" or "Everything you can see" is a toggle, remembered per
// browser (in try/catch). "Today" is the server's (GET /api/me `today`, in your
// time zone, else the site's), and the task lists ask the API with `due=`, so
// the browser and the API never disagree about what is overdue. Status and due
// date are edited in place (js/task-columns.js); every title links to its task.

import { boot, sayError, attempt } from './page.js';
import { get, patch, taskPath } from './api.js';
import { el, setChildren, timeEl, todayLocal } from './dom.js';
import { redraw, focusEditable } from './inline-edit.js';
import { taskColumns, columnsFor, taskCell, copyNote } from './task-columns.js';
import { describeActivity, viaBadge } from './activity-words.js';
import { commentWords } from './guestbook.js';

const { config, me } = await boot({ title: 'Today' });
const closed = config.closed_statuses?.task ?? [];
const open = config.statuses.task.filter((s) => !closed.includes(s));
const attention = (config.attention_statuses?.task ?? []).filter((s) => open.includes(s));
const canEdit = !!me.can_edit;
const words = commentWords(me.preferences.comments_label);
const SCOPE_KEY = `taskscape_today_scope:${me.id}`;
const SEEN_KEY = `taskscape_today_seen:${me.id}`;
/** Each section shows at most this many tasks, then says how many more there are. */
const SHOW = 50;

/** The scope: 'mine' (assigned to you) or 'all' (everything you can see). */
let scope = 'mine';
try { scope = localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'mine'; } catch { /* the default */ }
/** When this person last opened the page, for "changed by Claude since your last visit". */
let lastVisit = null;
try { lastVisit = localStorage.getItem(SEEN_KEY); } catch { /* every recent change is new */ }

const people = [{ id: me.id, name: me.name }];
/** @type {Map<string, any>} the latest record of every task on the page, by id */
const shown = new Map();
/** Each section has its own column context, so a task in two sections has two distinct edit keys. @param {string} sectionId */
function contextFor(sectionId) {
  return {
    config, me, mayEdit: () => canEdit, people: () => people, onUpdated: replaceTask, keyPrefix: `${sectionId}-`,
    save: async (t, fields) => {
      const rec = await attempt(() => patch(taskPath(t.id), { version: t.version, ...fields }), replaceTask);
      if (!rec) return null;
      replaceTask(rec);
      // every section is asked again, so a task closed from Overdue moves to Finished at once; focus comes back to
      // the same value when it is still in that section, else to the section's heading
      const key = `${sectionId}-task-${t.id}-${Object.keys(fields)[0] === 'due_date' ? 'due_date' : Object.keys(fields)[0]}`;
      queueMicrotask(async () => {
        await loadAll();
        if (document.querySelector(`.editable[data-field="${CSS.escape(key)}"]`)) focusEditable(key);
        else document.getElementById(`today-${sectionId}-h`)?.focus();
      });
      return { note: copyNote(t, rec) };
    },
  };
}
const contexts = new Map();
const ctxFor = (sectionId) => { if (!contexts.has(sectionId)) contexts.set(sectionId, contextFor(sectionId)); return contexts.get(sectionId); };
const map = taskColumns(ctxFor('any'));

/**
 * The sections. `query` adds to the scope's owner filter; `fields` are the columns; `empty` is the friendly empty state.
 * @type {Array<{id: string, title: string, query: () => object, fields: string[], empty: () => string, hidden?: boolean}>}
 */
const SECTIONS = [
  { id: 'overdue', title: 'Overdue', fields: ['title', 'due_date', 'status', 'project'],
    query: () => ({ due: 'overdue', sort: 'due_date', dir: 'asc' }),
    empty: () => (scope === 'mine' ? 'Nothing of yours is overdue. Nicely done.' : 'Nothing anyone can see here is overdue.') },
  { id: 'week', title: 'Due in the next 7 days', fields: ['title', 'due_date', 'status', 'project'],
    query: () => ({ due: 'week', status: open.join(','), sort: 'due_date', dir: 'asc' }),
    empty: () => (scope === 'mine' ? 'Nothing of yours is due this week.' : 'Nothing is due this week.') },
  { id: 'attention', title: 'Needs attention', fields: ['title', 'status', 'due_date', 'project'], hidden: attention.length === 0,
    query: () => ({ status: attention.join(','), sort: 'updated_at' }),
    empty: () => `Nothing is ${attention.join(' or ')}${scope === 'mine' ? ' on your plate' : ''}.` },
  { id: 'finished', title: 'Finished in the last 7 days', fields: ['title', 'status', 'project'],
    query: () => ({ status: closed.join(','), closed_since: weekAgo(), sort: 'updated_at' }),
    empty: () => (scope === 'mine' ? 'Nothing of yours was finished this week yet.' : 'Nothing was finished this week yet.') },
];

/** The first of the last seven days, today included (six days back), as a date (the API reads it as that day's start, UTC). */
function weekAgo() {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}

/** Bumped by every loadAll(), so only the latest load draws (a quick scope switch never shows the other scope). */
let generation = 0;

const host = document.getElementById('today-sections');
const claudeHost = document.getElementById('claude-changes');

function buildScope() {
  const group = document.getElementById('today-scope');
  const radio = (value, label) => {
    const input = el('input', { type: 'radio', name: 'scope', id: `scope-${value}`, value, checked: scope === value });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      scope = value;
      try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* lasts for this page */ }
      loadAll();
    });
    return el('label', { for: `scope-${value}` }, input, ' ', label);
  };
  setChildren(group, [el('legend', null, 'Show'), radio('mine', 'Assigned to you'), ' ', radio('all', 'Everything you can see')]);
}

/** Load every section; the dates come from the server's today. */
async function loadAll() {
  const mine = ++generation;
  document.getElementById('today-date').textContent = todayLocal();
  shown.clear();
  const owner = scope === 'mine' ? { owner: 'me' } : {};
  const parts = [];
  for (const s of SECTIONS.filter((x) => !x.hidden)) {
    const section = el('section', { id: `today-${s.id}`, class: 'today-section', 'aria-labelledby': `today-${s.id}-h` },
      el('h2', { id: `today-${s.id}-h`, tabindex: '-1' }, s.title), el('p', { class: 'muted' }, 'Loading…'));
    parts.push(section);
  }
  const loaded = await Promise.all(SECTIONS.filter((x) => !x.hidden).map((s) => get('/api/tasks', { ...owner, ...s.query(), limit: SHOW + 1 }).then((r) => r, (err) => err)));
  if (mine !== generation) return;
  setChildren(host, parts);
  await Promise.all(SECTIONS.filter((x) => !x.hidden).map(async (s, i) => {
    const section = document.getElementById(`today-${s.id}`);
    try {
      const res = loaded[i];
      if (res instanceof Error) throw res;
      const items = res.items ?? [];
      const heading = section.querySelector('h2');
      heading.textContent = `${s.title} (${items.length > SHOW ? `${SHOW}+` : items.length})`;
      if (!items.length) { setChildren(section, [heading, el('p', { class: 'empty-line' }, s.empty())]); return; }
      const cols = columnsFor(map, s.fields);
      const table = el('table', { class: 'today-table' },
        el('caption', { class: 'visually-hidden' }, s.title),
        el('thead', null, el('tr', null, cols.map((c) => el('th', { scope: 'col' }, c.label)))),
        el('tbody', null, items.slice(0, SHOW).map((t) => { shown.set(t.id, t); return row(cols, t, s.id); })));
      setChildren(section, [heading, el('div', { class: 'table-wrap' }, table),
        items.length > SHOW ? el('p', { class: 'muted' }, `Showing the first ${SHOW}. `, el('a', { href: 'mine.html' }, 'See all of your tasks')) : null]);
    } catch (err) { setChildren(section, [section.querySelector('h2'), el('p', { class: 'status error' }, 'Could not load this section.')]); sayError(err, `Could not load ${s.title.toLowerCase()}`); }
  }));
  await loadClaude(mine);
}

/** @param {any[]} cols @param {any} t @param {string} sectionId */
function row(cols, t, sectionId) {
  return el('tr', { id: `${sectionId}-${t.id}`, 'data-task': t.id },
    cols.map((c) => el('td', { class: `col-${c.key}`, 'data-label': c.label }, taskCell(c, t, ctxFor(sectionId)))));
}

/** Redraw every row of a task after a save or a 409 (a task can sit in two sections). @param {any} rec */
function replaceTask(rec) {
  shown.set(rec.id, rec);
  for (const tr of document.querySelectorAll(`tr[data-task="${CSS.escape(rec.id)}"]`)) {
    const sectionId = tr.id.slice(0, tr.id.length - rec.id.length - 1);
    const s = SECTIONS.find((x) => x.id === sectionId);
    if (!s) continue;
    const fresh = row(columnsFor(map, s.fields), rec, s.id);
    redraw(tr, [...fresh.children]);
  }
}

/** "Changed by Claude since your last visit": activity with via = mcp, newer than the last visit; yours or everyone's. */
async function loadClaude(mine) {
  const since = lastVisit;
  try {
    const query = { via: 'mcp', limit: 50, ...(scope === 'mine' ? { actor: me.id } : {}) };
    const all = (await get('/api/activity', query)).items ?? [];
    if (mine !== generation) return;
    const items = all.filter((a) => !since || a.created_at > since);
    // "last visit" is the newest entry seen, in the server's clock, and only once this section loaded
    if (all[0]?.created_at && (!newestSeen || all[0].created_at > newestSeen)) newestSeen = all[0].created_at;
    const heading = el('h2', { id: 'claude-h' }, `Changed by Claude since your last visit (${items.length >= 50 ? '50+' : items.length})`);
    if (!items.length) {
      setChildren(claudeHost, [heading, el('p', { class: 'empty-line' }, since
        ? 'Claude has not changed anything since you last looked.'
        : 'Nothing yet. When Claude changes something through its tools, it shows up here.')]);
    } else {
      setChildren(claudeHost, [heading, el('ol', { class: 'activity-list' }, items.map((a) => {
        const d = describeActivity(a, { words });
        return el('li', null, timeEl(a.created_at), ' — ', el('b', null, a.actor_name), ' (', viaBadge(a.via), ') ', d.what, d.link ? [' ', d.link] : null);
      }))]);
    }
  } catch (err) { sayError(err, 'Could not load what Claude changed'); }
}

/** The newest Claude entry this visit showed (server time); it becomes "last visit" for next time. @type {string|null} */
let newestSeen = lastVisit;

buildScope();
await loadAll();
if (newestSeen && newestSeen !== lastVisit) { try { localStorage.setItem(SEEN_KEY, newestSeen); } catch { /* every recent change stays new */ } }
