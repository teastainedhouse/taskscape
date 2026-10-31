/**
 * Identity from headers injected by the host's SSO layer.
 *
 * Safe ONLY behind a proxy that strips client-supplied copies of these
 * headers. Two sources, both configurable under config.auth.headers:
 *  - plain headers: `id`, `name`, `email`, `groups` name the header for each field
 *  - `principal`: a header carrying a base64-encoded JSON document, read with
 *    dot paths (`id_path`, `name_path`, `email_path`, `groups_path`); when the
 *    document keeps claims as an array of {type, value} pairs, `claims_path`
 *    plus `claim_type_key`/`claim_value_key` flatten them into an object first.
 * The first source that has a field wins.
 */

/** @param {object} obj @param {string} dotPath */
function dig(obj, dotPath) {
  if (!dotPath) return undefined;
  return dotPath.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** @param {string} raw @returns {object|null} */
function decodePrincipal(raw) {
  try {
    const jsonText = Buffer.from(raw, 'base64').toString('utf8');
    const doc = JSON.parse(jsonText);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {string[]} */
function toList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * @param {Request} request
 * @param {object} cfg  config.auth.headers
 * @returns {{id:string, name:string, email?:string, groups:string[]}|null}
 */
export function fromHeaders(request, cfg) {
  const h = (name) => (name ? request.headers.get(name) : null);
  let doc = null;
  if (cfg.principal) {
    const raw = h(cfg.principal);
    if (raw) doc = decodePrincipal(raw);
    if (doc && cfg.claims_path) {
      const claims = dig(doc, cfg.claims_path);
      if (Array.isArray(claims)) {
        const flat = {};
        for (const c of claims) {
          if (c && typeof c === 'object') {
            const t = c[cfg.claim_type_key ?? 'typ'];
            const v = c[cfg.claim_value_key ?? 'val'];
            if (t !== undefined && flat[t] === undefined) flat[t] = v;
          }
        }
        // make `claims.<type>` paths work
        const parts = cfg.claims_path.split('.');
        let cursor = doc;
        for (const p of parts.slice(0, -1)) cursor = cursor[p];
        cursor[parts.at(-1)] = flat;
      }
    }
  }
  const pick = (headerName, docPath) => {
    const direct = h(headerName);
    if (direct) return direct;
    const fromDoc = doc ? dig(doc, docPath) : undefined;
    return fromDoc === undefined || fromDoc === null ? undefined : fromDoc;
  };
  const id = pick(cfg.id, cfg.id_path);
  if (!id || typeof id !== 'string') return null;
  const name = pick(cfg.name, cfg.name_path);
  const email = pick(cfg.email, cfg.email_path);
  const groups = toList(pick(cfg.groups, cfg.groups_path));
  return {
    id,
    name: typeof name === 'string' && name ? name : (typeof email === 'string' && email ? email : id),
    email: typeof email === 'string' ? email : undefined,
    groups,
  };
}
