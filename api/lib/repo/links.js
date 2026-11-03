/**
 * Web links on a task (table task_links): a URL, an optional label, a position.
 * A link has no privacy of its own: it shows exactly when its task does,
 * because every read here is for task ids the caller has already read
 * through visibility.js, and every write goes through tasks.childWrite(),
 * which reads the task visibly, checks and bumps the task's version, and
 * records the activity entry in the same transaction (like tag attach and
 * detach). Removing a link trashes it (deleted_at); nothing hard-deletes one.
 * The server never fetches a URL.
 */
import { newId } from '../ids.js';
import { notFound, invalidState } from '../errors.js';
import * as tasks from './tasks.js';
import { taskVisible } from './visibility.js';

/** The most live links one task holds. */
export const MAX_LINKS = 50;

/** @param {Record<string, unknown>} r */
function rowToLink(r) {
  return { id: r.id, url: r.url, label: r.label ?? null, position: Number(r.position) };
}

/**
 * Live links for tasks the user can see, in position order. The task's visibility is applied here too, not
 * only by the caller, so no future caller can hand it a hidden task's id.
 * @param {import('../db/index.js').Db} db
 * @param {{id: string}} user
 * @param {string[]} ids
 * @returns {Promise<Map<string, object[]>>}
 */
export async function linksFor(db, user, ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const vis = taskVisible('t', 'p', user);
  const { rows } = await db.query(
    `SELECT l.id, l.task_id, l.url, l.label, l.position FROM task_links l
       JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id
      WHERE l.task_id IN (${ids.map(() => '?').join(', ')}) AND l.deleted_at IS NULL AND ${vis.sql}
      ORDER BY l.position ASC, l.created_at ASC, l.id ASC`, [...ids, ...vis.params]);
  for (const r of rows) map.get(r.task_id)?.push(rowToLink(r));
  return map;
}

/** The link as the activity log names it. @param {{url: string, label: string|null}} l */
const named = (l) => ({ url: l.url, label: l.label ?? null });

/**
 * Rewrite live positions 0..n-1 in the given order (childWrite holds the task's row lock, so writes to one task's links queue).
 * @param {import('../db/index.js').Db} tx @param {string[]} ids
 */
async function renumber(tx, ids) {
  for (let i = 0; i < ids.length; i++) await tx.query('UPDATE task_links SET position = ? WHERE id = ?', [i, ids[i]]);
}

/**
 * Add a link at the end.
 * @param {{url: string, label: string|null}} input  validated
 */
export async function add(db, user, taskId, version, input, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    if (task.links.length >= MAX_LINKS) throw invalidState(`A task holds at most ${MAX_LINKS} links.`);
    await tx.query('INSERT INTO task_links (id, task_id, url, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), taskId, input.url, input.label, task.links.length, now, now]);
    return { link: { from: null, to: named(input) } };
  });
}

/**
 * Change a link's URL or label, or move it to `position` among the live links.
 * @param {Partial<{url: string, label: string|null, position: number}>} input  validated
 */
export async function update(db, user, taskId, linkId, version, input, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    const i = task.links.findIndex((l) => l.id === linkId);
    if (i < 0) throw notFound();
    const before = task.links[i];
    const next = { ...before, ...('url' in input ? { url: input.url } : {}), ...('label' in input ? { label: input.label } : {}) };
    const changes = {};
    if (next.url !== before.url || next.label !== before.label) {
      await tx.query('UPDATE task_links SET url = ?, label = ?, updated_at = ? WHERE id = ?', [next.url, next.label, now, linkId]);
      changes.link = { from: named(before), to: named(next) };
    }
    if (input.position !== undefined) {
      const to = Math.min(input.position, task.links.length - 1);
      if (to !== i) {
        const order = task.links.map((l) => l.id);
        order.splice(i, 1);
        order.splice(to, 0, linkId);
        await renumber(tx, order);
        changes.link_moved = { from: i, to, link: named(next) };
      }
    }
    return Object.keys(changes).length ? changes : null;
  });
}

/** Trash one link (it stays in the table with deleted_at; the activity entry names it). */
export async function trash(db, user, taskId, linkId, version, now) {
  return tasks.childWrite(db, user, taskId, version, now, async (tx, task) => {
    const link = task.links.find((l) => l.id === linkId);
    if (!link) throw notFound();
    await tx.query('UPDATE task_links SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, linkId]);
    await renumber(tx, task.links.filter((l) => l.id !== linkId).map((l) => l.id));
    return { link: { from: named(link), to: null } };
  });
}

/**
 * Copy links onto a task being created in the same transaction (the import).
 * The caller has just created `taskId` with its own activity entry, which lists these links; the task must be
 * one the user can see (the creator always can), else this throws the generic 404 and the transaction rolls back.
 * @param {import('../db/index.js').Db} tx @param {{id: string}} user @param {string} taskId
 * @param {Array<{url: string, label: string|null}>} list @param {string} now
 */
export async function insertIn(tx, user, taskId, list, now) {
  if (!tx.inTransaction) throw new Error('insertIn must run inside db.transaction()');
  if (!list.length) return;
  if (!(await tasks.get(tx, user, taskId))) throw notFound();
  for (let i = 0; i < list.length; i++) {
    await tx.query('INSERT INTO task_links (id, task_id, url, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), taskId, list[i].url, list[i].label ?? null, i, now, now]);
  }
}
