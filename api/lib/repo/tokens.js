import { newId } from '../ids.js';
import { notFound } from '../errors.js';
import { generateToken, hashToken, tokenPrefix } from '../auth/tokens.js';

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
