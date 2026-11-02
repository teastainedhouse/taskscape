// Feed tokens (migration 011): the secret in a calendar or Atom feed URL.
// Separate from MCP tokens: a feed token can only read the feeds, never call
// another route, so a leaked calendar link cannot write or mint anything.
// Like the auth tables, no version and no activity entries (docs/PLAN.md §2
// rule 13). Only the sha256 is stored; the full link is shown once.
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../ids.js';
import { notFound } from '../errors.js';
import * as users from './users.js';

export const FEED_TOKEN_PREFIX = 'tsf_';
/** Who a feed shows: the owner's own tasks, or everything the owner can see. */
export const FEED_SCOPES = ['mine', 'all'];
const TOUCH_INTERVAL_MS = 60_000;

/** @returns {string} a fresh plaintext feed token: the prefix and 32 random bytes, URL-safe */
export function generateFeedToken() {
  return FEED_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** @param {string} v @returns {boolean} looks like generateFeedToken() made it, so junk is never looked up */
export function isFeedToken(v) {
  return typeof v === 'string' && /^tsf_[A-Za-z0-9_-]{43}$/.test(v);
}

/** @param {string} plaintext */
const hash = (plaintext) => createHash('sha256').update(plaintext, 'utf8').digest('hex');

const shape = (r) => ({
  id: r.id, label: r.label, scope: r.scope, token_prefix: r.token_prefix, created_at: r.created_at,
  last_used_at: r.last_used_at ?? null, revoked_at: r.revoked_at ?? null,
});

/** The caller's feed links, newest first, revoked ones included. @param {import('../db/index.js').Db} db @param {string} userId */
export async function listForUser(db, userId) {
  const { rows } = await db.query(
    'SELECT id, label, scope, token_prefix, created_at, last_used_at, revoked_at FROM feed_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId]);
  return rows.map(shape);
}

/**
 * Make a feed token for the caller. The plaintext is returned once and never stored.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {{label: string, scope: 'mine'|'all'}} input
 * @param {string} now
 */
export async function issue(db, user, input, now) {
  const plaintext = generateFeedToken();
  const id = newId();
  const prefix = plaintext.slice(0, 12);
  await db.query(
    `INSERT INTO feed_tokens (id, user_id, user_name, label, scope, token_hash, token_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, user.name, input.label, input.scope, hash(plaintext), prefix, now]);
  return { feed: { id, label: input.label, scope: input.scope, token_prefix: prefix, created_at: now, last_used_at: null, revoked_at: null }, plaintext };
}

/** Revoke one of the caller's feed tokens (idempotent); someone else's is a 404. */
export async function revoke(db, userId, id, now) {
  const { rows } = await db.query('SELECT * FROM feed_tokens WHERE id = ? AND user_id = ?', [id, userId]);
  if (!rows[0]) throw notFound();
  if (!rows[0].revoked_at) await db.query('UPDATE feed_tokens SET revoked_at = ? WHERE id = ?', [now, id]);
  return shape({ ...rows[0], revoked_at: rows[0].revoked_at ?? now });
}

/** Revoke every feed token of a user (password change, disable). @returns {Promise<number>} how many */
export async function revokeAllForUser(db, userId, now) {
  const { changes } = await db.query('UPDATE feed_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
  return changes ?? 0;
}

/**
 * The principal a feed reads as, or null: an unrevoked token, and under the password provider an enabled account.
 * The principal can only be used for the feeds' reads; it carries no groups (edit rights are never needed).
 * @param {import('../db/index.js').Db} db
 * @param {import('../config.js').Config} config
 * @param {string} plaintext
 * @param {string} now
 * @returns {Promise<{user: {id: string, name: string, groups: string[], via: 'feed', auth: 'feed'}, scope: 'mine'|'all'}|null>}
 */
export async function lookup(db, config, plaintext, now) {
  if (!isFeedToken(plaintext)) return null;
  const { rows } = await db.query('SELECT * FROM feed_tokens WHERE token_hash = ? AND revoked_at IS NULL', [hash(plaintext)]);
  const r = rows[0];
  if (!r) return null;
  if (config.auth.provider === 'password') {
    const u = await users.get(db, r.user_id);
    if (!u || u.disabled_at) return null;
  }
  if (!r.last_used_at || Date.parse(now) - Date.parse(r.last_used_at) > TOUCH_INTERVAL_MS) {
    await db.query('UPDATE feed_tokens SET last_used_at = ? WHERE id = ?', [now, r.id]);
  }
  return { user: { id: r.user_id, name: r.user_name, groups: [], via: 'feed', auth: 'feed' }, scope: r.scope };
}
