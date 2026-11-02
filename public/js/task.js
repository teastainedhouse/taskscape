// task.js — one task (task.html?id=…): every field editable by clicking it
// (js/inline-edit.js), the notes, tags, the project it belongs to, its
// comments (js/guestbook.js), its activity, and the one place a task is
// trashed or restored. A missing id and an id the viewer may not see render
// the same generic not-found page.

import { boot, say, sayError, attempt } from './page.js';
import { api, get, post, patch, del, taskPath, projectPath, ApiError } from './api.js';
import { linksList, linkForm } from './task-links.js';
import { checklistList, checklistForm } from './task-checklist.js';
import { RECURRENCE_WORDS, recurrenceMark } from './task-columns.js';
import { el, btn, setChildren, padlock, projectLink, taskLink, timeEl, oneLine } from './dom.js';
import { inlineEdit, selectFor, focusEditable, redraw } from './inline-edit.js';
import { isOverdue } from './overdue.js';
import { tagEditor } from './tags.js';
import { guestbook, commentWords } from './guestbook.js';
import { describeActivity, viaBadge } from './activity-words.js';

const { config, me } = await boot({ title: 'Task' });
const words = commentWords(me.preferences.comments_label);
const taskId = new URLSearchParams(location.search).get('id');

const state = {
  /** @type {any} */ task: null,
  /** The task's project, read for its trash state (a trashed project's tasks carry no deleted_at of their own). @type {any} */ project: null,
  /** @type {Array<{id: string, name: string}>} */ people: [],
  /** @type {any[]|null} */ projects: null,
  /** @type {string|null} */ cursor: null,
  activityCount: 0,
  activityBusy: false,
  activityAgain: false,
};

const host = document.getElementById('task');
const notesSection = document.getElementById('notes-section');
const linksSection = document.getElementById('links-section');
const linksHost = document.getElementById('links');
const linkFormHost = document.getElementById('link-form-host');
/** @type {HTMLElement|null} */ let linkFormEl = null;
const checklistSection = document.getElementById('checklist-section');
const checklistHost = document.getElementById('checklist');
const checklistFormHost = document.getElementById('checklist-form-host');
/** @type {HTMLElement|null} */ let checklistFormEl = null;
const notesHost = document.getElementById('notes');
const actions = document.getElementById('task-actions');
const activitySection = document.getElementById('activity-section');
const activityList = document.getElementById('task-activity');
const activityMore = document.getElementById('activity-more');
/** @type {any} */ let book = null;

/** True when the viewer may change this task: an editor, and neither the task nor its project is in the trash. */
const mayEdit = () => !!me.can_edit && !state.task?.deleted_at && !state.project?.deleted_at;
const owns = () => state.task?.owner_id === me.id;

function notFound() {
  document.title = `Not found - ${config.site_title || 'Taskscape'}`;
  activitySection.hidden = true;
  setChildren(host, [el('h1', null, 'Not found'),
    el('p', null, 'This task does not exist, or it is private to someone else. ', el('a', { href: 'index.html' }, 'Back to the projects'))]);
  document.getElementById('crumbs').hidden = true;
}

async function start() {
  if (!taskId) { notFound(); return; }
  try {
    state.task = await get(taskPath(taskId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound(); else sayError(err, 'Could not load the task');
    return;
  }
  try { state.people = (await get('/api/people')).items ?? []; } catch { state.people = []; }
  for (const who of [{ id: me.id, name: me.name }, { id: state.task.owner_id, name: state.task.owner_name }]) {
    if (who.id && !state.people.some((p) => p.id === who.id)) state.people.push(who);
  }
  // Every visible project, for "Project": one request, the largest page. The task's own project separately, for its trash state.
  const [projects, project] = await Promise.all([
    get('/api/projects', { sort: 'name', limit: config.limits?.max_page_size }).then((r) => r.items ?? [], () => []),
    get(projectPath(state.task.project_id)).catch(() => null),
  ]);
  state.projects = projects;
  state.project = project;
  render();
  book = guestbook({ type: 'task', id: state.task.id, label: 'this task', heading: 'h2', me, canSign: mayEdit, words });
  document.getElementById('task-guestbook').appendChild(book);
  activitySection.hidden = false;
  activityMore.addEventListener('click', () => loadActivity());
  await loadActivity(true);
}

/* ------------------------------------------------------------------ render */

function render() {
  const t = state.task;
  document.title = `${t.title} - ${config.site_title || 'Taskscape'}`;
  const canEdit = mayEdit();

  const crumbs = document.getElementById('crumbs');
  if (crumbs.dataset.project !== t.project_id) { // redrawn only on a move, so a focused crumb link stays put
    crumbs.dataset.project = t.project_id;
    setChildren(crumbs, [el('a', { href: 'index.html' }, '« All projects'), ' / ', projectLink(t.project_id, t.project_name ?? 'Project')]);
  }

  const parts = [];
  if (t.deleted_at) {
    // a task in a trashed project cannot be restored on its own: the API says "restore the project first"
    parts.push(el('div', { class: 'status error', role: 'alert' }, 'This task is in the trash (since ', timeEl(t.deleted_at), '). ',
      state.project?.deleted_at ? ['Its project is in the trash too; restore ', projectLink(state.project.id, 'the project'), ' first.']
        : me.can_edit ? btn('Restore', restoreTask) : null));
  } else if (state.project?.deleted_at) {
    parts.push(el('div', { class: 'status error', role: 'alert' }, 'This task\'s project is in the trash (since ', timeEl(state.project.deleted_at),
      '), so the task is read-only until the project is restored. ', projectLink(state.project.id, 'Open the project')));
  }

  parts.push(el('h1', { id: 'task-title' }, t.private ? padlock() : null,
    inlineEdit({ key: 'task-title', label: 'Title', allowed: canEdit, value: t.title,
      control: (v) => el('input', { type: 'text', value: v, required: true, maxlength: '200', size: '40' }),
      save: (v) => (v.trim() ? patchTask({ title: v.trim() }, t.version) : (say('A task needs a title.', { error: true }), null)) })));

  const meta = el('table', { class: 'meta' });
  const row = (label, ...cells) => meta.appendChild(el('tr', null, el('th', { scope: 'row' }, label), el('td', null, cells)));

  // plain text, not a link: a link inside the value button would be a control inside a control (the breadcrumb links to the project)
  row('Project', inlineEdit({ key: 'task-project', label: 'Project', allowed: canEdit && (state.projects?.length ?? 0) > 0, value: t.project_id,
    format: (id) => projectName(id),
    control: (v) => selectFor(projectOptions(), v),
    save: (v) => {
      // out of a private project into a public one: the task and its whole history become visible, like making it public
      const target = state.projects?.find((p) => p.id === v);
      if (state.project?.private && target && !target.private && !t.private
        && !confirm(`Move this task to ${oneLine(target.name)}?\nIt leaves your private project, so everyone will see it, and its history becomes visible too.`)) return null;
      return patchTask({ project_id: v }, t.version);
    } }));

  row('Status', inlineEdit({ key: 'task-status', label: 'Status', allowed: canEdit, value: t.status,
    control: (v) => selectFor(config.statuses.task.map((s) => ({ value: s })), v),
    save: async (v) => {
      const rec = await patchTask({ status: v }, t.version);
      return rec && (rec.recurred_to && !t.recurred_to ? { note: 'It repeats, so the next one was created: see "Next one" below.' } : rec);
    } }));

  if ((config.priorities ?? []).length || t.priority) {
    row('Priority', inlineEdit({ key: 'task-priority', label: 'Priority', allowed: canEdit, value: t.priority, empty: 'none',
      control: (v) => selectFor([{ value: '', label: 'None' }, ...(config.priorities ?? []).map((p) => ({ value: p }))], v),
      save: (v) => patchTask({ priority: v || null }, t.version) }));
  }

  row('Owner', inlineEdit({ key: 'task-owner', label: 'Owner', allowed: canEdit && (!t.private || owns()), value: t.owner_id,
    format: (id) => personName(id),
    // a private project holds only its owner's tasks, so inside one the only owner on offer is the project's
    control: (v) => selectFor((state.project?.private ? state.people.filter((p) => p.id === state.project.owner_id) : state.people).map((p) => ({ value: p.id, label: p.name })), v, { missing: t.owner_name }),
    save: (v) => {
      // handing over a private task hands over its history and comments, and you lose sight of it
      if (t.private && v !== t.owner_id && !confirm(`Hand this private task to ${oneLine(personName(v))}?\nIt will be private to them: you will no longer see it, its history, or its comments.`)) return null;
      return patchTask({ owner_id: v, owner_name: personName(v) }, t.version);
    } }));

  const due = inlineEdit({ key: 'task-due', label: 'Due date', allowed: canEdit, value: t.due_date,
    empty: 'no due date',
    control: (v) => el('input', { type: 'date', value: v ?? '' }),
    save: (v) => patchTask({ due_date: v || null }, t.version) });
  row('Due', due, isOverdue(t, config) ? el('b', { class: 'overdue-mark' }, ' (overdue)') : null);

  row('Repeats', inlineEdit({ key: 'task-recurrence', label: 'Repeats', allowed: canEdit, value: t.recurrence, empty: 'does not repeat',
    format: (v) => (v ? RECURRENCE_WORDS[v] ?? v : el('span', { class: 'muted' }, 'does not repeat')),
    control: (v) => selectFor([{ value: '', label: 'Does not repeat' }, ...Object.entries(RECURRENCE_WORDS).map(([value, label]) => ({ value, label: `Every ${label.slice(6)}` }))], v),
    save: (v) => patchTask({ recurrence: v || null }, t.version) }),
    t.recurrence && !t.recurred_to && !config.closed_statuses.task.includes(t.status) && !state.project?.deleted_at ? el('span', { class: 'muted' }, ' (closing it creates the next one, once)') : null);
  if (t.recurred_to) row('Next one', taskLink(t.recurred_to, 'Open the next one'));
  if (t.recurred_from) row('Came from', taskLink(t.recurred_from, 'Open the one before'));

  const inPrivateProject = !!state.projects?.find((p) => p.id === t.project_id)?.private;
  const privacy = [t.private ? [padlock(), 'Private: only you can see this task'] : inPrivateProject ? 'Public, but inside your private project, so only you can see it' : 'Public'];
  if (owns() && canEdit) privacy.push(' ', btn(t.private ? 'Make public' : 'Make private', togglePrivacy, { class: 'privacy-toggle' }));
  row('Privacy', privacy);

  row('Tags', tagEditor({ type: 'task', item: t, canEdit, config, onUpdated: (rec) => { state.task = rec; render(); loadActivity(true); } }));
  row('Created', timeEl(t.created_at));
  row('Updated', timeEl(t.updated_at));
  parts.push(el('div', { class: 'table-wrap' }, meta));
  redraw(host, parts); // an open editor, and focus, survive the redraw

  checklistSection.hidden = false;
  redraw(checklistHost, checklistList({ task: t, canEdit, write: writeChild, taskPath: taskPath(t.id) }));
  if (canEdit && !checklistFormEl) { checklistFormEl = checklistForm({ write: writeChild, taskPath: taskPath(t.id), version: () => state.task.version }); checklistFormHost.append(checklistFormEl); }
  if (checklistFormEl) checklistFormEl.hidden = !canEdit;

  linksSection.hidden = false;
  redraw(linksHost, [linksList({ task: t, canEdit, write: writeChild, taskPath: taskPath(t.id) })]);
  if (canEdit && !linkFormEl) { linkFormEl = linkForm({ write: writeChild, taskPath: taskPath(t.id), version: () => state.task.version }); linkFormHost.append(linkFormEl); }
  if (linkFormEl) linkFormEl.hidden = !canEdit;

  notesSection.hidden = false;
  redraw(notesHost, [inlineEdit({ key: 'task-notes', label: 'Notes', allowed: canEdit, value: t.notes ?? '', block: true,
    empty: canEdit ? 'No notes yet. Click to add some.' : 'No notes.',
    control: (v) => el('textarea', { rows: '6', value: v }),
    save: (v) => patchTask({ notes: v }, t.version) })]);

  const acts = [];
  if (canEdit) acts.push(btn('Trash this task', trashTask, { class: 'danger' }));
  setChildren(actions, acts);
  actions.hidden = acts.length === 0;

  book?.refresh();
}

function projectName(id) { return state.projects?.find((p) => p.id === id)?.name ?? (id === state.task.project_id ? state.task.project_name : null) ?? id; }
function projectOptions() {
  // a private project holds only its owner's tasks (PLAN.md §2 rule 1), so offer one only when it is the task owner's
  const t = state.task;
  const list = (state.projects ?? []).filter((p) => !p.deleted_at && (!p.private || p.owner_id === t.owner_id)).map((p) => ({ value: p.id, label: p.name }));
  if (!list.some((o) => o.value === state.task.project_id)) list.unshift({ value: state.task.project_id, label: state.task.project_name ?? state.task.project_id });
  return list;
}
function personName(id) { return state.people.find((p) => p.id === id)?.name ?? (id === state.task.owner_id ? state.task.owner_name : id); }

/* ------------------------------------------------------------------ writes */

/**
 * PATCH with the version the editor was opened on (not whatever the page holds
 * by the time the save runs), so a stale edit meets a 409 instead of overwriting;
 * re-render on success or 409.
 * @param {object} fields @param {number} version
 */
async function patchTask(fields, version) {
  const t = state.task;
  const rec = await attempt(() => patch(taskPath(t.id), { version, ...fields }), (current) => { state.task = current; render(); });
  if (!rec) return null;
  state.task = rec;
  if (rec.project_id !== t.project_id) state.project = state.projects?.find((p) => p.id === rec.project_id) ?? null; // moved: the target was offered from the live list
  render();
  loadActivity(true); // the edit is an entry now
  return rec;
}

/**
 * One write to something on the task (a link, a checklist item): the task comes back and the page redraws from it, or from
 * `current` on a 409. Resolves with the task, or null.
 * @param {string} method @param {string} path @param {object} body
 */
async function writeChild(method, path, body) {
  const rec = await attempt(() => api(method, path, { body }), (current) => { state.task = current; render(); });
  if (!rec) return null;
  state.task = rec;
  render();
  loadActivity(true);
  return rec;
}

async function togglePrivacy() {
  const t = state.task;
  if (t.private) {
    if (!confirm('Make this task public?\nEveryone will see it, and its history in What\'s New becomes visible too.')) return;
    if (await patchTask({ private: false }, t.version)) say('This task is now public, including its history.');
  } else if (await patchTask({ private: true }, t.version)) say('This task is now private.');
  host.querySelector('button.privacy-toggle')?.focus();
}

async function trashTask() {
  const t = state.task;
  if (!confirm(`Move the task "${oneLine(t.title)}" to the trash?\nYou can restore it from this page or the Trash page.`)) return;
  const rec = await attempt(() => del(taskPath(t.id), { version: t.version }), (current) => { state.task = current; render(); });
  if (rec) { state.task = rec; render(); loadActivity(true); say('Task moved to the trash.'); host.querySelector('button')?.focus(); }
}

async function restoreTask() {
  const t = state.task;
  const rec = await attempt(() => post(`${taskPath(t.id)}/restore`, { version: t.version }), (current) => { state.task = current; render(); });
  if (rec) { state.task = rec; render(); loadActivity(true); say('Task restored.'); focusEditable('task-title'); }
}

/* ---------------------------------------------------------------- activity */

/** This task's entries, newest first, a page at a time. @param {boolean} [first] */
async function loadActivity(first = false) {
  if (state.activityBusy) { if (first) state.activityAgain = true; return; } // a reload asked for mid-load runs when this one ends
  state.activityBusy = true;
  if (first) { state.cursor = null; state.activityCount = 0; setChildren(activityList, []); }
  activityMore.setAttribute('aria-disabled', 'true');
  try {
    const res = await get('/api/activity', { item_type: 'task', item_id: state.task.id, limit: 50, before: state.cursor ?? undefined });
    const items = res.items ?? [];
    const projectNames = new Map((state.projects ?? []).map((p) => [p.id, p.name]));
    for (const a of items) {
      const d = describeActivity(a, { projectNames, words });
      activityList.appendChild(el('li', null, timeEl(a.created_at), ' — ', el('b', null, a.actor_name), ' (', viaBadge(a.via), ') ', d.what));
    }
    state.activityCount += items.length;
    state.cursor = res.next_cursor ?? null;
    activityMore.hidden = !state.cursor;
    document.getElementById('activity-empty').hidden = state.activityCount > 0;
  } catch (err) { sayError(err, 'Could not load the activity'); } finally {
    activityMore.removeAttribute('aria-disabled');
    state.activityBusy = false;
    if (state.activityAgain) { state.activityAgain = false; loadActivity(true); }
  }
}

await start();
