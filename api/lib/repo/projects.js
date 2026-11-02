import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { notFound, conflict, invalidState, forbidden } from '../errors.js';
import { projectVisible, trashState, likeContains } from './visibility.js';
import { rowToProject, tagsFor, statusOrder, diff } from './common.js';
import { record } from './activity.js';
import * as tags from './tags.js';
import * as people from './people.js';

export const SYSTEM_USER = Object.freeze({ id: 'system', name: 'Taskscape' });
const SETTABLE = ['name', 'description', 'status', 'owner_id', 'owner_name', 'private'];
const SORTS = { updated_at: 'p.updated_at', created_at: 'p.created_at', name: 'LOWER(p.name)', status: null, owner_name: 'LOWER(p.owner_name)' };

/**
 * Create the catch-all project if it does not exist. Called after migrations
 * (scripts/migrate.js, the dev server, and the test helper), never per request.
 * @param {import('../db/index.js').Db} db
 * @param {import('../config.js').Config} config
 * @param {string} [now]  ISO timestamp for created_at/updated_at; tests pass their fake clock
 * @returns {Promise<boolean>} whether it was created now
 */
export async function ensureCatchAll(db, config, now = nowIso()) {
  const { id, name, description = '' } = config.catch_all_project;
  const { rows } = await db.query('SELECT id FROM projects WHERE id = ?', [id]);
  if (rows.length) return false;
  const status = config.statuses.project.includes('Active') ? 'Active' : config.default_status.project;
  await db.query(
    `INSERT INTO projects (id, name, description, status, owner_id, owner_name, private, version, hit_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)`,
    [id, name, description, status, SYSTEM_USER.id, SYSTEM_USER.name, now, now],
  );
  return true;
}

/** Attach tags to a list of row-derived projects. */
async function withTags(db, rows) {
  const map = await tagsFor(db, 'project', rows.map((r) => r.id));
  return rows.map((r) => rowToProject(r, map.get(r.id)));
}

/**
 * Visible read by id (trashed included; the caller decides what trash means).
 * @returns {Promise<object|null>}
 */
export async function get(db, user, id) {
  const vis = projectVisible('p', user);
  const { rows } = await db.query(`SELECT p.* FROM projects p WHERE p.id = ? AND ${vis.sql}`, [id, ...vis.params]);
  if (!rows[0]) return null;
  return (await withTags(db, rows))[0];
}

/** Unfiltered read, for returning a record the caller just wrote and can no longer see. Never exported. */
async function unsafeGet(db, id) {
  const { rows } = await db.query('SELECT p.* FROM projects p WHERE p.id = ?', [id]);
  return rows[0] ? (await withTags(db, rows))[0] : null;
}

/** Visible read or the generic 404. */
export async function mustGet(db, user, id) {
  const p = await get(db, user, id);
  if (!p) throw notFound();
  return p;
}

/**
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{status?: string[], owner?: string, tag?: string[], q?: string, include_trashed: string, sort: string, dir: string, limit: number, offset: number}} f
 * @param {import('../config.js').Config} config
 */
export async function list(db, user, f, config) {
  const vis = projectVisible('p', user);
  const where = [vis.sql, trashState('p', f.include_trashed)];
  const params = [...vis.params];
  if (f.status?.length) { where.push(`p.status IN (${f.status.map(() => '?').join(', ')})`); params.push(...f.status); }
  if (f.owner) { where.push('p.owner_id = ?'); params.push(f.owner === 'me' ? user.id : f.owner); }
  if (f.tag?.length) {
    where.push(`EXISTS (SELECT 1 FROM project_tags j JOIN tags g ON g.id = j.tag_id WHERE j.project_id = p.id AND g.name IN (${f.tag.map(() => '?').join(', ')}))`);
    params.push(...f.tag.map(tags.normalizeTagName));
  }
  if (f.q) { where.push("(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.description) LIKE ? ESCAPE '\\')"); const l = likeContains(f.q); params.push(l, l); }
  let order;
  if (f.sort === 'status') { const so = statusOrder(config.statuses.project, 'p.status'); order = `${so.sql} ${f.dir}`; params.push(...so.params); }
  else order = `${SORTS[f.sort]} ${f.dir}`;
  params.push(f.limit, f.offset);
  const { rows } = await db.query(
    `SELECT p.* FROM projects p WHERE ${where.join(' AND ')} ORDER BY ${order}, p.id ASC LIMIT ? OFFSET ?`, params);
  return withTags(db, rows);
}

/**
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{name: string, description?: string, status?: string, owner_id?: string, owner_name?: string, private?: boolean, tag_ids?: string[]}} input
 * @param {import('../config.js').Config} config
 * @param {string} now
 */
export async function create(db, user, input, config, now) {
  return db.transaction((tx) => createIn(tx, user, input, config, now));
}

/**
 * Must run inside db.transaction(): the activity entry, the row locks and the visible read-back all
 * assume it (pass the `tx` the transaction hands you, never `db`).
 * create() inside a transaction the caller holds (the import makes a project and its tasks in one).
 * @param {import('../db/index.js').Db} tx
 */
export async function createIn(tx, user, input, config, now) {
  if (!tx.inTransaction) throw new Error('createIn must run inside db.transaction()');
  const id = input.id ?? newId();
  const ownerId = input.owner_id ?? user.id;
  const row = {
    id, name: input.name, description: input.description ?? '', status: input.status ?? config.default_status.project,
    owner_id: ownerId, owner_name: user.name, private: input.private ?? config.privacy.default_private,
  };
  if (row.private && row.owner_id !== user.id) throw invalidState('Only the owner can make an item private. Create it as yourself or public.');
  {
    const tagList = [];
    for (const tagId of input.tag_ids ?? []) tagList.push(await tags.mustExist(tx, tagId));
    if (ownerId !== user.id) row.owner_name = await people.ownerNameFor(tx, config, ownerId, input.owner_name); // last check: see people.js
    await tx.query(
      `INSERT INTO projects (id, name, description, status, owner_id, owner_name, private, version, hit_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [id, row.name, row.description, row.status, row.owner_id, row.owner_name, row.private, now, now]);
    for (const tag of tagList) await tx.query('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)', [id, tag.id]);
    const tagNames = tagList.map((tag) => tag.name);
    const changes = Object.fromEntries(SETTABLE.map((k) => [k, { to: row[k] }]));
    if (tagNames.length) changes.tags = { to: tagNames.sort() };
    await record(tx, user, { item_type: 'project', item_id: id, action: 'create', changes }, now);
    return mustGet(tx, user, id);
  }
}

/**
 * Move every task in `project` owned by someone other than the project's
 * owner to the catch-all. Used when a project becomes private or changes
 * owner while private. With `keepHidden` (the project was already private, so
 * nobody else could see its tasks) a moved task also becomes private, so the
 * move never shows it to anyone new. Returns how many moved.
 * @param {{keepHidden?: boolean}} [opts]
 */
async function moveForeignTasks(tx, user, project, config, now, { keepHidden = false } = {}) {
  const catchAll = config.catch_all_project.id;
  if (project.id === catchAll) return 0;
  const { rows } = await tx.query('SELECT id, owner_id, private FROM tasks WHERE project_id = ? AND owner_id <> ?', [project.id, project.owner_id]);
  for (const t of rows) {
    // always set under keepHidden, not only when the read above saw 0: the read takes no lock, and the owner's
    // concurrent PATCH could make the task public in between (PostgreSQL); the entry follows the read
    const hide = keepHidden && Number(t.private) === 0;
    await tx.query(`UPDATE tasks SET project_id = ?,${keepHidden ? ' private = 1,' : ''} version = version + 1, updated_at = ? WHERE id = ?`, [catchAll, now, t.id]);
    const changes = { project_id: { from: project.id, to: catchAll }, ...(hide ? { private: { from: false, to: true } } : {}) };
    await record(tx, user, { item_type: 'task', item_id: t.id, action: 'update', changes }, now);
  }
  // Every foreign task moves, but the count reported back never reveals tasks the caller could not see.
  return rows.filter((t) => Number(t.private) === 0 || t.owner_id === user.id).length;
}

/**
 * Compare-and-set. Throws 409 with the current visible record, or 404 if it vanished.
 * With `setSql` null it only checks the version, under the row lock, and bumps nothing:
 * a request that would change nothing is not a write (docs/PLAN.md §2 rule 11).
 */
async function cas(tx, user, id, version, setSql, setParams = []) {
  const set = setSql === null ? 'version = version' : `${setSql}, version = version + 1`;
  const { changes } = await tx.query(
    `UPDATE projects SET ${set} WHERE id = ? AND version = ?`, [...setParams, id, version]);
  if (changes === 0) {
    const current = await get(tx, user, id);
    if (!current) throw notFound();
    throw conflict(current);
  }
}

/**
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {string} id
 * @param {{version: number} & Partial<{name: string, description: string, status: string, owner_id: string, owner_name: string, private: boolean}>} input
 * @param {import('../config.js').Config} config
 * @param {string} now
 * @returns {Promise<{project: object, moved_tasks?: number}>}
 */
export async function update(db, user, id, input, config, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This project is in the trash. Restore it before editing.');
    const isCatchAll = id === config.catch_all_project.id;
    const next = { ...before };
    for (const k of SETTABLE) if (input[k] !== undefined) next[k] = input[k];
    if (next.private !== before.private) {
      if (isCatchAll) throw invalidState('The catch-all project is always public.');
      if (before.owner_id !== user.id) throw forbidden('Only the owner can change whether a project is private.');
      if (next.private && next.owner_id !== user.id) throw invalidState('Only the owner can make an item private. Make it private first, then hand it over.');
    }
    if (next.owner_id !== before.owner_id) {
      if (isCatchAll) throw invalidState('The catch-all project cannot be reassigned.');
      if (next.owner_id === user.id) next.owner_name = user.name;
    } else if (before.owner_id === user.id) {
      next.owner_name = user.name; // refresh the display-name snapshot
    }
    if (before.version !== input.version) throw conflict(before); // so `before` is the row the locked version check approves
    if (input.owner_id !== undefined && input.owner_id !== user.id) { // last check: see people.js
      next.owner_name = await people.ownerNameFor(tx, config, input.owner_id, input.owner_name);
    }
    const changes = diff(before, next, SETTABLE);
    if (Object.keys(changes).length === 0) { // no stored value would change, so not a write: check the version only
      await cas(tx, user, id, input.version, null);
      return { project: await mustGet(tx, user, id) };
    }
    // The owner's own name refresh rides along silently, and is logged only when it is the whole change.
    if (changes.owner_name && !changes.owner_id && before.owner_id === user.id && Object.keys(changes).length > 1) delete changes.owner_name;
    await cas(tx, user, id, input.version,
      'name = ?, description = ?, status = ?, owner_id = ?, owner_name = ?, private = ?, updated_at = ?',
      [next.name, next.description, next.status, next.owner_id, next.owner_name, next.private, now]);
    await record(tx, user, { item_type: 'project', item_id: id, action: 'update', changes }, now);
    const after = { ...before, ...next, owner_id: next.owner_id };
    let moved;
    if (after.private && (next.private !== before.private || next.owner_id !== before.owner_id)) {
      moved = await moveForeignTasks(tx, user, after, config, now, { keepHidden: !!before.private });
    }
    const project = await unsafeGet(tx, id); // the writer sees the result once, even if it is now someone else's private project
    return next.private !== before.private && next.private ? { project, moved_tasks: moved ?? 0 } : { project, ...(moved !== undefined ? { moved_tasks: moved } : {}) };
  });
}

export async function trash(db, user, id, version, config, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (id === config.catch_all_project.id) throw invalidState('The catch-all project cannot be trashed.');
    if (before.deleted_at) throw invalidState('This project is already in the trash.');
    await cas(tx, user, id, version, 'deleted_at = ?, updated_at = ?', [now, now]);
    await record(tx, user, { item_type: 'project', item_id: id, action: 'trash', changes: {} }, now);
    return mustGet(tx, user, id);
  });
}

export async function restore(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (!before.deleted_at) throw invalidState('This project is not in the trash.');
    await cas(tx, user, id, version, 'deleted_at = NULL, updated_at = ?', [now]);
    await record(tx, user, { item_type: 'project', item_id: id, action: 'restore', changes: {} }, now);
    return mustGet(tx, user, id);
  });
}

/** Attach or detach a tag; idempotent. A request that changes nothing bumps nothing and logs nothing. */
export async function setTag(db, user, id, tagId, version, attach, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This project is in the trash.');
    await tags.mustExist(tx, tagId);
    if (before.version !== version) throw conflict(before); // the no-op decision below reads `before`
    if (before.tags.some((t) => t.id === tagId) === attach) {
      await cas(tx, user, id, version, null); // already as asked: check the version, write nothing
      return mustGet(tx, user, id);
    }
    await cas(tx, user, id, version, 'updated_at = ?', [now]);
    if (attach) await tx.query('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)', [id, tagId]);
    else await tx.query('DELETE FROM project_tags WHERE project_id = ? AND tag_id = ?', [id, tagId]);
    const after = await mustGet(tx, user, id);
    const changes = { tags: { from: before.tags.map((t) => t.name), to: after.tags.map((t) => t.name) } };
    await record(tx, user, { item_type: 'project', item_id: id, action: 'update', changes }, now);
    return after;
  });
}

/** Count a page view. Not version-checked, not logged. */
export async function recordHit(db, user, id) {
  return db.transaction(async (tx) => {
    const p = await mustGet(tx, user, id);
    if (p.deleted_at) throw invalidState('This project is in the trash.');
    await tx.query('UPDATE projects SET hit_count = hit_count + 1 WHERE id = ?', [id]);
    const { rows } = await tx.query('SELECT hit_count FROM projects WHERE id = ?', [id]);
    return { project_id: id, hit_count: Number(rows[0].hit_count) };
  });
}
