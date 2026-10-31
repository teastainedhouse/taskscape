import { ApiError, payloadTooLarge, validationFailed } from './errors.js';

/** Headers every API response carries. */
export const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string,string>} [headers]
 * @returns {Response}
 */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * @param {string} body
 * @param {string} contentType
 * @param {number} [status]
 * @param {Record<string,string>} [headers]
 * @returns {Response}
 */
export function text(body, contentType, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...BASE_HEADERS, 'Content-Type': contentType, ...headers } });
}

/** @param {ApiError} err @returns {Response} */
export function errorResponse(err) {
  return json(err.body(), err.status, err.headers ?? {});
}

/**
 * Read and parse a JSON object body, enforcing a byte limit.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge();
  if (!request.body) return {};
  // Stream and count, so an undeclared or chunked body is cut off at the limit instead of buffered whole.
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw payloadTooLarge();
    }
    parts.push(value);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)))));
  } catch {
    throw validationFailed({ body: 'must be valid JSON' });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationFailed({ body: 'must be a JSON object' });
  }
  return parsed;
}

/**
 * Parse a Cookie header into a map.
 * @param {string|null} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export { ApiError };
