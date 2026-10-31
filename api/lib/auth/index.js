import { fromHeaders } from './providers/headers.js';
import { fromDev } from './providers/dev.js';
import { bearerFrom, lookupToken, touchLastUsed } from './tokens.js';
import { unauthorized } from '../errors.js';

export const SESSION_HEADER = 'x-taskscape-session';

/**
 * @typedef {Object} Principal
 * @property {string} id            stable subject id from SSO, or the token's user
 * @property {string} name
 * @property {string} [email]
 * @property {string[]} [groups]
 * @property {'ui'|'mcp'} via
 * @property {string} [session_id]  MCP only, from X-Taskscape-Session
 * @property {string} [token_id]    MCP only
 * @property {'headers'|'dev'|'token'} auth
 */

/**
 * Who is making this request. A Bearer token is authoritative when present
 * (an invalid one never falls through to the header provider).
 * @param {Request} request
 * @param {{config: import('../config.js').Config, db: import('../db/index.js').Db, now: () => string}} ctx
 * @returns {Promise<Principal|null>}
 */
export async function getUser(request, ctx) {
  const bearer = bearerFrom(request.headers.get('authorization'));
  if (bearer !== null) {
    const row = await lookupToken(ctx.db, bearer);
    if (!row) throw unauthorized();
    await touchLastUsed(ctx.db, row.id, ctx.now());
    const session = request.headers.get(SESSION_HEADER);
    return {
      id: row.user_id,
      name: row.user_name,
      email: row.user_email ?? undefined,
      via: 'mcp',
      auth: 'token',
      token_id: row.id,
      session_id: session && session.trim() ? session.trim().slice(0, 128) : undefined,
    };
  }
  const { auth } = ctx.config;
  const base = auth.provider === 'dev' ? fromDev(request, auth.dev) : fromHeaders(request, auth.headers);
  if (!base) return null;
  return { ...base, via: 'ui', auth: auth.provider };
}
