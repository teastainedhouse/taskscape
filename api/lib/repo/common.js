/** Row -> API shape helpers shared by the repos. */

/** @param {unknown} v */
const bool = (v) => v === 1 || v === true || v === '1';

/** @param {Record<string, unknown>} r @param {Array<object>} tags */
export function rowToProject(r, tags = []) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    status: r.status,
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    private: bool(r.private),
    version: Number(r.version),
    hit_count: Number(r.hit_count ?? 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
    tags,
  };
}

/** @param {Record<string, unknown>} r @param {Array<object>} tags */
export function rowToTask(r, tags = []) {
  return {
    id: r.id,
    project_id: r.project_id,
    project_name: r.project_name ?? null,
    title: r.title,
    status: r.status,
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    private: bool(r.private),
    due_date: r.due_date ?? null,
    notes: r.notes ?? '',
    version: Number(r.version),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
    tags,
  };
}

/** @param {Record<string, unknown>} r */
export function rowToTag(r) {
  return { id: r.id, name: r.name, color: r.color, created_at: r.created_at };
}

/**
 * Tags for a set of already-filtered item ids.
 * @param {import('../db/index.js').Db} db
 * @param {'project'|'task'} kind
 * @param {string[]} ids
 * @returns {Promise<Map<string, object[]>>}
 */
export async function tagsFor(db, kind, ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const join = kind === 'project' ? 'project_tags' : 'task_tags';
  const col = kind === 'project' ? 'project_id' : 'task_id';
  const marks = ids.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT j.${col} AS item_id, g.id, g.name, g.color, g.created_at
       FROM ${join} j JOIN tags g ON g.id = j.tag_id
      WHERE j.${col} IN (${marks})
      ORDER BY g.name ASC`,
    ids,
  );
  for (const r of rows) map.get(r.item_id)?.push(rowToTag(r));
  return map;
}

/** @param {string[]} order @param {string} col @returns {{sql: string, params: string[]}} */
export function statusOrder(order, col) {
  if (order.length === 0) return { sql: '0', params: [] };
  const whens = order.map((_, i) => `WHEN ? THEN ${i}`).join(' ');
  return { sql: `CASE ${col} ${whens} ELSE ${order.length} END`, params: [...order] };
}

/**
 * Diff two flat records over `fields`, as the activity log stores it.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string[]} fields
 */
export function diff(before, after, fields) {
  /** @type {Record<string, {from: unknown, to: unknown}>} */
  const out = {};
  for (const f of fields) {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a, to: b };
  }
  return out;
}
