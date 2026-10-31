import { projectVisible, taskVisible } from './visibility.js';

/**
 * People the caller may pick as an owner: owners of items the caller can
 * see, the caller, and (with the dev provider) the configured dev users.
 * Names only; never derived from private items the caller cannot see.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {import('../config.js').Config} config
 */
export async function list(db, user, config) {
  const pv = projectVisible('p', user);
  const tv = taskVisible('t', 'p', user);
  const { rows } = await db.query(
    `SELECT owner_id AS id, owner_name AS name FROM (
       SELECT p.owner_id, p.owner_name, p.updated_at FROM projects p WHERE ${pv.sql} AND p.owner_id <> 'system'
       UNION ALL
       SELECT t.owner_id, t.owner_name, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${tv.sql}
     ) x`,
    [...pv.params, ...tv.params],
  );
  /** @type {Map<string, string>} */
  const people = new Map();
  for (const r of rows) people.set(r.id, r.name); // later rows win; fine for a display snapshot
  people.set(user.id, user.name);
  if (config.auth.provider === 'dev') for (const u of config.auth.dev.users) people.set(u.id, u.name);
  return [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
