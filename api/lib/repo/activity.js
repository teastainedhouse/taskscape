import { newId } from '../ids.js';
import { validationFailed } from '../errors.js';
import { activityVisible, commentVisible, projectVisible, taskVisible } from './visibility.js';

/**
 * Append one activity entry. Always called inside the write's transaction.
 * @param {import('../db/index.js').Db} tx
 * @param {import('../auth/index.js').Principal} user
 * @param {{item_type: 'project'|'task'|'tag'|'comment', item_id: string, action: 'create'|'update'|'trash'|'restore', changes: object}} entry
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
 * A recurring task's entries name the other task of the pair (recurred_to on the close, recurred_from on the copy's
 * create). Replace an id the user cannot see with null, as hideInvisibleProjectIds() does for projects.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {Array<Record<string, {from?: unknown, to?: unknown}>>} changesList
 */
async function hideInvisibleTaskIds(db, user, changesList) {
  const ids = new Set();
  for (const c of changesList) for (const k of ['recurred_to', 'recurred_from']) if (typeof c?.[k]?.to === 'string') ids.add(c[k].to);
  if (ids.size === 0) return;
  const list = [...ids];
  const vis = taskVisible('t', 'p', user);
  const { rows } = await db.query(
    `SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id IN (${list.map(() => '?').join(', ')}) AND ${vis.sql}`,
    [...list, ...vis.params]);
  const visible = new Set(rows.map((r) => r.id));
  for (const c of changesList) for (const k of ['recurred_to', 'recurred_from']) if (typeof c?.[k]?.to === 'string' && !visible.has(c[k].to)) c[k].to = null;
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
  const vis = projectVisible('p', user);
  const { rows } = await db.query(
    `SELECT p.id FROM projects p WHERE p.id IN (${list.map(() => '?').join(', ')}) AND ${vis.sql}`,
    [...list, ...vis.params]);
  const visible = new Set(rows.map((r) => r.id));
  for (const c of changesList) {
    const pid = c?.project_id;
    if (!pid) continue;
    if (typeof pid.from === 'string' && !visible.has(pid.from)) pid.from = null;
    if (typeof pid.to === 'string' && !visible.has(pid.to)) pid.to = null;
  }
}

/**
 * Which of these comments mention the reader, among the live comments the reader can see now (a trashed comment's
 * mentions reach nobody: its words left with it).
 * @param {import('../db/index.js').Db} db @param {import('../auth/index.js').Principal} user @param {string[]} commentIds
 * @returns {Promise<Set<string>>}
 */
async function mentionsOf(db, user, commentIds) {
  if (!commentIds.length) return new Set();
  const vis = commentVisible('c', user);
  const { rows } = await db.query(
    `SELECT m.comment_id FROM comment_mentions m JOIN comments c ON c.id = m.comment_id
      WHERE m.person_id = ? AND c.deleted_at IS NULL AND m.comment_id IN (${commentIds.map(() => '?').join(', ')}) AND ${vis.sql}`,
    [user.id, ...commentIds, ...vis.params]);
  return new Set(rows.map((r) => r.comment_id));
}

/**
 * What's New, newest first, keyset-paginated.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{limit: number, before?: string, item_type?: string, item_id?: string, project?: string, actor?: string, via?: string, for_me?: boolean}} f
 *   for_me: only entries by someone else about a project or task the caller owns now, or the creation of a live comment
 *   that mentions the caller. Either way the entry must be visible now (activityVisible), so a mention of someone who
 *   cannot see the item brings them nothing.
 */
export async function list(db, user, f) {
  const vis = activityVisible('a', user);
  const where = [vis.sql];
  const params = [...vis.params];
  if (f.for_me) {
    // Driven from what the caller owns (the owner indexes, then idx_activity_item), so the
    // badge on every page never scans the whole log.
    where.push(`a.actor_id <> ? AND (
      (a.item_type = 'project' AND a.item_id IN (SELECT fp.id FROM projects fp WHERE fp.owner_id = ?))
      OR (a.item_type = 'task' AND a.item_id IN (SELECT ft.id FROM tasks ft WHERE ft.owner_id = ?))
      OR (a.item_type = 'comment' AND a.item_id IN (
            SELECT fc.id FROM comments fc WHERE (fc.item_type = 'project' AND fc.item_id IN (SELECT fcp.id FROM projects fcp WHERE fcp.owner_id = ?))
                                          OR (fc.item_type = 'task' AND fc.item_id IN (SELECT fct.id FROM tasks fct WHERE fct.owner_id = ?))))
      OR (a.item_type = 'comment' AND a.action = 'create' AND a.item_id IN (
            SELECT fm.comment_id FROM comment_mentions fm JOIN comments fmc ON fmc.id = fm.comment_id WHERE fm.person_id = ? AND fmc.deleted_at IS NULL)))`);
    params.push(user.id, user.id, user.id, user.id, user.id, user.id);
  }
  if (f.item_type) { where.push('a.item_type = ?'); params.push(f.item_type); }
  if (f.item_id) { where.push('a.item_id = ?'); params.push(f.item_id); }
  if (f.actor) { where.push('a.actor_id = ?'); params.push(f.actor); }
  if (f.via) { where.push('a.via = ?'); params.push(f.via); }
  if (f.project) {
    where.push(`((a.item_type = 'project' AND a.item_id = ?) OR (a.item_type = 'task' AND EXISTS (
      SELECT 1 FROM tasks t2 WHERE t2.id = a.item_id AND t2.project_id = ?))
      OR (a.item_type = 'comment' AND EXISTS (
      SELECT 1 FROM comments c2 LEFT JOIN tasks ct2 ON c2.item_type = 'task' AND ct2.id = c2.item_id
       WHERE c2.id = a.item_id AND ((c2.item_type = 'project' AND c2.item_id = ?) OR ct2.project_id = ?))))`);
    params.push(f.project, f.project, f.project, f.project);
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
              WHEN 'comment' THEN (SELECT COALESCE(cp.name, ct.title) FROM comments c
                  LEFT JOIN projects cp ON c.item_type = 'project' AND cp.id = c.item_id
                  LEFT JOIN tasks ct ON c.item_type = 'task' AND ct.id = c.item_id WHERE c.id = a.item_id)
              ELSE (SELECT g.name FROM tags g WHERE g.id = a.item_id) END AS item_title,
            CASE a.item_type
              WHEN 'project' THEN a.item_id
              WHEN 'task' THEN (SELECT t.project_id FROM tasks t WHERE t.id = a.item_id)
              WHEN 'comment' THEN (SELECT COALESCE(cp.id, ct.project_id) FROM comments c
                  LEFT JOIN projects cp ON c.item_type = 'project' AND cp.id = c.item_id
                  LEFT JOIN tasks ct ON c.item_type = 'task' AND ct.id = c.item_id WHERE c.id = a.item_id)
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
  await hideInvisibleTaskIds(db, user, parsed);
  const mentioned = await mentionsOf(db, user, page.filter((r) => r.item_type === 'comment' && r.action === 'create').map((r) => r.item_id));
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
      mentions_you: mentioned.has(r.item_id) && r.item_type === 'comment' && r.action === 'create',
    })),
    next_cursor: rows.length > f.limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
