import { Readable } from 'node:stream';

/**
 * Convert a Node IncomingMessage into a Web Request.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ protocol?: string }} [opts]
 * @returns {Request}
 */
export function toWebRequest(req, opts = {}) {
  const protocol = opts.protocol ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = !['GET', 'HEAD'].includes(method);
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

/**
 * Write a Web Response to a Node ServerResponse.
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 */
export async function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).on('error', reject).on('end', resolve).pipe(res);
  });
}
