// Personal preferences (migration 005): one row per principal id, under any
// provider. Outside the versioning rule like the auth tables: last write
// wins and nothing is logged (docs/PLAN.md §2 rule 13). A NULL column means
// the site default, so a fork can change a default and everyone who never
// chose follows it.

import { dateInZone } from '../recurrence.js';

/** The preference names, in the order the API and the profile page show them. */
export const PREFERENCE_KEYS = ['theme', 'comments_label', 'shortcuts', 'time_zone'];

/** @param {unknown} v */
const bool = (v) => (v === null || v === undefined ? null : v === 1 || v === true || v === '1');

/**
 * The stored row for a user, or null.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @returns {Promise<{theme: string|null, comments_label: string|null, shortcuts: boolean|null, time_zone: string|null}|null>}
 */
export async function get(db, userId) {
  const { rows } = await db.query('SELECT theme, comments_label, shortcuts, time_zone FROM preferences WHERE user_id = ?', [userId]);
  const r = rows[0];
  return r ? { theme: r.theme ?? null, comments_label: r.comments_label ?? null, shortcuts: bool(r.shortcuts), time_zone: r.time_zone ?? null } : null;
}

/**
 * The site defaults overlaid with what the user chose: what every page and the MCP server work from.
 * @param {import('../config.js').Config} config
 * @param {Awaited<ReturnType<typeof get>>} row
 */
export function effective(config, row) {
  const d = config.preference_defaults;
  const themeOk = !!row?.theme && config.themes.includes(row.theme); // a theme a fork removed falls back to the default
  return {
    theme: themeOk ? row.theme : config.theme,
    comments_label: row?.comments_label ?? d.comments_label,
    shortcuts: row?.shortcuts ?? d.shortcuts,
    time_zone: row?.time_zone ?? d.time_zone,
    // which of these the person chose (the rest are the site's defaults): the browser uses the device's
    // time zone unless one was chosen, and the profile page can say "(site default)"
    chosen: { theme: themeOk, comments_label: row?.comments_label != null, shortcuts: row?.shortcuts != null, time_zone: row?.time_zone != null },
  };
}

/**
 * Store some preferences (validated already); a null value goes back to the site default.
 * One upsert statement (ON CONFLICT is the same in SQLite and PostgreSQL), so two first
 * writes for one person cannot race each other into a duplicate key.
 * @param {import('../db/index.js').Db} db
 * @param {string} userId
 * @param {Partial<{theme: string|null, comments_label: string|null, shortcuts: boolean|null, time_zone: string|null}>} fields
 * @param {string} now
 */
export async function set(db, userId, fields, now) {
  const keys = PREFERENCE_KEYS.filter((k) => fields[k] !== undefined);
  if (keys.length) {
    const asStored = (k) => (k === 'shortcuts' ? (fields[k] === null ? null : fields[k] ? 1 : 0) : fields[k]);
    await db.query(
      `INSERT INTO preferences (user_id, ${keys.join(', ')}, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
       ON CONFLICT (user_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
      [userId, ...keys.map(asStored), now]);
  }
  return get(db, userId);
}

/**
 * Today's date for a person: the calendar day of `now` in their time zone (their preference, else the site default).
 * The one rule for "today" on the server: overdue, the due filters, the Today page and a recurring task's next date.
 * @param {import('../db/index.js').Db} db
 * @param {import('../config.js').Config} config
 * @param {string} userId
 * @param {string} now  ISO timestamp
 * @returns {Promise<{today: string, time_zone: string}>}
 */
export async function todayFor(db, config, userId, now) {
  const time_zone = effective(config, await get(db, userId)).time_zone;
  return { today: dateInZone(new Date(now), time_zone), time_zone };
}
