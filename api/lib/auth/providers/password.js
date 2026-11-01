// Built-in password sign-in. The identity is a session cookie the API itself set
// after checking a password (POST /api/login); the client cannot choose who it is,
// only present a value the server issued. Only the cookie value's sha256 is stored.
import { parseCookies } from '../../http.js';
import * as sessions from '../../repo/sessions.js';

/** @param {unknown} json @returns {string[]} */
function parseGroups(json) {
  try { const v = JSON.parse(typeof json === 'string' ? json : '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/**
 * The session cookie value on this request, if any.
 * @param {Request} request
 * @param {{cookie_name: string}} cfg
 * @returns {string|null}
 */
export function sessionCookieValue(request, cfg) {
  return parseCookies(request.headers.get('cookie'))[cfg.cookie_name] ?? null;
}

/**
 * `Set-Cookie` for a new session. `Secure` always: browsers accept it on http://localhost.
 * @param {{cookie_name: string, session_days: number}} cfg
 * @param {string} value
 */
export function sessionCookie(cfg, value) {
  return `${cfg.cookie_name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cfg.session_days * 86_400}`;
}

/** @param {{cookie_name: string}} cfg  `Set-Cookie` that removes the session cookie */
export function clearSessionCookie(cfg) {
  return `${cfg.cookie_name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * @param {Request} request
 * @param {{config: import('../../config.js').Config, db: import('../../db/index.js').Db, now: () => string}} ctx
 * @returns {Promise<{id:string, name:string, email?:string, groups:string[], login_session_id:string}|null>}
 */
export async function fromPassword(request, ctx) {
  const value = sessionCookieValue(request, ctx.config.auth.password);
  if (!value) return null;
  const now = ctx.now();
  const row = await sessions.lookup(ctx.db, value, now);
  if (!row) return null;
  await sessions.touch(ctx.db, row, now);
  return {
    id: String(row.user_id),
    name: String(row.user_name),
    email: row.user_email ?? undefined,
    groups: parseGroups(row.user_groups),
    login_session_id: String(row.id),
  };
}
