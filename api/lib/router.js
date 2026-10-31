import { ApiError, notFound, methodNotAllowed, unauthorized, forbidden, validationFailed, internal } from './errors.js';
import { errorResponse, BASE_HEADERS } from './http.js';
import { getUser } from './auth/index.js';
import { canEdit } from './config.js';

/**
 * @typedef {'any'|'human'|'none'} AuthKind
 * @typedef {{
 *   user: import('./auth/index.js').Principal|null,
 *   params: Record<string,string>,
 *   query: Record<string,string>,
 *   url: URL,
 *   config: import('./config.js').Config,
 *   db: import('./db/index.js').Db,
 *   now: () => string,
 * }} Ctx
 * @typedef {(req: Request, ctx: Ctx) => Promise<Response>} Handler
 * @typedef {{ method: string, path: string, auth?: AuthKind, handler: Handler }} Route
 */

/** @param {string} pattern @returns {{ regex: RegExp, keys: string[] }} */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

/**
 * A tiny method + path router with auth middleware. All API behaviour that
 * applies to every route lives here: identity, the editor check, the MCP
 * session rule, error envelopes, and the base headers.
 */
export class Router {
  /** @type {Array<Route & {regex: RegExp, keys: string[]}>} */
  #routes = [];

  /** @param {Route[]} routes */
  add(routes) {
    for (const r of routes) this.#routes.push({ auth: 'any', ...r, ...compile(r.path) });
    return this;
  }

  /**
   * @param {Request} request
   * @param {{config: import('./config.js').Config, db: import('./db/index.js').Db, now: () => string, log?: (e: unknown) => void}} env
   * @returns {Promise<Response>}
   */
  async handle(request, env) {
    try {
      return await this.#dispatch(request, env);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      (env.log ?? console.error)(err);
      return errorResponse(internal());
    }
  }

  async #dispatch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    let matched = null;
    const allowed = [];
    for (const r of this.#routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      allowed.push(r.method);
      if (r.method === request.method && !matched) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        matched = { route: r, params };
      }
    }
    if (!matched) {
      if (allowed.length) throw methodNotAllowed([...new Set(allowed)]);
      throw notFound();
    }
    const { route, params } = matched;
    const user = route.auth === 'none' ? null : await getUser(request, env);
    if (route.auth !== 'none') {
      if (!user) throw unauthorized();
      if (route.auth === 'human' && user.via === 'mcp') throw forbidden('This action is only available in the browser.');
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (isWrite) {
        if (!canEdit(env.config, user)) throw forbidden('Your account is read-only.');
        if (user.via === 'mcp' && !user.session_id) {
          throw validationFailed({ 'X-Taskscape-Session': 'header is required on every MCP write' });
        }
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const ctx = { user, params, query, url, config: env.config, db: env.db, now: env.now };
    const response = await route.handler(request, ctx);
    for (const [k, v] of Object.entries(BASE_HEADERS)) if (!response.headers.has(k)) response.headers.set(k, v);
    return response;
  }
}
