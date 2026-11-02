// api.js — the one fetch wrapper. JSON in and out, the error envelope
// from docs/API.md, 401 → "session expired" event, 409 → ApiError.current,
// 429 → ApiError.retryAfter.

/** An API error. `current` is the live record on a 409; `retryAfter` is seconds to wait on a 429. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {{error?: {code?: string, message?: string, details?: any}, current?: any}} body
   * @param {number|null} [retryAfter]  from the Retry-After header
   */
  constructor(status, body, retryAfter = null) {
    super(body?.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code || (status === 401 ? 'unauthorized' : 'unknown');
    this.details = body?.error?.details ?? null;
    this.current = status === 409 ? body?.current ?? null : null;
    this.retryAfter = retryAfter;
  }

  /** One line for people: the message plus any field names from validation details. */
  get humanMessage() {
    const fields = this.details?.fields;
    if (fields && typeof fields === 'object') {
      const parts = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
      if (parts.length) return `${this.message} (${parts.join('; ')})`;
    }
    if (this.status === 409) return 'Someone else changed this; showing the latest. Try again.';
    if (this.status === 401) return 'Session expired. Reload the page.';
    return this.message;
  }
}

/** Fired on document when the API answers 401. */
export const SESSION_EXPIRED_EVENT = 'taskscape:session-expired';

/**
 * Build a query string from an object, skipping empty values.
 * @param {Record<string, any>} [query]
 */
export function qs(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v == null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Call the API.
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path  starts with /api/
 * @param {{body?: any, text?: string, contentType?: string, query?: Record<string, any>, noExpiry?: boolean}} [opts]
 *   text + contentType: send a raw text body of that type instead of JSON (the Markdown import)
 *   noExpiry: skip the session-expired event (the sign-in page, where a 401 is a wrong password or simply signed out)
 * @returns {Promise<any>} parsed JSON body
 * @throws {ApiError}
 */
export async function api(method, path, opts = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (opts.text !== undefined) {
    if (!opts.contentType) throw new Error('a text body needs its content type'); // text/plain is refused by the API: a form can send it
    headers['Content-Type'] = opts.contentType;
    init.body = opts.text;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path + qs(opts.query), init);
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Could not reach the server.' } });
  }
  let body = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) {
    try { body = await res.json(); } catch { body = null; }
  }
  if (res.status === 401) {
    if (!opts.noExpiry) document.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    throw new ApiError(401, body ?? {});
  }
  if (!res.ok) {
    const wait = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    throw new ApiError(res.status, body ?? {}, Number.isFinite(wait) && wait >= 0 ? wait : null);
  }
  return body;
}

export const get = (path, query) => api('GET', path, { query });
export const post = (path, body) => api('POST', path, { body });
export const patch = (path, body) => api('PATCH', path, { body });
export const put = (path, body) => api('PUT', path, { body });
export const del = (path, body) => api('DELETE', path, { body });

/** @param {string} id */
export const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;
/** @param {string} id */
export const taskPath = (id) => `/api/tasks/${encodeURIComponent(id)}`;
/** @param {'project'|'task'} type @param {string} id */
export const itemPath = (type, id) => (type === 'project' ? projectPath(id) : taskPath(id));
