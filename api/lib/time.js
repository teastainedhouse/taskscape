/** @returns {string} the current instant as ISO-8601 UTC */
export function nowIso() {
  return new Date().toISOString();
}

/** @param {Date} [d] @returns {string} YYYY-MM-DD in UTC */
export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** @param {number} days @returns {string} YYYY-MM-DD, `days` from today (UTC) */
export function daysFromNow(days) {
  return isoDate(new Date(Date.now() + days * 86_400_000));
}
