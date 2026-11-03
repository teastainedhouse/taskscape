// task-columns.js — how each task field shows in a list, shared by the
// project's task table (js/tasks.js) and My tasks (js/mine.js), so a field is
// described once ("add a field" recipe in CLAUDE.md). config.task_fields picks
// which columns a project's table shows, in order; My tasks shows its own
// fixed columns plus the optional summary columns task_fields lists.
//
// A column with `view(t)` is read-only. A column with `value(t)` and
// `control(t, v)` is edited in place (js/inline-edit.js): clicking the cell
// opens the control, and a change becomes one PATCH of `fields(t, v)` with the
// row's version. `allowed(t)` can keep the editor from a viewer who may not
// change that field (the owner-only ones); `format(v, t)` draws the value;
// `confirm(t, v)` may ask first; `after(t)` adds still text after the value
// (the overdue mark, so overdue is never said by colour alone). `sort` is the
// API sort field (or absent).

import { el, padlock, projectLink, taskLink, timeEl, oneLine } from './dom.js';
import { inlineEdit, selectFor } from './inline-edit.js';
import { isOverdue } from './overdue.js';
import { tagEditor } from './tags.js';
import { checklistProgress } from './task-checklist.js';

/** How the rules read. */
export const RECURRENCE_WORDS = { daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year' };

/**
 * The small "repeats" marker after a title: a glyph for the eye, words for a screen reader, a tooltip for the pointer.
 * @param {any} t
 */
export function recurrenceMark(t) {
  if (!t.recurrence) return null;
  const words = RECURRENCE_WORDS[t.recurrence] ?? t.recurrence;
  return el('span', { class: 'recur-mark', title: `Repeats ${words}` }, el('span', { 'aria-hidden': 'true' }, ' ↻'), el('span', { class: 'visually-hidden' }, ` (repeats ${words})`));
}

/** What to add to the announcement when a save closed a repeating task and the API made its next copy. @param {any} before @param {any} rec */
export function copyNote(before, rec) {
  return rec?.recurred_to && !before.recurred_to ? 'It repeats, so the next one was created; it shows when the list reloads.' : null;
}

/** Columns My tasks always shows, in order. */
export const MINE_FIELDS = ['due_date', 'title', 'project', 'status', 'tags'];
/** Summary columns My tasks also shows when config.task_fields lists them, after status. */
export const OPTIONAL_SUMMARY_FIELDS = ['priority', 'checklist', 'links'];

/**
 * @typedef {Object} ColumnContext
 * @property {any} config
 * @property {any} me
 * @property {() => boolean} mayEdit            the viewer may change things in this list
 * @property {() => Array<{id: string, name: string}>} people  owners on offer
 * @property {() => any} [project]              the project the list is in (project page), for the private-project owner rule
 * @property {(t: any, fields: object) => Promise<any>} save  one PATCH; resolves like an inline-edit save
 * @property {(rec: any) => void} onUpdated     a tag chip saved on its own
 * @property {string} [keyPrefix]               makes edit keys unique when one task shows in several lists on a page
 */

/**
 * @param {ColumnContext} ctx
 * @returns {Record<string, any>}
 */
export function taskColumns(ctx) {
  const { config, me } = ctx;
  const owns = (t) => t.owner_id === me.id;
  const personName = (id, t) => ctx.people().find((p) => p.id === id)?.name ?? (t && id === t.owner_id ? t.owner_name : id);
  return {
    title: { label: 'Title', sort: 'title', view: (t) => [t.private ? padlock() : null, taskLink(t.id, t.title), recurrenceMark(t)] },
    status: { label: 'Status', sort: 'status', value: (t) => t.status,
      control: (t, v) => selectFor(config.statuses.task.map((s) => ({ value: s })), v),
      fields: (t, v) => ({ status: v }) },
    priority: { label: 'Priority', sort: 'priority', value: (t) => t.priority, empty: '—',
      control: (t, v) => selectFor([{ value: '', label: 'None' }, ...(config.priorities ?? []).map((p) => ({ value: p }))], v),
      fields: (t, v) => ({ priority: v || null }) },
    owner: { label: 'Owner', sort: 'owner_name', value: (t) => t.owner_id, allowed: (t) => !t.private || owns(t),
      format: (id, t) => personName(id, t),
      // a private project holds only its owner's tasks, so inside one the only owner on offer is the project's
      control: (t, v) => {
        const project = ctx.project?.();
        const list = project?.private ? ctx.people().filter((p) => p.id === project.owner_id) : ctx.people();
        return selectFor(list.map((p) => ({ value: p.id, label: p.name })), v, { missing: t.owner_name });
      },
      confirm: (t, v) => !t.private || v === t.owner_id || confirm(`Hand this private task to ${oneLine(personName(v, t))}?\nIt will be private to them: you will no longer see it, its history, or its comments.`),
      fields: (t, v) => ({ owner_id: v, owner_name: personName(v, t) }) },
    due_date: { label: 'Due', sort: 'due_date', value: (t) => t.due_date, empty: '—',
      control: (t, v) => el('input', { type: 'date', value: v ?? '' }),
      fields: (t, v) => ({ due_date: v || null }),
      after: (t) => (isOverdue(t, config) ? el('b', { class: 'overdue-mark' }, ' (overdue)') : null) },
    // Tag chips save on their own (each attach or detach is its own versioned write).
    tags: { label: 'Tags', view: (t) => tagEditor({ type: 'task', item: t, canEdit: ctx.mayEdit(), compact: true, config, onUpdated: ctx.onUpdated }) },
    private: { label: 'Private', value: (t) => !!t.private, allowed: (t) => owns(t),
      format: (v) => (v ? [padlock(), 'yes'] : 'no'),
      control: (t, v) => el('input', { type: 'checkbox', checked: v }),
      confirm: (t, v) => v || confirm('Make this task public?\nEveryone will see it, and its history becomes visible too.'),
      fields: (t, v) => ({ private: v }) },
    notes: { label: 'Notes', value: (t) => t.notes ?? '', block: true, empty: 'add notes',
      control: (t, v) => el('textarea', { rows: '3', value: v }),
      fields: (t, v) => ({ notes: v }) },
    // progress only ("3/5", with the words for a screen reader); the items are on the task page
    checklist: { label: 'Checklist', view: (t) => {
      const p = checklistProgress(t);
      if (!p) return '—';
      const [done, all] = p.split('/');
      return el('span', { title: `${done} of ${all} checklist items done` }, p, el('span', { class: 'visually-hidden' }, ` (${done} of ${all} done)`));
    } },
    // a count only; the links themselves are on the task page
    links: { label: 'Links', view: (t) => ((t.links ?? []).length ? `${t.links.length} link${t.links.length === 1 ? '' : 's'}` : '—') },
    project: { label: 'Project', view: (t) => projectLink(t.project_id, t.project_name ?? 'project') },
    created_at: { label: 'Created', sort: 'created_at', view: (t) => timeEl(t.created_at) },
    updated_at: { label: 'Updated', sort: 'updated_at', view: (t) => timeEl(t.updated_at) },
  };
}

/**
 * The columns for a list of field names; an unknown field falls back to plain text.
 * @param {Record<string, any>} map  from taskColumns()
 * @param {string[]} fields
 */
export function columnsFor(map, fields) {
  return fields.map((f) => ({ key: f, ...(map[f] ?? { label: f, view: (t) => String(t[f] ?? '') }) }));
}

/**
 * One cell: the read-only view, or a click-to-edit value whose save is one
 * PATCH of that field with the row's version.
 * @param {any} c  a column from columnsFor() @param {any} t @param {ColumnContext} ctx
 */
export function taskCell(c, t, ctx) {
  const after = c.after?.(t) ?? null;
  if (!c.control) return [c.view(t), after];
  return [inlineEdit({
    key: `${ctx.keyPrefix ?? ''}task-${t.id}-${c.key}`, label: c.label, value: c.value(t),
    allowed: ctx.mayEdit() && (c.allowed?.(t) ?? true),
    format: c.format ? (v) => c.format(v, t) : undefined, empty: c.empty, block: c.block,
    control: (v) => c.control(t, v),
    save: async (v) => {
      if (c.confirm && !c.confirm(t, v)) return null;
      return ctx.save(t, c.fields(t, v));
    },
  }), after];
}
