// Guestbook comments on a project or a task. A comment has no privacy of its
// own: it is visible exactly when its parent is (visibility.js), and once
// trashed only to its author. Editors add them; nobody edits them; only the
// author trashes and restores them, each a compare-and-set on version with an
// activity entry in the same transaction. Activity entries name the parent,
// never the text, so a trashed comment's words leave the feed with it.

import { newId } from '../ids.js';
import { notFound, conflict, invalidState, forbidden } from '../errors.js';
import { commentVisible, commentShown } from './visibility.js';
import { record } from './activity.js';
import * as projects from './projects.js';
import * as tasks from './tasks.js';

const SELECT = 'SELECT c.* FROM comments c';

/** Live comments one guestbook holds at most, so no one can flood an item, its export, or a reader's context. */
export const MAX_PER_GUESTBOOK = 500;

/** @param {Record<string, any>} r */
function rowToComment(r) {
  return {
    id: r.id,
    item_type: r.item_type,
    item_id: r.item_id,
    author_id: r.author_id,
    author_name: r.author_name,
    body: r.body,
    version: Number(r.version),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
  };
}

/** The comment's parent, as the activity entry names it. @param {{item_type: string, item_id: string}} c */
const on = (c) => ({ on: { type: c.item_type, id: c.item_id } });

/**
 * The visible parent, or 404. With `lock`, the parent row (and a task's
 * project) is locked first, so a privacy flip or trash cannot slip in between
 * this check and the write. Projects are locked before tasks, the order a
 * privacy flip takes, so the two do not deadlock on PostgreSQL. The task's
 * project is locked again after the read in case the task moved meanwhile
 * (only that rare race takes the locks out of order).
 * @param {import('../db/index.js').Db} db @param {any} user
 * @param {'project'|'task'} type @param {string} id @param {{lock?: boolean}} [opts]
 * @returns {Promise<{record: any, trashed: 'project'|'task'|null}>}  trashed names what is in the trash, if anything
 */
async function parent(db, user, type, id, { lock = false } = {}) {
  if (type === 'project') {
    if (lock) await db.query('UPDATE projects SET version = version WHERE id = ?', [id]);
    const p = await projects.mustGet(db, user, id);
    return { record: p, trashed: p.deleted_at ? 'project' : null };
  }
  if (lock) {
    await db.query('UPDATE projects SET version = version WHERE id = (SELECT project_id FROM tasks WHERE id = ?)', [id]);
    await db.query('UPDATE tasks SET version = version WHERE id = ?', [id]);
  }
  const t = await tasks.mustGet(db, user, id);
  if (lock) await db.query('UPDATE projects SET version = version WHERE id = ?', [t.project_id]);
  const p = await projects.mustGet(db, user, t.project_id);
  return { record: t, trashed: p.deleted_at ? 'project' : t.deleted_at ? 'task' : null };
}

/**
 * The guestbook of a visible project or task, oldest first: live comments,
 * plus the caller's own trashed ones (so they can restore them).
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string} id
 */
export async function listFor(db, user, type, id) {
  await parent(db, user, type, id);
  const vis = commentVisible('c', user);
  const shown = commentShown('c', user);
  const { rows } = await db.query(
    `${SELECT} WHERE c.item_type = ? AND c.item_id = ? AND ${vis.sql} AND ${shown.sql} ORDER BY c.created_at ASC, c.id ASC`,
    [type, id, ...vis.params, ...shown.params]);
  return rows.map(rowToComment);
}

/**
 * Live comments on many parents of one type, for the export. Trashed ones stay
 * out, even the caller's own.
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string[]} ids
 * @returns {Promise<Map<string, any[]>>} parent id -> comments, oldest first
 */
export async function liveFor(db, user, type, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const vis = commentVisible('c', user);
  const { rows } = await db.query(
    `${SELECT} WHERE c.item_type = ? AND c.item_id IN (${ids.map(() => '?').join(', ')}) AND c.deleted_at IS NULL AND ${vis.sql}
      ORDER BY c.created_at ASC, c.id ASC`,
    [type, ...ids, ...vis.params]);
  for (const r of rows) {
    if (!out.has(r.item_id)) out.set(r.item_id, []);
    out.get(r.item_id).push(rowToComment(r));
  }
  return out;
}

/** Visible read by id. @param {import('../db/index.js').Db} db @param {any} user @param {string} id */
export async function get(db, user, id) {
  const vis = commentVisible('c', user);
  const shown = commentShown('c', user);
  const { rows } = await db.query(`${SELECT} WHERE c.id = ? AND ${vis.sql} AND ${shown.sql}`, [id, ...vis.params, ...shown.params]);
  return rows[0] ? rowToComment(rows[0]) : null;
}

/** @param {import('../db/index.js').Db} db @param {any} user @param {string} id */
export async function mustGet(db, user, id) {
  const c = await get(db, user, id);
  if (!c) throw notFound();
  return c;
}

/**
 * @param {import('../db/index.js').Db} tx @param {any} user @param {string} id @param {number} version
 * @param {string} setSql @param {unknown[]} setParams
 */
async function cas(tx, user, id, version, setSql, setParams) {
  const { changes } = await tx.query(
    `UPDATE comments SET ${setSql}, version = version + 1 WHERE id = ? AND version = ?`, [...setParams, id, version]);
  if (changes === 0) {
    const current = await get(tx, user, id);
    if (!current) throw notFound();
    throw conflict(current);
  }
}

/**
 * Sign the guestbook of a visible, live project or task.
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string} parentId
 * @param {string} body @param {string} now
 */
export async function create(db, user, type, parentId, body, now) {
  return db.transaction(async (tx) => {
    const { trashed } = await parent(tx, user, type, parentId, { lock: true });
    if (trashed) throw invalidState(`This ${trashed} is in the trash.`);
    await full(tx, type, parentId);
    const id = newId();
    await tx.query(
      `INSERT INTO comments (id, item_type, item_id, author_id, author_name, body, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      [id, type, parentId, user.id, user.name, body, now, now]);
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'create', changes: on({ item_type: type, item_id: parentId }) }, now);
    return mustGet(tx, user, id);
  });
}

/** Refuse a write that would put the guestbook over MAX_PER_GUESTBOOK live comments; the parent is locked and visible. */
async function full(tx, type, parentId) {
  const { rows } = await tx.query('SELECT COUNT(*) AS n FROM comments WHERE item_type = ? AND item_id = ? AND deleted_at IS NULL', [type, parentId]);
  if (Number(rows[0].n) >= MAX_PER_GUESTBOOK) throw invalidState('This guestbook is full.');
}

/**
 * Move one's own comment to the trash.
 * @param {import('../db/index.js').Db} db @param {any} user @param {string} id @param {number} version @param {string} now
 */
export async function trash(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.author_id !== user.id) throw forbidden('Only the author can trash a comment.');
    if (before.deleted_at) throw invalidState('This comment is already in the trash.');
    await cas(tx, user, id, version, 'deleted_at = ?, updated_at = ?', [now, now]);
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'trash', changes: on(before) }, now);
    return mustGet(tx, user, id);
  });
}

/**
 * Bring one's own comment back, while its parent is live.
 * @param {import('../db/index.js').Db} db @param {any} user @param {string} id @param {number} version @param {string} now
 */
export async function restore(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.author_id !== user.id) throw forbidden('Only the author can restore a comment.');
    if (!before.deleted_at) throw invalidState('This comment is not in the trash.');
    const { trashed } = await parent(tx, user, before.item_type, before.item_id, { lock: true });
    if (trashed) throw invalidState(`Restore the ${trashed} first.`);
    await full(tx, before.item_type, before.item_id);
    await cas(tx, user, id, version, 'deleted_at = NULL, updated_at = ?', [now]);
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'restore', changes: on(before) }, now);
    return mustGet(tx, user, id);
  });
}
