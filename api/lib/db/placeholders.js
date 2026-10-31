/**
 * Rewrite `?` placeholders to PostgreSQL's `$1 … $n`, skipping single-quoted
 * string literals and `--` line comments. Repo SQL is written with `?`.
 * @param {string} sql
 * @returns {string}
 */
export function toPositional(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  let inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inComment) {
      out += ch;
      if (ch === '\n') inComment = false;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i++; } else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { inComment = true; out += ch; continue; }
    if (ch === '?') { n++; out += '$' + n; continue; }
    out += ch;
  }
  return out;
}

/**
 * Coerce JS values to what both drivers bind cleanly: booleans to 0/1,
 * undefined to null. Everything else passes through.
 * @param {unknown[]} params
 * @returns {unknown[]}
 */
export function coerceParams(params) {
  return params.map((p) => {
    if (p === true) return 1;
    if (p === false) return 0;
    if (p === undefined) return null;
    return p;
  });
}

/** @param {string} sql @returns {boolean} whether the statement returns rows */
export function isReadStatement(sql) {
  const head = sql.replace(/^(\s|--[^\n]*\n)+/, '').slice(0, 10).toUpperCase();
  return /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/.test(head);
}
