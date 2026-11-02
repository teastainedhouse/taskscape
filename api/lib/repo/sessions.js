import { newId } from '../ids.js';
import { generateSessionToken, hashToken, isSessionToken } from '../auth/tokens.js';

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Start a session. The cookie value is returned once and only its hash is stored.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {string} now
 * @param {number} days  lifetime; fixed from creation, never extended
 * @returns {Promise<{id: string, plaintext: string, expires_at: string}>}
 */
export async function create(db, userId, now, days) {
  const plaintext = generateSessionToken();
  const id = newId();
  const expires_at = new Date(Date.parse(now) + days * 86_400_000).toISOString();
  await db.query(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, hashToken(plaintext), now, expires_at, now]);
  return { id, plaintext, expires_at };
}

/**
 * Find a live session by cookie value, with its user. Live means not expired
 * and the user not disabled.
 * @param {import('../db/index.js').Db} db
 * @param {string} plaintext
 * @param {string} now
 */
export async function lookup(db, plaintext, now) {
  if (!isSessionToken(plaintext)) return null;
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, s.last_seen_at, u.name AS user_name, u.email AS user_email, u.groups AS user_groups
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    [hashToken(plaintext), now]);
  return rows[0] ?? null;
}

/**
 * Record use of a session, at most once a minute. Uses the stored time, so it
 * holds across processes.
 * @param {import('../db/index.js').Db} db
 * @param {{id: string, last_seen_at: string}} row  from lookup()
 * @param {string} now
 */
export async function touch(db, row, now) {
  if (Date.parse(now) - Date.parse(row.last_seen_at) < TOUCH_INTERVAL_MS) return false;
  await db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, row.id]);
  return true;
}

/** @param {import('../db/index.js').Db} db @param {string} plaintext  end the session this cookie names, if any */
export async function removeByToken(db, plaintext) {
  if (!isSessionToken(plaintext)) return 0;
  return (await db.query('DELETE FROM sessions WHERE token_hash = ?', [hashToken(plaintext)])).changes;
}

/**
 * End every session of a user, optionally keeping one.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {string} [keepId]
 */
export async function removeForUser(db, userId, keepId) {
  const { changes } = keepId
    ? await db.query('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, keepId])
    : await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return changes;
}

/**
 * A user's live sessions, newest first, for the profile page. Never the token hash.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {string} now
 * @returns {Promise<Array<{id: string, created_at: string, last_seen_at: string, expires_at: string}>>}
 */
export async function listForUser(db, userId, now) {
  const { rows } = await db.query(
    'SELECT id, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC, id DESC',
    [userId, now]);
  return rows.map((r) => ({ id: String(r.id), created_at: String(r.created_at), last_seen_at: String(r.last_seen_at), expires_at: String(r.expires_at) }));
}

/**
 * End one of a user's own live sessions. Someone else's id, an unknown one, or an
 * expired one (which the list no longer shows) ends nothing.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} now
 * @returns {Promise<boolean>} whether a row went
 */
export async function removeOwn(db, userId, sessionId, now) {
  return (await db.query('DELETE FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?', [sessionId, userId, now])).changes > 0;
}

/** @param {import('../db/index.js').Db} db @param {string} now  drop expired rows */
export async function removeExpired(db, now) {
  return (await db.query('DELETE FROM sessions WHERE expires_at <= ?', [now])).changes;
}

/**
 * Live session counts per user, for the users CLI.
 * @param {import('../db/index.js').Db} db
 * @param {string} now
 * @returns {Promise<Map<string, number>>}
 */
export async function countByUser(db, now) {
  const { rows } = await db.query('SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id', [now]);
  return new Map(rows.map((r) => [String(r.user_id), Number(r.n)]));
}
