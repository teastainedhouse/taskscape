// ical.js — the calendar feed's text (RFC 5545), pure: no database, no config.
// Every TEXT value goes through icalText() (backslash, semicolon, comma and
// line breaks escaped; other control characters dropped), every line through
// fold() (75 octets at most, continued with a space, never splitting a UTF-8
// character), and lines end with CRLF. Tasks are all-day events on their due
// date, so no time zones are involved: a due date is a calendar day.

/**
 * A TEXT value (RFC 5545 §3.3.11): `\` `;` `,` escaped, every line break as `\n`, control characters removed
 * (a TEXT value may not contain them, and a title is never meant to), and the bidi marks, embeddings, overrides and
 * isolates too, as in the Atom feed, so one title cannot reorder the text around it.
 * @param {unknown} v
 */
export function icalText(v) {
  return String(v ?? '')
    .replace(/\r\n?|\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Fold one content line at 75 octets (RFC 5545 §3.1): each continuation starts with a space, which counts
 * toward its 75, and no UTF-8 character is split across lines.
 * @param {string} line
 * @returns {string} with CRLF between the folded parts (no trailing CRLF)
 */
export function fold(line) {
  const parts = [];
  let cur = '';
  let octets = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (octets + n > limit) {
      parts.push(cur);
      cur = ' ';
      octets = 1;
      limit = 75;
    }
    cur += ch;
    octets += n;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

/** YYYY-MM-DD as an iCalendar DATE (YYYYMMDD). @param {string} d */
const icalDate = (d) => d.replace(/-/g, '');

/** An ISO timestamp as an iCalendar UTC DATE-TIME (YYYYMMDDTHHMMSSZ). @param {string} iso */
export function icalStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The day after YYYY-MM-DD (the exclusive end of an all-day event), or null past 9999-12-31. @param {string} d */
function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  const out = t.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

/**
 * The calendar: one all-day VEVENT per task, on its due date.
 * @param {{name: string, base: string, stamp: string}} cal  name of the calendar; the site's public base URL (no trailing slash); now
 * @param {Array<{id: string, title: string, status: string, priority: string|null, project_name: string|null, due_date: string, updated_at: string}>} tasks
 * @returns {string}
 */
export function renderCalendar(cal, tasks) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Taskscape//Task feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(cal.name)}`];
  for (const t of tasks) {
    const url = `${cal.base}/task.html?id=${encodeURIComponent(t.id)}`;
    const description = [`Status: ${t.status}`, t.priority ? `Priority: ${t.priority}` : null, t.project_name ? `Project: ${t.project_name}` : null, url]
      .filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      `UID:task-${t.id}@taskscape`,
      `DTSTAMP:${icalStamp(cal.stamp)}`,
      `LAST-MODIFIED:${icalStamp(t.updated_at)}`,
      `DTSTART;VALUE=DATE:${icalDate(t.due_date)}`,
      // with a DATE start and no DTEND an event lasts that one day (§3.6.1): only for 9999-12-31, which has no next day
      ...(nextDay(t.due_date) ? [`DTEND;VALUE=DATE:${icalDate(nextDay(t.due_date))}`] : []),
      `SUMMARY:${icalText(t.title)}`,
      `DESCRIPTION:${icalText(description)}`,
      `URL:${url}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
