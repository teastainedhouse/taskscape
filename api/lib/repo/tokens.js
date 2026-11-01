import { newId } from '../ids.js';
import { notFound } from '../errors.js';
import { generateToken, hashToken, tokenPrefix } from '../auth/tokens.js';

const TOUCH_INTERVAL_MS = 60_000;

const shape = (r) => ({
  id: r.id, label: r.label, token_prefix: r.token_prefix, created_at: r.created_at,
  last_used_at: r.last_used_at ?? null, revoked_at: r.revoked_at ?? null,
});

/** @param {import('../db/index.js').Db} db @param {string} userId */
export async function listForUser(db, userId) {
  const { rows } = await db.query(
    'SELECT id, label, token_prefix, created_at, last_used_at, revoked_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId]);
  return rows.map(shape);
}

/**
 * Mint a token. The plaintext is returned once and never stored.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {string} label
 * @param {string} now
 */
export async function issue(db, user, label, now) {
  const plaintext = generateToken();
  const id = newId();
  await db.query(
    `INSERT INTO mcp_tokens (id, user_id, user_name, user_email, user_groups, label, token_hash, token_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, user.name, user.email ?? null, JSON.stringify(user.groups ?? []), label, hashToken(plaintext), tokenPrefix(plaintext), now]);
  return { token: { id, label, token_prefix: tokenPrefix(plaintext), created_at: now, last_used_at: null, revoked_at: null }, plaintext };
}

/**
 * Soft-revoke one of the caller's tokens. Idempotent; someone else's token is a 404.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {string} id
 * @param {string} now
 */
export async function revoke(db, user, id, now) {
  await db.query('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [now, id, user.id]);
  const { rows } = await db.query(
    'SELECT id, label, token_prefix, created_at, last_used_at, revoked_at FROM mcp_tokens WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!rows[0]) throw notFound();
  return shape(rows[0]);
}

/**
 * Soft-revoke every live token a user holds (when the account is disabled).
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {string} now
 * @returns {Promise<number>} how many were revoked
 */
export async function revokeAllForUser(db, userId, now) {
  const { changes } = await db.query('UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
  return changes;
}

/**
 * Find a live token row by plaintext. With `requireUser` (the password provider)
 * the token also needs a users row for its user_id that is not disabled, so a
 * token outlives neither its account nor the account's removal.
 * @param {import('../db/index.js').Db} db
 * @param {string} plaintext
 * @param {{requireUser?: boolean}} [opts]
 */
export async function lookup(db, plaintext, opts = {}) {
  const join = opts.requireUser ? ' JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL' : '';
  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.user_name, t.user_email, t.user_groups, t.label, t.last_used_at
       FROM mcp_tokens t${join} WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    [hashToken(plaintext)],
  );
  return rows[0] ?? null;
}

/** @type {Map<string, number>} token id -> last touch (ms) */
const touched = new Map();

/**
 * Record use of a token, at most once a minute per token per process.
 * @param {import('../db/index.js').Db} db
 * @param {string} tokenId
 * @param {string} nowIso
 */
export async function touchLastUsed(db, tokenId, nowIso) {
  const last = touched.get(tokenId) ?? 0;
  const nowMs = Date.parse(nowIso);
  if (nowMs - last < TOUCH_INTERVAL_MS) return false;
  touched.set(tokenId, nowMs);
  await db.query('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', [nowIso, tokenId]);
  return true;
}

/** Test hook. */
export function _resetTouchCache() {
  touched.clear();
}
