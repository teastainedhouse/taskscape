// recurrence.js — pure date arithmetic for recurring tasks (docs/PLAN.md §2
// rule 17). Dates are calendar days, `YYYY-MM-DD`, with no time of day and no
// time zone: a due date means a day in the owner's calendar, and the zone only
// decides which day "today" is (dateInZone()).

/** The rules a task may repeat by. */
export const RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'];

/** @param {string} d YYYY-MM-DD @returns {{y: number, m: number, d: number}} m is 1-12 */
function parts(d) {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, d: day };
}

/** @param {number} y @param {number} m 1-12 @param {number} d */
function fmt(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in a month. @param {number} y @param {number} m 1-12 */
export function daysInMonth(y, m) {
  return utc(y, m, 0).getUTCDate();
}

/** A UTC date from parts; setUTCFullYear, because Date.UTC reads the years 0 to 99 as 1900 to 1999. m is 0-based here. */
function utc(y, m, d) {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(y, m, d);
  return t;
}

/** @param {string} d YYYY-MM-DD */
export function isMonthEnd(d) {
  const p = parts(d);
  return p.d === daysInMonth(p.y, p.m);
}

/** @param {string} d YYYY-MM-DD */
export function dayOfMonth(d) {
  return parts(d).d;
}

/** `d` plus `n` days. @param {string} d YYYY-MM-DD @param {number} n */
export function addDays(d, n) {
  const p = parts(d);
  const t = utc(p.y, p.m - 1, p.d + n);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * `d` plus `n` months, on day `anchor` (default: d's own day), or the last day of the target month when that
 * month is shorter: a monthly task on the 31st lands on the 30th, or on the 28th or 29th in February.
 * @param {string} d YYYY-MM-DD @param {number} n @param {number} [anchor] 1-31
 */
export function addMonths(d, n, anchor) {
  const p = parts(d);
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return fmt(y, m, Math.min(anchor ?? p.d, daysInMonth(y, m)));
}

/**
 * The next due date after `from` for a rule.
 * @param {string} from YYYY-MM-DD: the old due date, or today in the owner's zone when the task had none
 * @param {'daily'|'weekly'|'monthly'|'yearly'} rule
 * @param {number} [anchor]  the day of the month the series means (monthly and yearly); see anchorDay() in repo/tasks.js
 */
export function nextDue(from, rule, anchor) {
  if (rule === 'daily') return addDays(from, 1);
  if (rule === 'weekly') return addDays(from, 7);
  if (rule === 'monthly') return addMonths(from, 1, anchor);
  if (rule === 'yearly') return addMonths(from, 12, anchor);
  throw new Error('unknown recurrence');
}

/**
 * The calendar day of an instant in an IANA time zone, as YYYY-MM-DD; UTC when the zone is unknown to this runtime.
 * @param {Date} at @param {string} timeZone
 */
export function dateInZone(at, timeZone) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const get = (type) => f.find((x) => x.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
