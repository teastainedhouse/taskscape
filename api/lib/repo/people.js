import { projectVisible, taskVisible } from './visibility.js';
import * as users from './users.js';
import { canEdit } from '../config.js';
import { validationFailed } from '../errors.js';

/**
 * People the caller may pick as an owner: owners of items the caller can
 * see, the caller, and the directory the server knows: the configured dev
 * users with the dev provider, every enabled users row with the password
 * provider. The headers provider has no directory. Only an editor in the
 * browser gets the directory (it is for the owner picker): under `password`
 * its ids are sign-in usernames, and read-only accounts and tokens have no
 * use for the list. This keeps the list from being handed out, not the
 * names secret: under `dev` /api/config lists them, and an editor's write
 * that would otherwise go through can still tell a known owner_id from an
 * unknown one (ownerNameFor). Names only; never derived from private items
 * the caller cannot see. A directory name wins over an
 * item's owner_name snapshot.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {import('../config.js').Config} config
 */
export async function list(db, user, config) {
  const pv = projectVisible('p', user);
  const tv = taskVisible('t', 'p', user);
  const { rows } = await db.query(
    `SELECT owner_id AS id, owner_name AS name FROM (
       SELECT p.owner_id, p.owner_name, p.updated_at FROM projects p WHERE ${pv.sql}
       UNION ALL
       SELECT t.owner_id, t.owner_name, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${tv.sql}
     ) x`,
    [...pv.params, ...tv.params],
  );
  /** @type {Map<string, string>} */
  const people = new Map();
  for (const r of rows) people.set(r.id, r.name); // later rows win; fine for a display snapshot
  people.set(user.id, user.name);
  if (user.via === 'ui' && canEdit(config, user)) for (const u of await directory(db, config)) people.set(u.id, u.name);
  people.delete('system'); // owns the catch-all project; never a person to pick
  return [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** @returns {Promise<Array<{id: string, name: string}>>} */
async function directory(db, config) {
  if (config.auth.provider === 'dev') return config.auth.dev.users.map((u) => ({ id: u.id, name: u.name }));
  if (config.auth.provider === 'password') return users.listEnabled(db);
  return [];
}

/**
 * The display name the server's directory has for `id` (an enabled users row
 * under `password`; a configured dev user under `dev`), or null when the
 * server does not know the id (always under `headers`). Used so a caller
 * cannot label an item "owned by bob" under a name of their choosing. A
 * disabled user counts as unknown, as in the people list, so a write cannot
 * tell a disabled account from a made-up id.
 * @param {import('../db/index.js').Db} db
 * @param {import('../config.js').Config} config
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function directoryName(db, config, id) {
  if (id === 'system') return null;
  if (config.auth.provider === 'dev') return config.auth.dev.users.find((u) => u.id === id)?.name ?? null;
  if (config.auth.provider === 'password') {
    const u = await users.get(db, id);
    return u && !u.disabled_at ? u.name : null;
  }
  return null;
}

/**
 * The owner_name to store when a write sets `owner_id` to someone other than
 * the caller. When the directory knows the id, its name wins and whatever the
 * client sent is ignored. Under `password` nobody else can be named (400 on
 * `owner_id`), so a look-alike id cannot carry a borrowed name. Otherwise
 * (`dev` for unlisted ids, always `headers`) the client's `owner_name` is
 * required and used. The project and task writes call this last, after the
 * visible read, the version check, and every other check that can refuse
 * the write, so a missing, hidden, or stale target answers exactly as it
 * would without an owner, and only a write that would go through can tell a
 * known id from an unknown one.
 * @param {import('../db/index.js').Db} db
 * @param {import('../config.js').Config} config
 * @param {string} ownerId  not the caller's own id
 * @param {string|undefined} ownerName  what the client sent
 * @returns {Promise<string>}
 */
export async function ownerNameFor(db, config, ownerId, ownerName) {
  const known = await directoryName(db, config, ownerId);
  if (known !== null) return known;
  if (config.auth.provider === 'password') throw validationFailed({ owner_id: 'must be someone who can sign in' });
  if (!ownerName) throw validationFailed({ owner_name: 'is required when owner_id is someone else' });
  return ownerName;
}
