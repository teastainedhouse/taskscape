import * as feeds from './feeds.js';
import * as sessions from './sessions.js';
import * as tokens from './tokens.js';

/** @param {unknown} json @returns {string[]} */
function parseGroups(json) {
  try { const v = JSON.parse(typeof json === 'string' ? json : '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Never includes the password hash. */
const shape = (r) => ({
  id: r.id, name: r.name, email: r.email ?? null, groups: parseGroups(r.groups),
  created_at: r.created_at, updated_at: r.updated_at, disabled_at: r.disabled_at ?? null,
});

const COLUMNS = 'id, name, email, groups, created_at, updated_at, disabled_at';

/** @param {import('../db/index.js').Db} db @param {string} id */
export async function get(db, id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * Every enabled user as `{id, name}`, for the people picker. Disabled users and the
 * reserved `system` id are left out. Directory facts only: nothing about items.
 * @param {import('../db/index.js').Db} db
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function listEnabled(db) {
  const { rows } = await db.query("SELECT id, name FROM users WHERE disabled_at IS NULL AND id <> 'system' ORDER BY id");
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/**
 * The user plus the stored hash, for checking a password. Login only.
 * @param {import('../db/index.js').Db} db
 * @param {string} id
 * @returns {Promise<{user: ReturnType<typeof shape>, password_hash: string}|null>}
 */
export async function credentials(db, id) {
  const { rows } = await db.query(`SELECT ${COLUMNS}, password_hash FROM users WHERE id = ?`, [id]);
  return rows[0] ? { user: shape(rows[0]), password_hash: String(rows[0].password_hash) } : null;
}

/**
 * @param {import('../db/index.js').Db} db
 * @param {string} now
 * @returns {Promise<Array<ReturnType<typeof shape> & {sessions: number}>>}
 */
export async function list(db, now) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY id`);
  const counts = await sessions.countByUser(db, now);
  return rows.map((r) => ({ ...shape(r), sessions: counts.get(String(r.id)) ?? 0 }));
}

/**
 * What already carries this id as an owner, actor, or token holder: data a new
 * users row with the same id would take over. Counts only, never titles. This
 * deliberately reads other tables without the visibility predicate: it serves
 * the operator's CLI, not any route, and returns numbers, not rows.
 * @param {import('../db/index.js').Db} db
 * @param {string} id
 * @returns {Promise<{projects: number, tasks: number, activity: number, tokens: number, live_tokens: number}>}
 */
export async function existingFootprint(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT (SELECT COUNT(*) FROM projects WHERE owner_id = ?) AS projects,
            (SELECT COUNT(*) FROM tasks WHERE owner_id = ?) AS tasks,
            (SELECT COUNT(*) FROM activity WHERE actor_id = ?) AS activity,
            (SELECT COUNT(*) FROM mcp_tokens WHERE user_id = ?) AS tokens,
            (SELECT COUNT(*) FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL) AS live_tokens,
            (SELECT COUNT(*) FROM preferences WHERE user_id = ?) AS preferences,
            (SELECT COUNT(*) FROM feed_tokens WHERE user_id = ?) AS feeds,
            (SELECT COUNT(*) FROM feed_tokens WHERE user_id = ? AND revoked_at IS NULL) AS live_feeds`,
    [id, id, id, id, id, id, id, id]);
  return { projects: Number(r.projects), tasks: Number(r.tasks), activity: Number(r.activity),
    tokens: Number(r.tokens), live_tokens: Number(r.live_tokens), preferences: Number(r.preferences),
    feeds: Number(r.feeds), live_feeds: Number(r.live_feeds) };
}

/**
 * Add a user. An id that already owns projects or tasks, acted in the activity
 * log, or has ever held an MCP token or a feed link is refused unless `claimExisting` is set: the
 * new account would become that person, items, history, and tokens included.
 * @param {import('../db/index.js').Db} db
 * @param {{id: string, name: string, email?: string|null, groups?: string[]}} u  already validated
 * @param {string} passwordHash  from hashPassword()
 * @param {string} now
 * @param {{claimExisting?: boolean}} [opts]
 * @returns {Promise<{status: 'created', user: ReturnType<typeof shape>, claimed: Awaited<ReturnType<typeof existingFootprint>>}
 *   | {status: 'exists'} | {status: 'in_use', claimed: Awaited<ReturnType<typeof existingFootprint>>}>}
 */
export async function create(db, u, passwordHash, now, opts = {}) {
  return db.transaction(async (tx) => {
    if ((await tx.query('SELECT id FROM users WHERE id = ?', [u.id])).rows[0]) return { status: 'exists' };
    const claimed = await existingFootprint(tx, u.id);
    // feed links count too: one made before this account existed would otherwise start reading as it
    const inUse = claimed.projects + claimed.tasks + claimed.activity + claimed.tokens + claimed.preferences + claimed.feeds > 0;
    if (inUse && !opts.claimExisting) return { status: 'in_use', claimed };
    await tx.query(
      'INSERT INTO users (id, name, email, groups, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [u.id, u.name, u.email ?? null, JSON.stringify(u.groups ?? []), passwordHash, now, now]);
    return { status: 'created', user: await get(tx, u.id), claimed };
  });
}

/**
 * Replace a user's password and end their sessions, except `keepSessionId`
 * (the session that made the change, when there is one). With `revokeTokens`,
 * also revoke every MCP token the user holds.
 * @param {import('../db/index.js').Db} db
 * @param {string} id
 * @param {string} passwordHash
 * @param {string} now
 * @param {{keepSessionId?: string, revokeTokens?: boolean}} [opts]
 * @returns {Promise<{sessions: number, tokens: number}|null>} null if there is no such user
 */
export async function setPassword(db, id, passwordHash, now, opts = {}) {
  return db.transaction(async (tx) => {
    const { changes } = await tx.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, now, id]);
    if (changes === 0) return null;
    return {
      sessions: await sessions.removeForUser(tx, id, opts.keepSessionId),
      tokens: opts.revokeTokens ? await tokens.revokeAllForUser(tx, id, now) : 0,
      feeds: opts.revokeTokens ? await feeds.revokeAllForUser(tx, id, now) : 0,
    };
  });
}

/**
 * Disable a user: no new sign-ins, every session ended, every MCP token and feed link revoked.
 * Works for an id with no users row too (someone known only from a token, say):
 * the sweep still runs and `found` says whether a row was disabled.
 * Repeating it is harmless and sweeps again.
 * @param {import('../db/index.js').Db} db
 * @param {string} id
 * @param {string} now
 * @returns {Promise<{found: boolean, sessions: number, tokens: number}>}
 */
export async function disable(db, id, now) {
  return db.transaction(async (tx) => {
    const found = Boolean((await tx.query('SELECT id FROM users WHERE id = ?', [id])).rows[0]);
    if (found) await tx.query('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL', [now, now, id]);
    return { found, sessions: await sessions.removeForUser(tx, id), tokens: await tokens.revokeAllForUser(tx, id, now), feeds: await feeds.revokeAllForUser(tx, id, now) };
  });
}
/**
 * Allow a disabled user to sign in again. Revoked tokens stay revoked.
 * @param {import('../db/index.js').Db} db
 * @param {string} id
 * @param {string} now
 * @returns {Promise<boolean>} false if there is no such user
 */
export async function enable(db, id, now) {
  return db.transaction(async (tx) => {
    if (!(await tx.query('SELECT id FROM users WHERE id = ?', [id])).rows[0]) return false;
    await tx.query('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ? AND disabled_at IS NOT NULL', [now, id]);
    return true;
  });
}
