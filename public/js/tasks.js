// tasks.js — one project (project.html?id=…): editable header, privacy
// toggle, tags, export, trash, hit counter, and the task table with sort,
// filter, add, and read-only rows that an Edit button turns into a form
// (one PATCH of the changed fields), plus notes, tags, move, and trash, and
// a guestbook for the project and for each task (in its notes row).
//
// Columns are data-driven: TASK_COLUMNS knows how to render each field and
// config.task_fields picks which ones show, in order ("add a field" recipe).

import { boot, say, sayError, attempt } from './page.js';
import { get, post, patch, del, projectPath, taskPath, ApiError } from './api.js';
import { el, btn, option, clear, setChildren, padlock, projectLink, timeEl } from './dom.js';
import { refreshOverdue, isOverdue } from './overdue.js';
import { tagEditor } from './tags.js';
import { createPager } from './pager.js';
import { guestbook } from './guestbook.js';

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
  /** Task guestbooks, kept while the page lives so a rebuilt notes row keeps its draft. @type {Map<string, any>} */
  guestbooks: new Map(),
  hitDone: false,
};

/** True when the viewer may change things on this page. */
const mayEdit = () => !!me.can_edit && !state.project?.deleted_at;
/** The viewer owns the task (private flag and reassigning a private task are owner-only). */
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
  projectBook = guestbook({ type: 'project', id: state.project.id, label: 'this project', heading: 'h2', me, canSign: mayEdit });
  document.getElementById('project-guestbook').appendChild(projectBook);
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
  const canEditProject = mayEdit();
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
    save: async (v) => {
      if (p.private && v !== p.owner_id && !confirm(`Hand this private project to ${personName(v)}? Your tasks in it move to ${await catchAllName()} and stay private to you, and the project will be private to its new owner.`)) return null;
      return patchProject({ owner_id: v, owner_name: personName(v) }, 'Owner saved.');
    } }));

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
  projectBook?.refresh(); // trash and restore open or close it
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
 * How each task field shows. Rows read first: `view(t)` is the read-only
 * cell. A column with `edit(t)` appears in the row's Edit form: `edit`
 * returns `{control, changes}`, where `changes()` gives only the fields that
 * differ from `t` (Save sends one PATCH with just those), or null when this
 * viewer may not change the field, which then shows `still(t)` (else
 * `view(t)`) instead. `sort` is the API sort field (or absent). The Actions
 * column is always added.
 */
const TASK_COLUMNS = {
  title: { label: 'Title', sort: 'title',
    view: (t) => [t.private ? padlock() : null, t.title],
    edit: (t) => {
      const input = el('input', { type: 'text', value: t.title, required: true, maxlength: '500' });
      return { control: input, changes: () => changed(t, 'title', input.value.trim()) };
    } },
  status: { label: 'Status', sort: 'status',
    view: (t) => t.status,
    edit: (t) => {
      const s = el('select', null, statusOptions(config.statuses.task, t.status));
      return { control: s, changes: () => changed(t, 'status', s.value) };
    } },
  owner: { label: 'Owner', sort: 'owner_name',
    view: (t) => t.owner_name,
    edit: (t) => {
      if (t.private && !owns(t)) return null;
      const s = el('select', null, peopleOptions(t.owner_id));
      return { control: s, changes: () => (s.value === t.owner_id ? {} : { owner_id: s.value, owner_name: personName(s.value) }) };
    } },
  due_date: { label: 'Due', sort: 'due_date',
    view: (t) => t.due_date ?? '',
    edit: (t) => {
      const input = el('input', { type: 'date', value: t.due_date ?? '' });
      return { control: input, changes: () => changed(t, 'due_date', input.value || null) };
    } },
  // Tag chips save on their own (each attach or detach is its own versioned write), so the Edit row only shows them.
  tags: { label: 'Tags',
    view: (t) => tagEditor({ type: 'task', item: t, canEdit: mayEdit(), compact: true, config, onUpdated: replaceTask }),
    edit: () => null,
    still: (t) => (t.tags?.length ? tagEditor({ type: 'task', item: t, canEdit: false, compact: true, config }) : el('span', { class: 'muted' }, 'none')) },
  private: { label: 'Private',
    view: (t) => (t.private ? [padlock(), 'yes'] : 'no'),
    edit: (t) => {
      if (!owns(t)) return null;
      const cb = el('input', { type: 'checkbox', checked: !!t.private });
      return { control: cb, changes: () => changed(t, 'private', cb.checked) };
    } },
  notes: { label: 'Notes',
    view: (t) => { const span = el('span', null, t.notes ?? ''); span.style.whiteSpace = 'pre-wrap'; return span; },
    edit: (t) => {
      const ta = el('textarea', { rows: '3', value: t.notes ?? '' });
      return { control: ta, changes: () => changed(t, 'notes', ta.value, '') };
    } },
  project: { label: 'Project', view: (t) => projectLink(t.project_id, t.project_name) },
  created_at: { label: 'Created', sort: 'created_at', view: (t) => timeEl(t.created_at) },
  updated_at: { label: 'Updated', sort: 'updated_at', view: (t) => timeEl(t.updated_at) },
};
const columns = (config.task_fields ?? ['title', 'status', 'owner', 'due_date', 'tags', 'private'])
  .map((f) => ({ key: f, ...(TASK_COLUMNS[f] ?? { label: f, view: (t) => String(t[f] ?? '') }) }));
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
function appendRow(t, before) {
  const tr = taskRow(t);
  if (before) tbody.insertBefore(tr, before); else tbody.appendChild(tr);
  if (state.openNotes.has(t.id) && !notesInColumns) tr.after(notesRow(t));
}

/** @param {any} t */
function taskRow(t) {
  const tr = el('tr', { id: `task-${t.id}`, class: isOverdue(t, config) ? 'overdue' : '' });
  for (const c of columns) tr.appendChild(el('td', { class: `col-${c.key}`, 'data-label': c.label }, c.view(t)));
  const actions = el('td', { class: 'row-actions' });
  if (mayEdit()) actions.append(btn('Edit', () => editRow(t), { class: 'edit', 'aria-label': `Edit task ${t.title}` }), ' ');
  if (!notesInColumns) {
    const label = t.notes ? 'Notes * & guestbook' : 'Notes & guestbook';
    actions.appendChild(btn(label, () => toggleNotes(t), { class: 'notes-toggle', 'aria-expanded': state.openNotes.has(t.id) ? 'true' : 'false', 'aria-label': `${t.notes ? 'Notes (has text)' : 'Notes'} & guestbook for ${t.title}` }));
  }
  if (mayEdit()) actions.append(' ', btn('Trash', () => trashTask(t), { class: 'danger', 'aria-label': `Move task ${t.title} to the trash` }));
  tr.appendChild(actions);
  return tr;
}

/**
 * Turn a row into a form: one cell across the table holding a labelled
 * control for each column that has one (wrapping to fit any width), the
 * read-only value for a column this viewer may not change, then Save,
 * Cancel, and "Move to…". Enter saves, Escape cancels; either way focus
 * goes back to the row's Edit button.
 * @param {any} t
 */
function editRow(t) {
  const tr = document.getElementById(`task-${t.id}`);
  if (!tr) return;
  const editors = [];
  const fields = columns.filter((c) => c.edit).map((c) => {
    const ed = c.edit(t);
    if (!ed) return el('div', { class: `field col-${c.key}` }, el('span', { class: 'field-label' }, c.label), (c.still ?? c.view)(t));
    editors.push(ed);
    ed.control.id = `edit-${t.id}-${c.key}`;
    return el('div', { class: `field col-${c.key}` }, el('label', { for: ed.control.id }, c.label), ed.control);
  });
  const move = moveSelect();
  move.id = `edit-${t.id}-move`;
  const save = el('button', { type: 'button', class: 'save' }, 'Save');
  save.addEventListener('click', () => saveRow(t, editors, move, save));
  const form = el('div', { class: 'task-edit', role: 'group', 'aria-label': `Edit task ${t.title}` }, fields,
    el('div', { class: 'field col-move' }, el('label', { for: move.id }, 'Move to project'), move),
    el('div', { class: 'field task-edit__buttons' }, save, ' ', btn('Cancel', () => { if (!save.disabled) closeRow(t); })));
  const fresh = el('tr', { id: tr.id, class: `${tr.className} editing` }, el('td', { colspan: String(columns.length + 1) }, form));
  fresh.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return; // an IME is still choosing characters
    if (ev.key === 'Escape') { ev.preventDefault(); if (!save.disabled) closeRow(t); }
    else if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement) && !(ev.target instanceof HTMLButtonElement)) {
      ev.preventDefault();
      saveRow(t, editors, move, save);
    }
  });
  tr.replaceWith(fresh);
  fresh.querySelector('input, select, textarea')?.focus();
}

/** Back to the read-only row for `t`, focus on its Edit button. @param {any} t */
function closeRow(t) {
  const tr = document.getElementById(`task-${t.id}`);
  if (!tr) return;
  tr.replaceWith(taskRow(t));
  focusEdit(t.id);
}

/** @param {string} id */
function focusEdit(id) { document.getElementById(`task-${id}`)?.querySelector('button.edit')?.focus(); }

/**
 * One PATCH with only the changed fields and the version the row was read at.
 * @param {any} t @param {Array<{changes: () => object}>} editors @param {HTMLSelectElement} move @param {HTMLButtonElement} save
 */
async function saveRow(t, editors, move, save) {
  if (save.disabled) return;
  // An open Notes row under the form saves with it, so neither Save throws away the other's typing.
  const notes = notesInColumns ? null : /** @type {HTMLTextAreaElement|null} */ (document.getElementById(`notes-${t.id}`));
  const fields = Object.assign({}, ...editors.map((e) => e.changes()), notes ? changed(t, 'notes', notes.value, '') : {},
    move.value ? { project_id: move.value } : {});
  if ('title' in fields && !fields.title) { say('A task needs a title.', { error: true }); document.getElementById(`edit-${t.id}-title`)?.focus(); return; }
  if (!Object.keys(fields).length) { closeRow(t); return; }
  if (fields.private === false && !confirm('Make this task public?\nEveryone will see it, and its history becomes visible too.')) return;
  save.disabled = true;
  const rec = await attempt(() => patch(taskPath(t.id), { version: t.version, ...fields }), (current) => { replaceTask(current, { keepForm: false }); focusEdit(current.id); });
  save.disabled = false;
  if (!rec) return;
  if (rec.project_id !== state.project.id) {
    dropTask(t.id);
    say(`"${rec.title}" moved to ${rec.project_name}.`);
  } else {
    replaceTask(rec, { keepForm: false });
    focusEdit(rec.id);
    say('Saved.');
  }
  loadOverdue();
}

/** Compare one field with the task: `{[key]: v}` when it changed, else nothing. */
function changed(t, key, v, empty = null) {
  return v === (t[key] ?? empty) ? {} : { [key]: v };
}

/**
 * Replace a task in state and its row in the table (used after saves and 409s).
 * A row with its Edit form open keeps the form (a late tag write must not wipe
 * someone's typing); its Save then meets the new version as a 409. The form's
 * own Save passes keepForm: false.
 * @param {any} rec @param {{keepForm?: boolean}} [opts]
 */
function replaceTask(rec, { keepForm = true } = {}) {
  const i = state.tasks.findIndex((x) => x.id === rec.id);
  // An edit can move a loaded row out of the loaded range (a new sort key, a filter it no longer
  // matches), which pulls an unseen row in. Stepping back one never skips it; if the row did not
  // move, the pager drops the repeat.
  if (i >= 0 && rec.version !== state.tasks[i].version) taskPager?.removed();
  if (i >= 0) state.tasks[i] = rec; else state.tasks.push(rec);
  const old = document.getElementById(`task-${rec.id}`);
  if (old?.classList.contains('editing') && keepForm) return;
  if (old) {
    const next = old.nextElementSibling;
    if (next?.classList.contains('notes-row')) next.remove();
    const fresh = taskRow(rec);
    old.replaceWith(fresh);
    if (state.openNotes.has(rec.id) && !notesInColumns) fresh.after(notesRow(rec));
  } else appendRow(rec);
}

/**
 * Remove a task from state and the table, and move focus to the next row's
 * Edit (or Notes) button, else the previous row's, else the Tasks heading.
 * @param {string} id
 */
function dropTask(id) {
  const i = state.tasks.findIndex((x) => x.id === id);
  const neighbour = state.tasks[i + 1] ?? state.tasks[i - 1];
  state.tasks = state.tasks.filter((x) => x.id !== id);
  taskPager?.removed();
  const tr = document.getElementById(`task-${id}`);
  if (tr?.nextElementSibling?.classList.contains('notes-row')) tr.nextElementSibling.remove();
  tr?.remove();
  state.openNotes.delete(id);
  state.guestbooks.delete(id);
  showEmpty(); // only this row goes, so other rows keep an open Edit form
  const row = neighbour && document.getElementById(`task-${neighbour.id}`);
  const target = row && (row.querySelector('button.edit') ?? row.querySelector('button.notes-toggle'));
  (target ?? document.getElementById('tasks-h'))?.focus();
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

/* --- notes and moving --- */

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
  tr?.querySelector('.row-actions button.notes-toggle')?.setAttribute('aria-expanded', state.openNotes.has(t.id) ? 'true' : 'false');
}

function notesRow(t) {
  const td = el('td', { colspan: String(columns.length + 1) });
  if (mayEdit()) {
    const ta = el('textarea', { id: `notes-${t.id}`, value: t.notes ?? '' });
    // While the task's Edit form is open, its Save sends these notes too, so this button goes through it.
    const save = () => {
      const row = document.getElementById(`task-${t.id}`);
      if (row?.classList.contains('editing')) row.querySelector('button.save')?.click(); else patchTask(t, { notes: ta.value });
    };
    td.append(el('label', { for: ta.id }, `Notes for "${t.title}"`), ta, ' ', btn('Save notes', save));
  } else {
    const p = el('p', { class: 'notes-text', tabindex: '-1' }, t.notes || '(no notes)');
    p.style.whiteSpace = 'pre-wrap';
    td.append(el('b', null, 'Notes'), p);
  }
  let book = state.guestbooks.get(t.id);
  if (!book) {
    book = guestbook({ type: 'task', id: t.id, label: `"${t.title}"`, heading: 'h3', me,
      canSign: () => mayEdit() && !state.tasks.find((x) => x.id === t.id)?.deleted_at });
    state.guestbooks.set(t.id, book);
  } else { book.relabel(`"${t.title}"`); book.refresh(); }
  td.appendChild(book);
  return el('tr', { class: 'notes-row' }, td);
}

/** "Move to…" select of other visible projects for the Edit row (loaded on first focus). */
function moveSelect() {
  const s = el('select', { 'aria-label': 'Move to project' }, option('', 'Move to…'));
  const fill = async () => {
    if (!state.moveTargets) {
      try { state.moveTargets = (await get('/api/projects', { sort: 'name', limit: config.limits?.max_page_size })).items ?? []; } catch { state.moveTargets = []; }
    }
    if (s.options.length === 1) for (const p of state.moveTargets) if (p.id !== state.project.id) s.appendChild(option(p.id, p.name));
  };
  s.addEventListener('focus', fill);
  s.addEventListener('pointerdown', fill);
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
  if (!mayEdit()) { form.hidden = true; return; }
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
      document.getElementById(`task-${t.id}`)?.querySelector('button.edit, a')?.focus();
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
  (tr.querySelector('button.edit') ?? tr.querySelector('button.notes-toggle') ?? tr.querySelector('a'))?.focus();
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
