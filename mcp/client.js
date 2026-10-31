// A small HTTP client for the Taskscape API. It adds the Bearer token, the
// MCP session id, and a User-Agent to every request, parses JSON bodies, and
// never throws on HTTP errors: callers get `{status, body}` and decide.
// `fetch` is injectable so tests can run without a network.

export const USER_AGENT = 'taskscape-mcp/0.1';

/**
 * @typedef {Object} ApiResponse
 * @property {number} status  HTTP status code
 * @property {any} body       parsed JSON body, `null` when empty, or `{raw: string}` when not JSON
 */

/**
 * @typedef {Object} RequestOptions
 * @property {Record<string, string|undefined>} [query]  query parameters; undefined values are skipped
 * @property {any} [body]                                JSON-serialised request body
 */

/**
 * @typedef {Object} Client
 * @property {(method: string, path: string, opts?: RequestOptions) => Promise<ApiResponse>} request
 * @property {(path: string, query?: Record<string, string|undefined>) => Promise<ApiResponse>} get
 * @property {(path: string, body?: any) => Promise<ApiResponse>} post
 * @property {(path: string, body?: any) => Promise<ApiResponse>} patch
 * @property {(path: string, body?: any) => Promise<ApiResponse>} put
 * @property {(path: string, body?: any) => Promise<ApiResponse>} delete
 * @property {string} baseUrl  the API origin, without a trailing slash
 */

/**
 * Build a client bound to one API origin, token, and session id.
 * @param {{baseUrl: string, token: string, sessionId: string, fetch?: typeof globalThis.fetch}} opts
 * @returns {Client}
 */
export function createClient({ baseUrl, token, sessionId, fetch: fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!token) throw new Error('token is required');
  if (!sessionId) throw new Error('sessionId is required');
  const base = String(baseUrl).replace(/\/+$/, '');

  /** @type {Client['request']} */
  async function request(method, path, { query, body } = {}) {
    let url = base + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Taskscape-Session': sessionId,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    /** @type {RequestInit} */
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: res.status, body: parsed };
  }

  return {
    baseUrl: base,
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    delete: (path, body) => request('DELETE', path, { body }),
  };
}
