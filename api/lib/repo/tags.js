import { newId } from '../ids.js';
import { notFound } from '../errors.js';
import { rowToTag } from './common.js';
import { record } from './activity.js';

/** @param {string} name */
export function normalizeTagName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** @param {import('../db/index.js').Db} db */
export async function list(db) {
  const { rows } = await db.query('SELECT id, name, color, created_at FROM tags ORDER BY name ASC');
  return rows.map(rowToTag);
}

/** @param {import('../db/index.js').Db} db @param {string} id */
export async function getById(db, id) {
  const { rows } = await db.query('SELECT id, name, color, created_at FROM tags WHERE id = ?', [id]);
  return rows[0] ? rowToTag(rows[0]) : null;
}

/** @param {import('../db/index.js').Db} db @param {string} name  already normalized */
export async function getByName(db, name) {
  const { rows } = await db.query('SELECT id, name, color, created_at FROM tags WHERE name = ?', [name]);
  return rows[0] ? rowToTag(rows[0]) : null;
}

/**
 * Create a tag, or return the existing one with the same normalized name.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{name: string, color?: string}} input
 * @param {import('../config.js').Config} config
 * @param {string} now
 * @returns {Promise<{tag: object, created: boolean}>}
 */
export async function create(db, user, input, config, now) {
  return db.transaction((tx) => createIn(tx, user, input, config, now));
}

/**
 * Must run inside db.transaction(): the activity entry, the row locks and the visible read-back all
 * assume it (pass the `tx` the transaction hands you, never `db`).
 * create() inside a transaction the caller holds.
 * @param {import('../db/index.js').Db} tx
 */
export async function createIn(tx, user, input, config, now) {
  if (!tx.inTransaction) throw new Error('createIn must run inside db.transaction()');
  const name = normalizeTagName(input.name);
  {
    const existing = await getByName(tx, name);
    if (existing) return { tag: existing, created: false };
    let color = input.color;
    if (!color) {
      const { rows } = await tx.query('SELECT COUNT(*) AS n FROM tags');
      const palette = config.tag_palette;
      color = palette[Number(rows[0].n) % palette.length];
    }
    const id = newId();
    await tx.query('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)', [id, name, color, now]);
    await record(tx, user, { item_type: 'tag', item_id: id, action: 'create', changes: { name: { to: name }, color: { to: color } } }, now);
    return { tag: { id, name, color, created_at: now }, created: true };
  }
}

/** Resolve a tag id inside a transaction or throw the generic 404. */
export async function mustExist(tx, id) {
  const tag = await getById(tx, id);
  if (!tag) throw notFound();
  return tag;
}
