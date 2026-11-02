// tasks.js — one project (project.html?id=…): a header whose values are
// edited by clicking them (js/inline-edit.js), privacy toggle, tags, export,
// duplicate, trash, hit counter, and the task table with sort, filter, add, and rows
// whose cells are edited in place the same way (one PATCH of one field).
// Titles link to the task page, where notes, comments, moving, and trashing
// live. The project's comments sit under the table (js/guestbook.js).
//
// Columns are data-driven: js/task-columns.js knows how to render each field
// and config.task_fields picks which ones show, in order ("add a field" recipe).

import { boot, say, sayError, attempt } from './page.js';
import { get, post, patch, del, projectPath, taskPath, ApiError } from './api.js';
import { el, btn, option, clear, setChildren, padlock, timeEl, oneLine } from './dom.js';
import { inlineEdit, selectFor, redraw } from './inline-edit.js';
import { refreshOverdue, isOverdue } from './overdue.js';
import { taskColumns, columnsFor, taskCell, copyNote } from './task-columns.js';
import { tagEditor } from './tags.js';
import { createPager } from './pager.js';
import { guestbook, commentWords } from './guestbook.js';

const { config, me } = await boot({ title: 'Project' });
// The counter and webring are decoration, loaded on their own: if a content
// blocker refuses the module, the page loses the counter, not everything.
const odometer = await import('./odometer.js').catch(() => null);
const projectId = new URLSearchParams(location.search).get('id');
const isCatchAll = projectId === config.catch_all_project_id;

const state = {
  /** @type {any} */ project: null,
  /** @type {any[]} */ tasks: [],
  /** @type {Array<{id: string, name: string}>} */ people: [],
  /** @type {string|null} */ catchAllName: null,
  sort: config.default_views?.tasks?.sort ?? 'updated_at',
  dir: config.default_views?.tasks?.dir ?? null,
  status: '', priority: '', owner: '', tag: '',
  hitDone: false,
};

/** True when the viewer may change things on this page. */
const mayEdit = () => !!me.can_edit && !state.project?.deleted_at;
/** The viewer owns the item (private flag and reassigning a private task are owner-only). */
const owns = (item) => item.owner_id === me.id;

const projectHost = document.getElementById('project');
const tasksSection = document.getElementById('tasks-section');
const table = document.getElementById('tasks');
const thead = table.querySelector('thead');
const tbody = table.querySelector('tbody');
const counterHost = el('span', { class: 'hit-host' });
/** @type {any} */ let projectBook = null;

async function start() {
  try {
    state.project = await get(projectPath(projectId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound(); else sayError(err, 'Could not load the project');
    return;
  }
  try { state.people = (await get('/api/people')).items ?? []; } catch { state.people = []; }
  // make sure the signed-in user and the project's owner are selectable even if /api/people omitted them
  for (const who of [{ id: me.id, name: me.name }, { id: state.project.owner_id, name: state.project.owner_name }]) {
    if (who.id && !state.people.some((p) => p.id === who.id)) state.people.push(who);
  }

  renderHeader();
  tasksSection.hidden = false;
  buildFilters();
  buildTaskHeader();
  setupNewTask();
  await loadTasks();
  projectBook = guestbook({ type: 'project', id: state.project.id, label: 'this project', heading: 'h2', me, canSign: mayEdit, words: commentWords(me.preferences.comments_label) });
  document.getElementById('project-guestbook').appendChild(projectBook);
  loadOverdue();
  recordHit();
  const bar = odometer?.buildWebringBar(config.webring);
  if (bar) { document.getElementById('webring').appendChild(bar); odometer.attachWebringEgg(counterHost, bar); }
}

function notFound() {
  document.title = `Not found - ${config.site_title || 'Taskscape'}`;
  setChildren(projectHost, [el('h1', null, 'Not found'), el('p', null, 'This project does not exist, or it is private to someone else. ', el('a', { href: 'projects.html' }, 'Back to the list'))]);
}

/* ------------------------------------------------------------------ header */

function renderHeader() {
  const p = state.project;
  document.title = `${p.name} - ${config.site_title || 'Taskscape'}`;
  const canEditProject = mayEdit();
  const owner = owns(p);

  const parts = [];
  if (p.deleted_at) {
    parts.push(el('div', { class: 'status error', role: 'alert' }, 'This project is in the trash (since ', timeEl(p.deleted_at), '). ',
      me.can_edit ? btn('Restore', restoreProject) : null));
  }

  parts.push(el('h1', { id: 'project-name' }, p.private ? padlock() : null,
    inlineEdit({ key: 'project-name', label: 'Project name', allowed: canEditProject, value: p.name,
      control: (v) => el('input', { type: 'text', value: v, required: true, maxlength: '200', size: '40' }),
      save: (v) => (v.trim() ? patchProject({ name: v.trim() }, p.version) : (say('A project needs a name.', { error: true }), null)) })));

  parts.push(el('p', { class: 'description' },
    inlineEdit({ key: 'project-description', label: 'Description', allowed: canEditProject, value: p.description ?? '', block: true,
      empty: canEditProject ? 'No description yet. Click to add one.' : 'No description.',
      control: (v) => el('textarea', { rows: '4', value: v }),
      save: (v) => patchProject({ description: v }, p.version) })));

  const meta = el('table', { class: 'meta' });
  const row = (label, ...cells) => meta.appendChild(el('tr', null, el('th', { scope: 'row' }, label), el('td', null, cells)));

  row('Status', inlineEdit({ key: 'project-status', label: 'Status', allowed: canEditProject, value: p.status,
    control: (v) => selectFor(config.statuses.project.map((s) => ({ value: s })), v),
    save: (v) => patchProject({ status: v }, p.version) }));

  row('Owner', inlineEdit({ key: 'project-owner', label: 'Owner', allowed: canEditProject && !isCatchAll, value: p.owner_id,
    format: (id) => personName(id),
    control: (v) => selectFor(state.people.map((x) => ({ value: x.id, label: x.name })), v),
    save: async (v) => {
      if (p.private && v !== p.owner_id && !confirm(`Hand this private project to ${oneLine(personName(v))}? Your tasks in it move to ${oneLine(await catchAllName())} and stay private to you, and the project will be private to its new owner.`)) return null;
      return patchProject({ owner_id: v, owner_name: personName(v) }, p.version);
    } }));

  const privacyCells = [p.private ? [padlock(), 'Private: only you can see this project'] : 'Public'];
  if (owner && canEditProject && !isCatchAll) {
    privacyCells.push(' ', btn(p.private ? 'Make public' : 'Make private', togglePrivacy, { class: 'privacy-toggle' }));
  }
  row('Privacy', privacyCells);

  row('Tags', tagEditor({ type: 'project', item: p, canEdit: canEditProject, config, onUpdated: (rec) => { state.project = rec; renderHeader(); } }));

  if (odometer && !counterHost.firstChild) counterHost.appendChild(odometer.renderHitCounter(p.hit_count, { isPrivate: p.private }));
  row('Visitors', counterHost, ' ', el('span', { class: 'hit-caption' }, 'You are visitor number ', el('span', { id: 'hit-number' }, String(p.hit_count ?? 0))));
  row('Updated', timeEl(p.updated_at));

  parts.push(el('div', { class: 'table-wrap' }, meta));

  const actions = el('p', { class: 'project-actions' },
    el('a', { href: `${projectPath(p.id)}/export.md`, class: 'button', download: '' }, 'Save as markdown'));
  if (canEditProject) {
    actions.append(' ', btn('Duplicate', () => duplicate.toggle(), { id: 'duplicate-open', 'aria-expanded': duplicate.isOpen() ? 'true' : 'false', 'aria-controls': 'duplicate-form' }));
  } else duplicate.close(false);
  if (canEditProject && !isCatchAll) actions.append(' ', btn('Trash this project', trashProject, { class: 'danger' }));
  parts.push(actions);

  redraw(projectHost, parts);
  projectBook?.refresh(); // trash and restore open or close it
}

/**
 * PATCH the project with the version its editor was opened on (an inline edit
 * passes the version it was drawn with; the privacy toggle passes the current
 * one), so a stale edit meets a 409 instead of overwriting; re-render on
 * success or 409.
 * @param {object} fields @param {number} version
 */
async function patchProject(fields, version) {
  const rec = await attempt(() => patch(projectPath(state.project.id), { version, ...fields }),
    (current) => { state.project = current; renderHeader(); });
  if (!rec) return null;
  const { moved_tasks, ...project } = rec;
  state.project = project;
  renderHeader();
  return rec;
}

/** Name of the catch-all project, fetched once. */
async function catchAllName() {
  if (state.catchAllName) return state.catchAllName;
  try { state.catchAllName = (await get(projectPath(config.catch_all_project_id))).name; } catch { state.catchAllName = config.catch_all_project_id; }
  return state.catchAllName;
}

async function togglePrivacy() {
  const p = state.project;
  if (p.private) {
    if (!confirm('Make this project public?\nEveryone will be able to see it, and its history in What\'s New becomes visible too.')) return;
    const rec = await patchProject({ private: false }, p.version);
    if (rec) say('This project is now public, including its history.');
  } else {
    const name = await catchAllName();
    if (!confirm(`Make this project private?\nOnly you will see it. Tasks owned by others will be moved to ${oneLine(name)}.`)) return;
    const rec = await patchProject({ private: true }, p.version);
    if (rec) {
      const n = Number(rec.moved_tasks ?? 0);
      say(`This project is now private. ${n} task${n === 1 ? '' : 's'} owned by others ${n === 1 ? 'was' : 'were'} moved to ${oneLine(name)}.`);
      await loadTasks();
      loadOverdue();
    }
  }
  projectHost.querySelector('button.privacy-toggle')?.focus();
}

async function trashProject() {
  const p = state.project;
  if (!confirm(`Move the project "${oneLine(p.name)}" to the trash?\nIts tasks go with it. You can restore it from the Trash page.`)) return;
  const rec = await attempt(() => del(projectPath(p.id), { version: p.version }), (current) => { state.project = current; renderHeader(); });
  if (rec) { location.href = 'trash.html'; }
}

async function restoreProject() {
  const p = state.project;
  const rec = await attempt(() => post(`${projectPath(p.id)}/restore`, { version: p.version }), (current) => { state.project = current; renderHeader(); });
  if (rec) { say('Project restored.'); location.reload(); }
}

/* --------------------------------------------------------------- duplicate */

/**
 * "Duplicate": a form under the header, built once (a header redraw keeps it and what was typed). The copy is made by
 * POST /api/projects/:id/duplicate, then the page goes to it.
 */
const duplicate = (() => {
  const host = document.getElementById('duplicate-host');
  const name = el('input', { type: 'text', id: 'dup-name', required: true, maxlength: '200', size: '40' });
  const reset = el('input', { type: 'checkbox', id: 'dup-reset', checked: true });
  const radio = (value, checked) => el('input', { type: 'radio', name: 'dup-dates', id: `dup-dates-${value}`, value, checked });
  const modes = { keep: radio('keep', true), shift: radio('shift', false), clear: radio('clear', false) };
  const days = el('input', { type: 'number', id: 'dup-days', min: '-3650', max: '3650', step: '1', value: '7', size: '6', disabled: true,
    'aria-label': 'Days to move them by (a negative number moves them earlier)' });
  const submit = el('button', { type: 'submit' }, 'Make the copy');
  const form = el('form', { id: 'duplicate-form', class: 'duplicate-form', hidden: true, 'aria-labelledby': 'dup-h' },
    el('h2', { id: 'dup-h', tabindex: '-1' }, 'Duplicate this project'),
    el('p', { class: 'muted' }, 'The copy is yours. It gets the tasks here that you can see, with their tags, links, checklists (unticked), priorities and repeats. Comments are never copied.'),
    el('div', { class: 'field' }, el('label', { for: 'dup-name' }, 'Name of the copy'), name),
    el('div', { class: 'field' }, el('label', null, reset,
      ` Reset statuses to "${config.default_status.project}" for the project and "${config.default_status.task}" for its tasks`)),
    el('fieldset', { class: 'field dup-dates' }, el('legend', null, 'Due dates'),
      el('label', { for: 'dup-dates-keep' }, modes.keep, ' Keep them'),
      el('span', { class: 'dup-shift' }, el('label', { for: 'dup-dates-shift' }, modes.shift, ' Move them by'), ' ', days, ' days'),
      el('label', { for: 'dup-dates-clear' }, modes.clear, ' Clear them')),
    el('p', null, submit, ' ', btn('Cancel', () => close(true))));
  for (const r of Object.values(modes)) r.addEventListener('change', () => { days.disabled = !modes.shift.checked; });
  host.appendChild(form);

  const isOpen = () => !form.hidden;
  /** The name the form opened with: sent as no name at all, so the server shortens a long one to fit. */
  let suggested = '';
  const sync = () => document.getElementById('duplicate-open')?.setAttribute('aria-expanded', isOpen() ? 'true' : 'false');
  function open() {
    name.value = suggested = `${state.project.name} (copy)`;
    form.hidden = false;
    sync();
    name.focus();
    name.select();
  }
  /** @param {boolean} refocus  give focus back to the Duplicate button */
  function close(refocus) {
    if (!isOpen()) return;
    form.hidden = true;
    sync();
    if (refocus) document.getElementById('duplicate-open')?.focus();
  }
  form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(true); } });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const mode = Object.entries(modes).find(([, r]) => r.checked)?.[0] ?? 'keep';
    const typed = name.value.trim();
    if (!typed) { say('The copy needs a name.', { error: true }); name.focus(); return; }
    const body = { reset_statuses: reset.checked, due_dates: mode };
    if (typed !== suggested.trim()) body.name = typed;
    if (mode === 'shift') {
      const n = Number(days.value);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 3650) { say('Move the dates by a whole number of days from -3650 to 3650, not 0.', { error: true }); days.focus(); return; }
      body.days = n;
    }
    submit.disabled = true; // one copy per press
    try {
      const res = await post(`${projectPath(state.project.id)}/duplicate`, body);
      say(`Copy made with ${res.tasks.length} task${res.tasks.length === 1 ? '' : 's'}. Opening it…`);
      location.href = `project.html?id=${encodeURIComponent(res.project.id)}`;
    } catch (err) {
      sayError(err, 'Could not duplicate the project');
      submit.disabled = false;
      submit.focus(); // it lost focus when it was disabled
    }
  });
  return { toggle: () => (isOpen() ? close(true) : open()), close, isOpen };
})();

/** POST /hit once after the project loaded; on failure keep the record's count. */
async function recordHit() {
  if (state.hitDone || state.project.deleted_at) return;
  state.hitDone = true;
  try {
    const res = await post(`${projectPath(state.project.id)}/hit`);
    const old = counterHost.querySelector('.hit-counter');
    if (old) odometer.updateHitCounter(old, res.hit_count);
    const n = document.getElementById('hit-number');
    if (n) n.textContent = String(res.hit_count);
    state.project.hit_count = res.hit_count;
  } catch { /* the counter already shows hit_count from the record */ }
}

/* ------------------------------------------------------------------- tasks */

// How each task field shows lives in js/task-columns.js (shared with My tasks); config.task_fields picks the columns here.
const columnContext = {
  config, me, mayEdit, people: () => state.people, project: () => state.project, onUpdated: replaceTask,
  save: async (t, fields) => {
    const rec = await patchTask(t, fields);
    const notes = [matchesFilters(rec ?? t) ? null : 'It no longer matches the filters and will leave the list on reload.', copyNote(t, rec)].filter(Boolean);
    return rec && { note: notes.join(' ') || null };
  },
};
const columns = columnsFor(taskColumns(columnContext), (config.task_fields ?? ['title', 'status', 'owner', 'due_date', 'tags', 'private'])
  .filter((f) => f !== 'priority' || (config.priorities ?? []).length > 0));

function peopleOptions(current) {
  const opts = state.people.map((p) => option(p.id, p.name, p.id === current));
  if (current && !state.people.some((p) => p.id === current)) opts.unshift(option(current, current, true));
  return opts;
}
function personName(id) { return state.people.find((p) => p.id === id)?.name ?? id; }

function buildFilters() {
  const host = document.getElementById('task-filters');
  const status = el('select', { id: 'tf-status' }, option('', 'Any status'), config.statuses.task.map((s) => option(s)));
  const hasPriorities = (config.priorities ?? []).length > 0;
  const priority = el('select', { id: 'tf-priority' }, option('', 'Any priority'), (config.priorities ?? []).map((p) => option(p)));
  const owner = el('select', { id: 'tf-owner' }, option('', 'Anyone'), option('me', 'Me'), state.people.filter((p) => p.id !== me.id).map((p) => option(p.id, p.name)));
  const tag = el('select', { id: 'tf-tag' }, option('', 'Any tag'));
  get('/api/tags').then((r) => { for (const t of r.items ?? []) tag.appendChild(option(t.name)); }).catch(() => {});
  setChildren(host, [
    el('div', { class: 'field' }, el('label', { for: 'tf-status' }, 'Status'), status),
    hasPriorities ? el('div', { class: 'field' }, el('label', { for: 'tf-priority' }, 'Priority'), priority) : null,
    el('div', { class: 'field' }, el('label', { for: 'tf-owner' }, 'Owner'), owner),
    el('div', { class: 'field' }, el('label', { for: 'tf-tag' }, 'Tag'), tag),
    el('div', { class: 'field' }, btn('Clear filters', () => { status.value = priority.value = owner.value = tag.value = ''; apply(); })),
  ]);
  const apply = () => { state.status = status.value; state.priority = priority.value; state.owner = owner.value; state.tag = tag.value; loadTasks(); };
  for (const s of [status, priority, owner, tag]) s.addEventListener('change', apply);
}

function buildTaskHeader() {
  const tr = el('tr');
  for (const c of columns) {
    const th = el('th', { scope: 'col' });
    if (c.sort) {
      const active = state.sort === c.sort;
      const dir = state.dir ?? defaultDir(c.sort);
      th.setAttribute('aria-sort', active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.appendChild(btn(`${c.label}${active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}`, () => {
        if (state.sort === c.sort) state.dir = dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = c.sort; state.dir = defaultDir(c.sort); }
        buildTaskHeader();
        loadTasks();
      }, { class: 'sort', 'aria-label': `Sort by ${c.label}` }));
    } else th.textContent = c.label;
    tr.appendChild(th);
  }
  setChildren(thead, [tr]);
}
/** The API's default direction per sort field. @param {string} field */
function defaultDir(field) { return ['title', 'name', 'due_date', 'priority'].includes(field) ? 'asc' : 'desc'; }

/** Pages of this project's tasks with the current sort and filters (created in start(), once the project is known). */
let taskPager = null;

/** Fetch the first page; "Load more" fetches the rest with the same query. */
async function loadTasks() {
  taskPager ??= createPager({
    path: '/api/tasks',
    button: document.getElementById('tasks-more'),
    query: () => ({
      project: state.project.id, status: state.status, priority: state.priority, owner: state.owner, tag: state.tag,
      sort: state.sort, dir: state.dir ?? undefined, include_trashed: state.project.deleted_at ? 'true' : undefined,
    }),
    onPage: (items, first) => {
      if (first) { state.tasks = items; renderTasks(); return null; }
      state.tasks.push(...items);
      for (const t of items) appendRow(t);
      // Focus goes to the first new row, or to the last row when the last page came back empty.
      const target = items[0] ?? state.tasks.at(-1);
      return target ? document.getElementById(`task-${target.id}`)?.querySelector('a, button, input, select') : null;
    },
    onError: (err) => sayError(err, 'Could not load tasks'),
  });
  await taskPager.reload();
}

function renderTasks() {
  clear(tbody);
  for (const t of state.tasks) appendRow(t);
  showEmpty();
}

/** The table, or the right empty-state message when there are no rows. */
function showEmpty() {
  const filtered = !!(state.status || state.priority || state.owner || state.tag);
  const none = state.tasks.length === 0;
  table.parentElement.hidden = none;
  document.getElementById('tasks-empty').hidden = !(none && filtered);
  document.getElementById('under-construction').hidden = !(none && !filtered);
  document.getElementById('under-construction-text').textContent = mayEdit()
    ? 'This project has no tasks yet. Add the first one below, or ask Claude to.'
    : state.project?.deleted_at ? 'This project is in the trash and has no tasks of its own.' : 'This project has no tasks yet.';
}

/** @param {any} t */
function appendRow(t) {
  tbody.appendChild(taskRow(t));
}

/** @param {any} t */
function taskRow(t) {
  // a row that stopped matching the filters stays, marked, until the list reloads
  const tr = el('tr', { id: `task-${t.id}`, class: [isOverdue(t, config) ? 'overdue' : '', matchesFilters(t) ? '' : 'filtered-out', t.deleted_at ? 'trashed' : ''].join(' ').trim() });
  for (const c of columns) tr.appendChild(el('td', { class: `col-${c.key}`, 'data-label': c.label }, taskCell(c, t, columnContext)));
  // a trashed project lists its tasks read-only; one trashed on its own says so
  if (t.deleted_at) tr.querySelector('td.col-title')?.append(' ', el('span', { class: 'muted' }, '(in the trash)'));
  return tr;
}

/**
 * Replace a task in state and its row in the table (used after saves and 409s).
 * @param {any} rec
 */
function replaceTask(rec) {
  const i = state.tasks.findIndex((x) => x.id === rec.id);
  // An edit can move a loaded row out of the loaded range (a new sort key, a filter it no longer
  // matches), which pulls an unseen row in. Stepping back one never skips it; if the row did not
  // move, the pager drops the repeat.
  if (i >= 0 && rec.version !== state.tasks[i].version) taskPager?.removed();
  if (i >= 0) state.tasks[i] = rec; else state.tasks.push(rec);
  const old = document.getElementById(`task-${rec.id}`);
  if (!old) { appendRow(rec); return; }
  const fresh = taskRow(rec);
  redraw(old, [...fresh.children]); // an open editor in another cell, and focus, survive
  old.className = fresh.className;
}

/** Whether a task still matches the table's filters (status, priority, owner, tag). @param {any} t */
function matchesFilters(t) {
  if (state.status && t.status !== state.status) return false;
  if (state.priority && t.priority !== state.priority) return false;
  if (state.owner && t.owner_id !== (state.owner === 'me' ? me.id : state.owner)) return false;
  if (state.tag && !(t.tags ?? []).some((g) => g.name === state.tag)) return false;
  return true;
}

/**
 * PATCH a task with the version its row was drawn with; the row is redrawn
 * from the response, or from `current` on a 409.
 * @param {any} t @param {object} fields
 */
async function patchTask(t, fields) {
  const rec = await attempt(() => patch(taskPath(t.id), { version: t.version, ...fields }), replaceTask);
  if (rec) { replaceTask(rec); loadOverdue(); }
  return rec;
}

/* -------------------------------------------------------------- add a task */

function setupNewTask() {
  const form = document.getElementById('new-task');
  if (!mayEdit()) { form.hidden = true; return; }
  const status = document.getElementById('nt-status');
  const owner = document.getElementById('nt-owner');
  setChildren(status, config.statuses.task.map((s) => option(s, s, s === config.default_status.task)));
  setChildren(owner, peopleOptions(me.id));
  const priority = document.getElementById('nt-priority');
  setChildren(priority, [option('', 'None', true), (config.priorities ?? []).map((p) => option(p))]);
  priority.closest('.field').hidden = (config.priorities ?? []).length === 0;
  document.getElementById('nt-private').checked = !!config.privacy?.default_private;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = document.getElementById('nt-title').value.trim();
    if (!title) return;
    const body = {
      project_id: state.project.id, title, status: status.value, priority: priority.value || null,
      owner_id: owner.value, owner_name: personName(owner.value),
      due_date: document.getElementById('nt-due').value || null,
      notes: document.getElementById('nt-notes').value,
      private: document.getElementById('nt-private').checked,
    };
    try {
      const t = await post('/api/tasks', body);
      form.reset();
      status.value = config.default_status.task;
      owner.value = me.id;
      say(`Task "${t.title}" added.`);
      await loadTasks();
      loadOverdue();
      document.getElementById(`task-${t.id}`)?.querySelector('a')?.focus();
    } catch (err) { sayError(err, 'Could not add the task'); }
  });
}

/* ------------------------------------------------------------------- misc */

async function loadOverdue() {
  try { await refreshOverdue(config, { project: state.project.id }); } catch (err) { sayError(err, 'Could not check for overdue tasks'); }
}

/* ------------------------------------------------------------------ start */
// Last, so every const above (columns, columnContext) is initialized first.
if (!projectId) {
  notFound();
} else {
  await start();
}
