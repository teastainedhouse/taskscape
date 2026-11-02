import { ApiError, payloadTooLarge, validationFailed, unsupportedMediaType } from './errors.js';

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
 * Read a body as bytes, enforcing a byte limit. Streams and counts, so an
 * undeclared or chunked body is cut off at the limit instead of buffered whole.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBytes(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge();
  if (!request.body) return Buffer.alloc(0);
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
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

/**
 * Read a text body (UTF-8; a leading byte-order mark is dropped), enforcing a byte limit.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readText(request, maxBytes) {
  const charset = /;\s*charset=([^;\s]+)/i.exec(request.headers.get('content-type') ?? '')?.[1]?.replace(/^"|"$/g, '').toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') throw unsupportedMediaType(); // only UTF-8 is decoded; anything else would be garbled
  const bytes = await readBytes(request, maxBytes);
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes);
}

/**
 * Read and parse a JSON object body, enforcing a byte limit.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(request, maxBytes) {
  const bytes = await readBytes(request, maxBytes);
  if (bytes.byteLength === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
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
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } // a malformed escape is a junk value, not a 500
  }
  return out;
}

export { ApiError };
