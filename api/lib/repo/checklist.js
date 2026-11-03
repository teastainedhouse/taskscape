/**
 * Checklist items on a task (table task_checklist_items): text, a done flag,
 * a position. Lightweight subtasks, so they belong to the task the way links
 * do: no privacy or version of their own, read only for task ids already read
 * through visibility.js, and every write goes through tasks.childWrite() (a
 * compare-and-set on the task's version with an activity entry on the task,
 * in one transaction). Removing an item trashes it (deleted_at).
 */
import { newId } from '../ids.js';
import { notFound, invalidState } from '../errors.js';
import * as tasks from './tasks.js';
import { taskVisible } from './visibility.js';

/** The most live items one task's checklist holds. */
export const MAX_ITEMS = 100;

/** @param {Record<string, unknown>} r */
function rowToItem(r) {
  return { id: r.id, text: r.text, done: r.done === 1 || r.done === true || r.done === '1', position: Number(r.position) };
}

/**
 * Live items for tasks the user can see, in position order (the task's visibility is applied here too).
 * @param {import('../db/index.js').Db} db
 * @param {{id: string}} user
 * @param {string[]} ids
 * @returns {Promise<Map<string, object[]>>}
 */
export async function checklistFor(db, user, ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const vis = taskVisible('t', 'p', user);
  const { rows } = await db.query(
    `SELECT c.id, c.task_id, c.text, c.done, c.position FROM task_checklist_items c
       JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
      WHERE c.task_id IN (${ids.map(() => '?').join(', ')}) AND c.deleted_at IS NULL AND ${vis.sql}
      ORDER BY c.position ASC, c.created_at ASC, c.id ASC`, [...ids, ...vis.params]);
  for (const r of rows) map.get(r.task_id)?.push(rowToItem(r));
  return map;
}

/** The item as the activity log names it. @param {{text: string, done: boolean}} i */
const named = (i) => ({ text: i.text, done: !!i.done });

/** Rewrite live positions 0..n-1 in the given order (childWrite holds the task's row lock, so writes to one task's checklist queue). */
async function renumber(tx, ids) {
  for (let i = 0; i < ids.length; i++) await tx.query('UPDATE task_checklist_items SET position = ? WHERE id = ?', [i, ids[i]]);
}

/** Add an unticked item at the end. @param {{text: string}} input  validated */
export async function add(db, user, taskId, version, input, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    if (task.checklist.length >= MAX_ITEMS) throw invalidState(`A checklist holds at most ${MAX_ITEMS} items.`);
    const done = input.done === true;
    await tx.query('INSERT INTO task_checklist_items (id, task_id, text, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), taskId, input.text, done, task.checklist.length, now, now]);
    return { checklist_item: { from: null, to: named({ text: input.text, done }) } };
  });
}

/**
 * Rename, tick or untick an item, or move it to `position` among the live items.
 * @param {Partial<{text: string, done: boolean, position: number}>} input  validated
 */
export async function update(db, user, taskId, itemId, version, input, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    const i = task.checklist.findIndex((x) => x.id === itemId);
    if (i < 0) throw notFound();
    const before = task.checklist[i];
    const next = { ...before, ...('text' in input ? { text: input.text } : {}), ...('done' in input ? { done: input.done } : {}) };
    const changes = {};
    if (next.text !== before.text || next.done !== before.done) {
      await tx.query('UPDATE task_checklist_items SET text = ?, done = ?, updated_at = ? WHERE id = ?', [next.text, next.done, now, itemId]);
      changes.checklist_item = { from: named(before), to: named(next) };
    }
    if (input.position !== undefined) {
      const to = Math.min(input.position, task.checklist.length - 1);
      if (to !== i) {
        const order = task.checklist.map((x) => x.id);
        order.splice(i, 1);
        order.splice(to, 0, itemId);
        await renumber(tx, order);
        changes.checklist_moved = { from: i, to, item: named(next) };
      }
    }
    return Object.keys(changes).length ? changes : null;
  });
}

/** Trash one item (kept with deleted_at; the activity entry names it). */
export async function trash(db, user, taskId, itemId, version, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    const item = task.checklist.find((x) => x.id === itemId);
    if (!item) throw notFound();
    await tx.query('UPDATE task_checklist_items SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, itemId]);
    await renumber(tx, task.checklist.filter((x) => x.id !== itemId).map((x) => x.id));
    return { checklist_item: { from: named(item), to: null } };
  });
}

/**
 * Copy items onto a task being created in the same transaction (the import); the task must be one the user can see.
 * @param {import('../db/index.js').Db} tx @param {{id: string}} user @param {string} taskId
 * @param {Array<{text: string, done?: boolean}>} list @param {string} now
 */
export async function insertIn(tx, user, taskId, list, now) {
  if (!tx.inTransaction) throw new Error('insertIn must run inside db.transaction()');
  if (!list.length) return;
  if (!(await tasks.get(tx, user, taskId))) throw notFound();
  for (let i = 0; i < list.length; i++) {
    await tx.query('INSERT INTO task_checklist_items (id, task_id, text, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), taskId, list[i].text, list[i].done === true, i, now, now]);
  }
}
