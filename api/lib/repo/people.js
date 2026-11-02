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
export async function list(db, user, config, { directory: withDirectory = user.via === 'ui' && canEdit(config, user) } = {}) {
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
  if (withDirectory) for (const u of await directory(db, config)) people.set(u.id, u.name);
  people.delete('system'); // owns the catch-all project; never a person to pick
  return [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Mention words resolved per comment at most; the rest are text (a 2000-character body holds few real mentions). */
const MAX_MENTION_WORDS = 64;
/** Trailing characters taken off a mention word at most, when looking for who it names. */
const MAX_STRIPPED = 3;

/**
 * Who a comment by `user` mentions, from its mention words (comments.parseMentions()), looking up only the ids
 * named. A word names, longest candidate first (comments.mentionCandidates()):
 *   - an id exactly, if it is someone this caller may already pick (/api/people): an owner of an item the caller can
 *     see, the caller, or (an editor in the browser) the directory, so a mention never tells anyone an id or name
 *     they could not already list (an MCP token never resolves the directory);
 *   - a directory id is tried first, exactly and then ignoring case, and only the directory matches loosely, so an
 *     owner id made up to differ from a real person only in case cannot take that person's mentions.
 * The name stored is the directory's, else the newest owner_name the caller can see for that id.
 * A mention grants nothing (repo/comments.js), so naming someone who cannot see the item only stores the name.
 * @param {import('../db/index.js').Db} db
 * @param {import('../auth/index.js').Principal} user
 * @param {import('../config.js').Config} config
 * @param {string[]} words  as written after the @
 * @returns {Promise<Array<{id: string, name: string}>>}  in the order of `words`, each person once
 */
export async function mentionable(db, user, config, words) {
  if (!words.length) return [];
  const { mentionCandidates } = await import('./comments.js');
  // at most a few trailing characters come off a word: enough for "@bob_." and a sentence's punctuation, and a bound
  // on the ids looked up (a word of 200 dashes would otherwise try 200 ids)
  const tries = words.slice(0, MAX_MENTION_WORDS).map((w) => mentionCandidates(w).slice(0, MAX_STRIPPED + 1));
  const ids = [...new Set(tries.flat().flatMap((c) => [c, c.toLowerCase()]))];
  const pv = projectVisible('p', user);
  const tv = taskVisible('t', 'p', user);
  const marks = ids.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT owner_id AS id, owner_name AS name, updated_at FROM (
       SELECT p.owner_id, p.owner_name, p.updated_at FROM projects p WHERE p.owner_id IN (${marks}) AND ${pv.sql}
       UNION ALL
       SELECT t.owner_id, t.owner_name, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.owner_id IN (${marks}) AND ${tv.sql}
     ) x ORDER BY updated_at ASC`,
    [...ids, ...pv.params, ...ids, ...tv.params]);
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const r of rows) owners.set(r.id, r.name); // newest last, so it wins
  owners.delete('system');
  const withDirectory = user.via === 'ui' && canEdit(config, user);
  // every candidate's directory name at once (one query under password), never one lookup per id
  const dir = await directoryNames(db, config, ids);
  const dirName = async (id) => dir.get(id) ?? null;
  /** May the caller pick `id`? Its name if so, else null. @param {string} id */
  const pickable = async (id) => {
    const known = await dirName(id);
    if (id === user.id) return known ?? user.name;
    if (owners.has(id)) return known ?? owners.get(id);
    return withDirectory ? known : null;
  };
  const out = new Map();
  for (const candidates of tries) {
    let found = null;
    for (const c of candidates) {
      const lower = c.toLowerCase();
      // a directory person first, exactly or ignoring case, then anyone else exactly: an owner id made up to differ
      // from a real person only in case never takes a mention that, folded, names them
      let name = null;
      if ((await dirName(c)) !== null && (name = await pickable(c)) !== null) { found = { id: c, name }; break; }
      if (lower !== c && (await dirName(lower)) !== null && (name = await pickable(lower)) !== null) { found = { id: lower, name }; break; }
      if ((name = await pickable(c)) !== null) { found = { id: c, name }; break; }
    }
    if (found && !out.has(found.id)) out.set(found.id, found);
  }
  return [...out.values()];
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
 * directoryName() for many ids at once: id -> name for those the directory knows.
 * @param {import('../db/index.js').Db} db @param {import('../config.js').Config} config @param {string[]} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function directoryNames(db, config, ids) {
  const wanted = ids.filter((id) => id !== 'system');
  if (config.auth.provider === 'dev') {
    const known = new Map(config.auth.dev.users.map((u) => [u.id, u.name]));
    return new Map(wanted.filter((id) => known.has(id)).map((id) => [id, known.get(id)]));
  }
  if (config.auth.provider === 'password') return users.enabledNames(db, wanted);
  return new Map();
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
