// tasks.js — one project (project.html?id=…): editable header, privacy
// toggle, tags, export, trash, hit counter, and the task table with sort,
// filter, inline edit, move, add, and trash.
//
// Columns are data-driven: TASK_COLUMNS knows how to render each field and
// config.task_fields picks which ones show, in order ("add a field" recipe).

import { boot, say, sayError, attempt } from './page.js';
import { get, post, patch, del, projectPath, taskPath, ApiError } from './api.js';
import { el, btn, option, clear, setChildren, padlock, projectLink, timeEl } from './dom.js';
import { refreshOverdue, isOverdue } from './overdue.js';
import { tagEditor } from './tags.js';
import { createPager } from './pager.js';

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
  /** @type {any[]|null} */ moveTargets: null,
  /** @type {string|null} */ catchAllName: null,
  sort: config.default_views?.tasks?.sort ?? 'updated_at',
  dir: config.default_views?.tasks?.dir ?? null,
  status: '', owner: '', tag: '',
  openNotes: new Set(),
  hitDone: false,
};

/** True when the viewer may change things on this page. */
const editing = () => !!me.can_edit && !state.project?.deleted_at;
/** The viewer owns the task (private flag and reassigning a private task are owner-only). */
const owns = (item) => item.owner_id === me.id;

const projectHost = document.getElementById('project');
const tasksSection = document.getElementById('tasks-section');
const table = document.getElementById('tasks');
const thead = table.querySelector('thead');
const tbody = table.querySelector('tbody');
const counterHost = el('span', { class: 'hit-host' });

async function start() {
  try {
    state.project = await get(projectPath(projectId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setChildren(projectHost, [el('h1', null, 'Not found'), el('p', null, 'This project does not exist, or it is private to someone else. ', el('a', { href: 'index.html' }, 'Back to the list'))]);
    } else sayError(err, 'Could not load the project');
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
  loadOverdue();
  recordHit();
  const bar = odometer?.buildWebringBar(config.webring);
  if (bar) { document.getElementById('webring').appendChild(bar); odometer.attachWebringEgg(counterHost, bar); }
  jumpToHash();
}

/* ------------------------------------------------------------------ header */

function renderHeader() {
  const p = state.project;
  document.title = `${p.name} - ${config.site_title || 'Taskscape'}`;
  const canEditProject = editing();
  const owner = owns(p);

  const parts = [];
  if (p.deleted_at) {
    parts.push(el('div', { class: 'status error', role: 'alert' }, 'This project is in the trash (since ', timeEl(p.deleted_at), '). ',
      me.can_edit ? btn('Restore', restoreProject) : null));
  }

  parts.push(el('h1', { id: 'project-name' }, p.private ? padlock() : null,
    editable({ value: p.name, label: 'Project name', allowed: canEditProject,
      control: () => el('input', { type: 'text', value: p.name, required: true, maxlength: '200', size: '40' }),
      save: (v) => patchProject({ name: v }, 'Name saved.') })));

  parts.push(el('p', { class: 'description' },
    editable({ value: p.description, label: 'Description', allowed: canEditProject, multiline: true, empty: '(no description)',
      control: () => el('textarea', { rows: '4', value: p.description ?? '' }),
      save: (v) => patchProject({ description: v }, 'Description saved.') })));

  const meta = el('table', { class: 'meta' });
  const row = (label, ...cells) => meta.appendChild(el('tr', null, el('th', { scope: 'row' }, label), el('td', null, cells)));

  row('Status', editable({ value: p.status, label: 'Status', allowed: canEditProject,
    control: () => el('select', null, statusOptions(config.statuses.project, p.status)),
    save: (v) => patchProject({ status: v }, 'Status saved.') }));

  row('Owner', editable({ value: p.owner_name, label: 'Owner', allowed: canEditProject && !isCatchAll,
    control: () => el('select', null, peopleOptions(p.owner_id)),
    save: (v) => patchProject({ owner_id: v, owner_name: personName(v) }, 'Owner saved.') }));

  const privacyCells = [p.private ? [padlock(), 'Private: only you can see this project'] : 'Public'];
  if (owner && canEditProject && !isCatchAll) {
    privacyCells.push(' ', btn(p.private ? 'Make public' : 'Make private', togglePrivacy));
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

  setChildren(projectHost, parts);
}

/**
 * A value with an Edit button that swaps to a small form.
 * @param {{value: any, label: string, allowed: boolean, control: () => HTMLElement, save: (v: string) => Promise<any>, multiline?: boolean, empty?: string}} spec
 */
function editable(spec) {
  const host = el('span', { class: 'editable' });
  show();
  return host;

  function show() {
    const display = el('span', { class: spec.value ? 'value' : 'value muted' }, spec.value || spec.empty || '');
    if (spec.multiline) display.style.whiteSpace = 'pre-wrap';
    setChildren(host, [display, spec.allowed ? [' ', btn('Edit', edit, { 'aria-label': `Edit ${spec.label.toLowerCase()}` })] : null]);
  }
  function edit() {
    const control = spec.control();
    control.setAttribute('aria-label', spec.label);
    const form = el('form', { class: 'inline-form' }, control, ' ', el('button', { type: 'submit' }, 'Save'), ' ', btn('Cancel', show));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = control.value;
      if (v === String(spec.value ?? '')) { show(); return; }
      await spec.save(v);
    });
    control.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') show(); });
    setChildren(host, [form]);
    control.focus();
  }
}

/**
 * PATCH the project with the version from the last read; re-render on success or 409.
 * @param {object} fields @param {string} [msg]
 */
async function patchProject(fields, msg) {
  const rec = await attempt(() => patch(projectPath(state.project.id), { version: state.project.version, ...fields }),
    (current) => { state.project = current; renderHeader(); });
  if (!rec) return null;
  const { moved_tasks, ...project } = rec;
  state.project = project;
  renderHeader();
  if (msg) say(msg);
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
    const rec = await patchProject({ private: false });
    if (rec) say('This project is now public, including its history.');
  } else {
    const name = await catchAllName();
    if (!confirm(`Make this project private?\nOnly you will see it. Tasks owned by others will be moved to ${name}.`)) return;
    const rec = await patchProject({ private: true });
    if (rec) {
      const n = Number(rec.moved_tasks ?? 0);
      say(`This project is now private. ${n} task${n === 1 ? '' : 's'} owned by others ${n === 1 ? 'was' : 'were'} moved to ${name}.`);
      await loadTasks();
      loadOverdue();
    }
  }
}

async function trashProject() {
  const p = state.project;
  if (!confirm(`Move the project "${p.name}" to the trash?\nIts tasks go with it. You can restore it from the Trash page.`)) return;
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
 * How each task field renders. `sort` is the API sort field (or absent).
 * `cell(t)` returns DOM for the cell; the Actions column is always added.
 */
const TASK_COLUMNS = {
  title: { label: 'Title', sort: 'title', cell: (t) => [t.private ? padlock() : null, editing() ? titleInput(t) : t.title] },
  status: { label: 'Status', sort: 'status', cell: (t) => (editing() ? select(t, 'status', statusOptions(config.statuses.task, t.status), (v) => ({ status: v })) : t.status) },
  owner: { label: 'Owner', sort: 'owner_name', cell: (t) => (editing() && (!t.private || owns(t)) ? select(t, 'owner', peopleOptions(t.owner_id), (v) => ({ owner_id: v, owner_name: personName(v) })) : t.owner_name) },
  due_date: { label: 'Due', sort: 'due_date', cell: (t) => (editing() ? dueInput(t) : (t.due_date ?? '')) },
  tags: { label: 'Tags', cell: (t) => tagEditor({ type: 'task', item: t, canEdit: editing(), compact: true, config, onUpdated: replaceTask }) },
  private: { label: 'Private', cell: privateCell },
  notes: { label: 'Notes', cell: (t) => notesEditor(t) },
  project: { label: 'Project', cell: (t) => projectLink(t.project_id, t.project_name) },
  created_at: { label: 'Created', sort: 'created_at', cell: (t) => timeEl(t.created_at) },
  updated_at: { label: 'Updated', sort: 'updated_at', cell: (t) => timeEl(t.updated_at) },
};
const columns = (config.task_fields ?? ['title', 'status', 'owner', 'due_date', 'tags', 'private'])
  .map((f) => ({ key: f, ...(TASK_COLUMNS[f] ?? { label: f, cell: (t) => String(t[f] ?? '') }) }));
const notesInColumns = columns.some((c) => c.key === 'notes');

function statusOptions(list, current) {
  const opts = list.map((s) => option(s, s, s === current));
  if (current && !list.includes(current)) opts.unshift(option(current, `${current} (not configured)`, true));
  return opts;
}
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
  tr.appendChild(el('th', { scope: 'col' }, 'Actions'));
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
  const filtered = !!(state.status || state.owner || state.tag);
  const none = state.tasks.length === 0;
  table.parentElement.hidden = none;
  document.getElementById('tasks-empty').hidden = !(none && filtered);
  document.getElementById('under-construction').hidden = !(none && !filtered);
}

/** @param {any} t */
function appendRow(t, before) {
  const tr = taskRow(t);
  if (before) tbody.insertBefore(tr, before); else tbody.appendChild(tr);
  if (state.openNotes.has(t.id) && !notesInColumns) tr.after(notesRow(t));
}

/** @param {any} t */
function taskRow(t) {
  const tr = el('tr', { id: `task-${t.id}`, class: isOverdue(t, config) ? 'overdue' : '' });
  for (const c of columns) tr.appendChild(el('td', { class: `col-${c.key}` }, c.cell(t)));
  const actions = el('td', { class: 'row-actions' });
  if (!notesInColumns) {
    const label = t.notes ? 'Notes *' : 'Notes';
    actions.appendChild(btn(label, () => toggleNotes(t), { 'aria-expanded': state.openNotes.has(t.id) ? 'true' : 'false', 'aria-label': `${t.notes ? 'Notes (has text)' : 'Notes'} for ${t.title}` }));
  }
  if (editing()) {
    actions.append(' ', moveSelect(t), ' ', btn('Trash', () => trashTask(t), { class: 'danger', 'aria-label': `Move task ${t.title} to the trash` }));
  }
  tr.appendChild(actions);
  return tr;
}

/** Replace a task in state and its row in the table (used after saves and 409s). @param {any} rec */
function replaceTask(rec) {
  const i = state.tasks.findIndex((x) => x.id === rec.id);
  // An edit can move a loaded row out of the loaded range (a new sort key, a filter it no longer
  // matches), which pulls an unseen row in. Stepping back one never skips it; if the row did not
  // move, the pager drops the repeat.
  if (i >= 0 && rec.version !== state.tasks[i].version) taskPager?.removed();
  if (i >= 0) state.tasks[i] = rec; else state.tasks.push(rec);
  const old = document.getElementById(`task-${rec.id}`);
  if (old) {
    const next = old.nextElementSibling;
    if (next?.classList.contains('notes-row')) next.remove();
    const fresh = taskRow(rec);
    old.replaceWith(fresh);
    if (state.openNotes.has(rec.id) && !notesInColumns) fresh.after(notesRow(rec));
  } else appendRow(rec);
}

/** Remove a task from state and the table. @param {string} id */
function dropTask(id) {
  state.tasks = state.tasks.filter((x) => x.id !== id);
  taskPager?.removed();
  const tr = document.getElementById(`task-${id}`);
  if (tr?.nextElementSibling?.classList.contains('notes-row')) tr.nextElementSibling.remove();
  tr?.remove();
  state.openNotes.delete(id);
  renderTasks();
}

/**
 * PATCH a task with the version from the last read; the row is re-rendered
 * from the response, or from `current` on a 409.
 * @param {any} t @param {object} fields
 */
async function patchTask(t, fields) {
  const rec = await attempt(() => patch(taskPath(t.id), { version: t.version, ...fields }), replaceTask);
  if (rec) {
    if (rec.project_id !== state.project.id) { dropTask(t.id); say(`"${rec.title}" moved to ${rec.project_name}.`); }
    else { replaceTask(rec); say('Saved.'); }
    loadOverdue();
  }
  return rec;
}

/* --- cells --- */

function titleInput(t) {
  const input = el('input', { type: 'text', value: t.title, required: true, maxlength: '500', 'aria-label': `Title of task ${t.title}` });
  input.addEventListener('change', () => { const v = input.value.trim(); if (v && v !== t.title) patchTask(t, { title: v }); else input.value = t.title; });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { input.value = t.title; } if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
  return input;
}

function select(t, field, options, toFields) {
  const s = el('select', { 'aria-label': `${field} of task ${t.title}` }, options);
  s.addEventListener('change', () => patchTask(t, toFields(s.value)));
  return s;
}

function dueInput(t) {
  const input = el('input', { type: 'date', value: t.due_date ?? '', 'aria-label': `Due date of task ${t.title}` });
  input.addEventListener('change', () => patchTask(t, { due_date: input.value || null }));
  return input;
}

function privateCell(t) {
  if (editing() && owns(t)) {
    const cb = el('input', { type: 'checkbox', checked: !!t.private, 'aria-label': `Private: ${t.title}` });
    cb.addEventListener('change', async () => {
      if (!cb.checked && !confirm('Make this task public?\nEveryone will see it, and its history becomes visible too.')) { cb.checked = true; return; }
      const rec = await patchTask(t, { private: cb.checked });
      if (!rec) cb.checked = !!t.private;
    });
    return [cb, t.private ? padlock() : null];
  }
  return t.private ? [padlock(), 'yes'] : 'no';
}

/** Notes as an inline column (when "notes" is in config.task_fields). */
function notesEditor(t) {
  if (!editing()) { const p = el('span', null, t.notes ?? ''); p.style.whiteSpace = 'pre-wrap'; return p; }
  const ta = el('textarea', { rows: '2', value: t.notes ?? '', 'aria-label': `Notes for task ${t.title}` });
  const save = btn('Save', () => patchTask(t, { notes: ta.value }));
  return [ta, save];
}

function toggleNotes(t) {
  const tr = document.getElementById(`task-${t.id}`);
  if (state.openNotes.has(t.id)) {
    state.openNotes.delete(t.id);
    if (tr?.nextElementSibling?.classList.contains('notes-row')) tr.nextElementSibling.remove();
  } else {
    state.openNotes.add(t.id);
    tr?.after(notesRow(t));
    tr?.nextElementSibling?.querySelector('textarea, .notes-text')?.focus();
  }
  tr?.querySelector('.row-actions button')?.setAttribute('aria-expanded', state.openNotes.has(t.id) ? 'true' : 'false');
}

function notesRow(t) {
  const td = el('td', { colspan: String(columns.length + 1) });
  if (editing()) {
    const ta = el('textarea', { id: `notes-${t.id}`, value: t.notes ?? '' });
    td.append(el('label', { for: ta.id }, `Notes for "${t.title}"`), ta, ' ', btn('Save notes', () => patchTask(t, { notes: ta.value })));
  } else {
    const p = el('p', { class: 'notes-text', tabindex: '-1' }, t.notes || '(no notes)');
    p.style.whiteSpace = 'pre-wrap';
    td.append(el('b', null, 'Notes'), p);
  }
  return el('tr', { class: 'notes-row' }, td);
}

/** "Move to…" select of other visible projects (loaded on first focus). */
function moveSelect(t) {
  const s = el('select', { 'aria-label': `Move task ${t.title} to another project` }, option('', 'Move to…'));
  const fill = async () => {
    if (!state.moveTargets) {
      try { state.moveTargets = (await get('/api/projects', { sort: 'name', limit: 1000 })).items ?? []; } catch { state.moveTargets = []; }
    }
    if (s.options.length === 1) for (const p of state.moveTargets) if (p.id !== state.project.id) s.appendChild(option(p.id, p.name));
  };
  s.addEventListener('focus', fill);
  s.addEventListener('pointerdown', fill);
  s.addEventListener('change', async () => {
    const target = s.value;
    if (!target) return;
    const rec = await patchTask(t, { project_id: target });
    if (!rec) s.value = '';
  });
  return s;
}

async function trashTask(t) {
  if (!confirm(`Move the task "${t.title}" to the trash?`)) return;
  const rec = await attempt(() => del(taskPath(t.id), { version: t.version }), replaceTask);
  if (rec) { dropTask(t.id); say(`"${rec.title}" moved to the trash.`); loadOverdue(); }
}

/* -------------------------------------------------------------- add a task */

function setupNewTask() {
  const form = document.getElementById('new-task');
  if (!editing()) { form.hidden = true; return; }
  const status = document.getElementById('nt-status');
  const owner = document.getElementById('nt-owner');
  setChildren(status, statusOptions(config.statuses.task, config.default_status.task));
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
      setChildren(status, statusOptions(config.statuses.task, config.default_status.task));
      owner.value = me.id;
      say(`Task "${t.title}" added.`);
      await loadTasks();
      loadOverdue();
      document.getElementById(`task-${t.id}`)?.querySelector('input, a')?.focus();
    } catch (err) { sayError(err, 'Could not add the task'); }
  });
}

/* ------------------------------------------------------------------- misc */

async function loadOverdue() {
  try { await refreshOverdue(config, { project: state.project.id }); } catch (err) { sayError(err, 'Could not check for overdue tasks'); }
}

/** Scroll to #task-<id> when linked from the feed or search. */
function jumpToHash() {
  if (!location.hash) return;
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const tr = document.getElementById(id);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center' });
  tr.querySelector('input, select, a')?.focus();
}

// A same-page link (the overdue line, say) changes only the hash: follow it to the row.
window.addEventListener('hashchange', jumpToHash);

/* ------------------------------------------------------------------ start */
// Last, so every const above (columns, TASK_COLUMNS) is initialized first.
if (!projectId) {
  setChildren(projectHost, [el('h1', null, 'No project'), el('p', null, 'This page needs ?id=<project id>. ', el('a', { href: 'index.html' }, 'Back to the list'))]);
} else {
  await start();
}
