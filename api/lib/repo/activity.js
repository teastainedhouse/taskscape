import { newId } from '../ids.js';
import { validationFailed } from '../errors.js';

/**
 * Append one activity entry. Always called inside the write's transaction.
 * @param {import('../db/index.js').Db} tx
 * @param {import('../auth/index.js').Principal} user
 * @param {{item_type: 'project'|'task'|'tag', item_id: string, action: 'create'|'update'|'trash'|'restore', changes: object}} entry
 * @param {string} now
 */
export async function record(tx, user, entry, now) {
  await tx.query(
    `INSERT INTO activity (id, created_at, actor_id, actor_name, via, session_id, item_type, item_id, action, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), now, user.id, user.name, user.via, user.session_id ?? null, entry.item_type, entry.item_id, entry.action,
      JSON.stringify(entry.changes ?? {})],
  );
}

/** @param {string} created_at @param {string} id */
export function encodeCursor(created_at, id) {
  return Buffer.from(`${created_at}|${id}`, 'utf8').toString('base64url');
}

/** @param {string} cursor @returns {{created_at: string, id: string}} */
export function decodeCursor(cursor) {
  let text;
  try { text = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { text = ''; }
  const i = text.indexOf('|');
  if (i <= 0) throw validationFailed({ before: 'is not a valid cursor' });
  return { created_at: text.slice(0, i), id: text.slice(i + 1) };
}

/**
 * The visibility predicate for activity: an entry is visible when the item
 * it is about is visible NOW (so flipping private hides history).
 * @param {import('../auth/index.js').Principal} user
 */
function visibleEntries(user) {
  return {
    sql: `(a.item_type = 'tag'
      OR (a.item_type = 'project' AND EXISTS (
            SELECT 1 FROM projects p WHERE p.id = a.item_id AND (p.private = 0 OR p.owner_id = ?)))
      OR (a.item_type = 'task' AND EXISTS (
            SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
             WHERE t.id = a.item_id AND (t.private = 0 OR t.owner_id = ?) AND (p.private = 0 OR p.owner_id = ?))))`,
    params: [user.id, user.id, user.id],
  };
}

/**
 * A task's history may name a project (create, move) that has since gone
 * private. Replace such ids with null so no trace of the private project
 * reaches anyone but its owner.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {Array<Record<string, {from?: unknown, to?: unknown}>>} changesList
 */
async function hideInvisibleProjectIds(db, user, changesList) {
  const ids = new Set();
  for (const c of changesList) {
    const pid = c?.project_id;
    if (!pid) continue;
    for (const v of [pid.from, pid.to]) if (typeof v === 'string') ids.add(v);
  }
  if (ids.size === 0) return;
  const list = [...ids];
  const { rows } = await db.query(
    `SELECT p.id FROM projects p WHERE p.id IN (${list.map(() => '?').join(', ')}) AND (p.private = 0 OR p.owner_id = ?)`,
    [...list, user.id]);
  const visible = new Set(rows.map((r) => r.id));
  for (const c of changesList) {
    const pid = c?.project_id;
    if (!pid) continue;
    if (typeof pid.from === 'string' && !visible.has(pid.from)) pid.from = null;
    if (typeof pid.to === 'string' && !visible.has(pid.to)) pid.to = null;
  }
}

/**
 * What's New, newest first, keyset-paginated.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{limit: number, before?: string, item_type?: string, item_id?: string, project?: string, actor?: string, via?: string}} f
 */
export async function list(db, user, f) {
  const vis = visibleEntries(user);
  const where = [vis.sql];
  const params = [...vis.params];
  if (f.item_type) { where.push('a.item_type = ?'); params.push(f.item_type); }
  if (f.item_id) { where.push('a.item_id = ?'); params.push(f.item_id); }
  if (f.actor) { where.push('a.actor_id = ?'); params.push(f.actor); }
  if (f.via) { where.push('a.via = ?'); params.push(f.via); }
  if (f.project) {
    where.push(`((a.item_type = 'project' AND a.item_id = ?) OR (a.item_type = 'task' AND EXISTS (
      SELECT 1 FROM tasks t2 WHERE t2.id = a.item_id AND t2.project_id = ?)))`);
    params.push(f.project, f.project);
  }
  if (f.before) {
    const c = decodeCursor(f.before);
    where.push('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))');
    params.push(c.created_at, c.created_at, c.id);
  }
  params.push(f.limit + 1);
  const { rows } = await db.query(
    `SELECT a.*,
            CASE a.item_type
              WHEN 'project' THEN (SELECT p.name FROM projects p WHERE p.id = a.item_id)
              WHEN 'task' THEN (SELECT t.title FROM tasks t WHERE t.id = a.item_id)
              ELSE (SELECT g.name FROM tags g WHERE g.id = a.item_id) END AS item_title,
            CASE a.item_type
              WHEN 'project' THEN a.item_id
              WHEN 'task' THEN (SELECT t.project_id FROM tasks t WHERE t.id = a.item_id)
              ELSE NULL END AS project_id
       FROM activity a
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    params,
  );
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  const parsed = page.map((r) => JSON.parse(r.changes));
  await hideInvisibleProjectIds(db, user, parsed);
  return {
    items: page.map((r, i) => ({
      id: r.id,
      created_at: r.created_at,
      actor_id: r.actor_id,
      actor_name: r.actor_name,
      via: r.via,
      session_id: r.session_id ?? null,
      item_type: r.item_type,
      item_id: r.item_id,
      item_title: r.item_title ?? null,
      project_id: r.project_id ?? null,
      action: r.action,
      changes: parsed[i],
    })),
    next_cursor: rows.length > f.limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
