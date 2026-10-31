import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'tsk_';
const PREFIX_SHOWN = 12;
const TOUCH_INTERVAL_MS = 60_000;

/** @returns {string} a fresh plaintext token */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** @param {string} plaintext @returns {string} sha256 hex */
export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** @param {string} plaintext @returns {string} the displayable prefix */
export function tokenPrefix(plaintext) {
  return plaintext.slice(0, PREFIX_SHOWN);
}

/** @param {string|null} authorization @returns {string|null} the bearer value, if any */
export function bearerFrom(authorization) {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

/**
 * Find a live token row by plaintext.
 * @param {import('../db/index.js').Db} db
 * @param {string} plaintext
 */
export async function lookupToken(db, plaintext) {
  const { rows } = await db.query(
    'SELECT id, user_id, user_name, user_email, user_groups, label, last_used_at FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL',
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
