// tasks.js — one project (project.html?id=…): a header whose values are
// edited by clicking them (js/inline-edit.js), privacy toggle, tags, export,
// trash, hit counter, and the task table with sort, filter, add, and rows
// whose cells are edited in place the same way (one PATCH of one field).
// Titles link to the task page, where notes, comments, moving, and trashing
// live. The project's comments sit under the table (js/guestbook.js).
//
// Columns are data-driven: TASK_COLUMNS knows how to render each field and
// config.task_fields picks which ones show, in order ("add a field" recipe).

import { boot, say, sayError, attempt } from './page.js';
import { get, post, patch, del, projectPath, taskPath, ApiError } from './api.js';
import { el, btn, option, clear, setChildren, padlock, projectLink, taskLink, timeEl, oneLine } from './dom.js';
import { inlineEdit, selectFor, redraw } from './inline-edit.js';
import { refreshOverdue, isOverdue } from './overdue.js';
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
  status: '', owner: '', tag: '',
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
  setChildren(projectHost, [el('h1', null, 'Not found'), el('p', null, 'This project does not exist, or it is private to someone else. ', el('a', { href: 'index.html' }, 'Back to the list'))]);
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
      if (p.private && v !== p.owner_id && !confirm(`Hand this private project to ${personName(v)}? Your tasks in it move to ${await catchAllName()} and stay private to you, and the project will be private to its new owner.`)) return null;
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
    if (!confirm(`Make this project private?\nOnly you will see it. Tasks owned by others will be moved to ${name}.`)) return;
    const rec = await patchProject({ private: true }, p.version);
    if (rec) {
      const n = Number(rec.moved_tasks ?? 0);
      say(`This project is now private. ${n} task${n === 1 ? '' : 's'} owned by others ${n === 1 ? 'was' : 'were'} moved to ${name}.`);
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

/**
 * How each task field shows. A column with `view(t)` is read-only. A column
 * with `value(t)` and `control(t, v)` is edited in place: clicking the cell
 * opens the control, and a change becomes one PATCH of `fields(t, v)` with the
 * row's version. `allowed(t)` can keep the editor from a viewer who may not
 * change that field (the owner-only ones); `format(v)` draws the value;
 * `confirm(t, v)` may ask first. `sort` is the API sort field (or absent).
 */
const TASK_COLUMNS = {
  title: { label: 'Title', sort: 'title', view: (t) => [t.private ? padlock() : null, taskLink(t.id, t.title)] },
  status: { label: 'Status', sort: 'status', value: (t) => t.status,
    control: (t, v) => selectFor(config.statuses.task.map((s) => ({ value: s })), v),
    fields: (t, v) => ({ status: v }) },
  owner: { label: 'Owner', sort: 'owner_name', value: (t) => t.owner_id, allowed: (t) => !t.private || owns(t),
    format: (id, t) => (id === t.owner_id ? t.owner_name : personName(id)),
    control: (t, v) => selectFor(state.people.map((p) => ({ value: p.id, label: p.name })), v, { missing: t.owner_name }),
    fields: (t, v) => ({ owner_id: v, owner_name: personName(v) }) },
  due_date: { label: 'Due', sort: 'due_date', value: (t) => t.due_date, empty: '—',
    control: (t, v) => el('input', { type: 'date', value: v ?? '' }),
    fields: (t, v) => ({ due_date: v || null }) },
  // Tag chips save on their own (each attach or detach is its own versioned write).
  tags: { label: 'Tags', view: (t) => tagEditor({ type: 'task', item: t, canEdit: mayEdit(), compact: true, config, onUpdated: replaceTask }) },
  private: { label: 'Private', value: (t) => !!t.private, allowed: (t) => owns(t),
    format: (v) => (v ? [padlock(), 'yes'] : 'no'),
    control: (t, v) => el('input', { type: 'checkbox', checked: v }),
    confirm: (t, v) => v || confirm('Make this task public?\nEveryone will see it, and its history becomes visible too.'),
    fields: (t, v) => ({ private: v }) },
  notes: { label: 'Notes', value: (t) => t.notes ?? '', block: true, empty: 'add notes',
    control: (t, v) => el('textarea', { rows: '3', value: v }),
    fields: (t, v) => ({ notes: v }) },
  project: { label: 'Project', view: (t) => projectLink(t.project_id, t.project_name) },
  created_at: { label: 'Created', sort: 'created_at', view: (t) => timeEl(t.created_at) },
  updated_at: { label: 'Updated', sort: 'updated_at', view: (t) => timeEl(t.updated_at) },
};
const columns = (config.task_fields ?? ['title', 'status', 'owner', 'due_date', 'tags', 'private'])
  .map((f) => ({ key: f, ...(TASK_COLUMNS[f] ?? { label: f, view: (t) => String(t[f] ?? '') }) }));

function peopleOptions(current) {
  const opts = state.people.map((p) => option(p.id, p.name, p.id === current));
  if (current && !state.people.some((p) => p.id === current)) opts.unshift(option(current, current, true));
  return opts;
}
function personName(id) { return state.people.find((p) => p.id === id)?.name ?? id; }

function buildFilters() {
  const host = document.getElementById('task-filters');
  const status = el('select', { id: 'tf-status' }, option('', 'Any status'), config.statuses.task.map((s) => option(s)));
  const owner = el('select', { id: 'tf-owner' }, option('', 'Anyone'), option('me', 'Me'), state.people.filter((p) => p.id !== me.id).map((p) => option(p.id, p.name)));
  const tag = el('select', { id: 'tf-tag' }, option('', 'Any tag'));
  get('/api/tags').then((r) => { for (const t of r.items ?? []) tag.appendChild(option(t.name)); }).catch(() => {});
  setChildren(host, [
    el('div', { class: 'field' }, el('label', { for: 'tf-status' }, 'Status'), status),
    el('div', { class: 'field' }, el('label', { for: 'tf-owner' }, 'Owner'), owner),
    el('div', { class: 'field' }, el('label', { for: 'tf-tag' }, 'Tag'), tag),
    el('div', { class: 'field' }, btn('Clear filters', () => { status.value = owner.value = tag.value = ''; apply(); })),
  ]);
  const apply = () => { state.status = status.value; state.owner = owner.value; state.tag = tag.value; loadTasks(); };
  for (const s of [status, owner, tag]) s.addEventListener('change', apply);
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
function defaultDir(field) { return ['title', 'name', 'due_date'].includes(field) ? 'asc' : 'desc'; }

/** Pages of this project's tasks with the current sort and filters (created in start(), once the project is known). */
let taskPager = null;

/** Fetch the first page; "Load more" fetches the rest with the same query. */
async function loadTasks() {
  taskPager ??= createPager({
    path: '/api/tasks',
    button: document.getElementById('tasks-more'),
    query: () => ({
      project: state.project.id, status: state.status, owner: state.owner, tag: state.tag,
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
  const filtered = !!(state.status || state.owner || state.tag);
  const none = state.tasks.length === 0;
  table.parentElement.hidden = none;
  document.getElementById('tasks-empty').hidden = !(none && filtered);
  document.getElementById('under-construction').hidden = !(none && !filtered);
}

/** @param {any} t */
function appendRow(t) {
  tbody.appendChild(taskRow(t));
}

/** @param {any} t */
function taskRow(t) {
  // a row that stopped matching the filters stays, marked, until the list reloads
  const tr = el('tr', { id: `task-${t.id}`, class: [isOverdue(t, config) ? 'overdue' : '', matchesFilters(t) ? '' : 'filtered-out'].join(' ').trim() });
  for (const c of columns) tr.appendChild(el('td', { class: `col-${c.key}`, 'data-label': c.label }, cell(c, t)));
  return tr;
}

/**
 * One cell: the read-only view, or a click-to-edit value whose save is one
 * PATCH of that field with the row's version.
 * @param {any} c  a TASK_COLUMNS entry @param {any} t
 */
function cell(c, t) {
  if (!c.control) return c.view(t);
  return inlineEdit({
    key: `task-${t.id}-${c.key}`, label: c.label, value: c.value(t),
    allowed: mayEdit() && (c.allowed?.(t) ?? true),
    format: c.format ? (v) => c.format(v, t) : undefined, empty: c.empty, block: c.block,
    control: (v) => c.control(t, v),
    save: async (v) => {
      if (c.confirm && !c.confirm(t, v)) return null;
      const rec = await patchTask(t, c.fields(t, v));
      return rec && { note: matchesFilters(rec) ? null : 'It no longer matches the filters and will leave the list on reload.' };
    },
  });
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

/** Whether a task still matches the table's filters (status, owner, tag). @param {any} t */
function matchesFilters(t) {
  if (state.status && t.status !== state.status) return false;
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
  document.getElementById('nt-private').checked = !!config.privacy?.default_private;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = document.getElementById('nt-title').value.trim();
    if (!title) return;
    const body = {
      project_id: state.project.id, title, status: status.value,
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
// Last, so every const above (columns, TASK_COLUMNS) is initialized first.
if (!projectId) {
  notFound();
} else {
  await start();
}
