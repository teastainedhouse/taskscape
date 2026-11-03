// Guestbook comments on a project or a task. A comment has no privacy of its
// own: it is visible exactly when its parent is (visibility.js), and once
// trashed only to its author. Editors add them; nobody edits them; only the
// author trashes and restores them, each a compare-and-set on version with an
// activity entry in the same transaction. Activity entries name the parent,
// never the text, so a trashed comment's words leave the feed with it.
//
// @mentions: "@id" in a comment's text names a person the caller may already
// pick as an owner (people.mentionable()); the names are stored with the
// comment, in its transaction, and every read returns them as `mentions`. A
// mention grants nothing: the comment, its mentions, and the For you entry
// they bring all follow the parent's visibility at read time, and a trashed
// comment's mentions reach nobody (only its author still sees them;
// repo/activity.js), so
// someone who cannot see the item learns nothing from being named.

import { newId } from '../ids.js';
import { notFound, conflict, invalidState, forbidden } from '../errors.js';
import { commentVisible, commentShown } from './visibility.js';
import { record } from './activity.js';
import * as projects from './projects.js';
import * as tasks from './tasks.js';
import * as people from './people.js';

const SELECT = 'SELECT c.* FROM comments c';

/** Live comments one guestbook holds at most, so no one can flood an item, its export, or a reader's context. */
export const MAX_PER_GUESTBOOK = 500;

/** Comment ids per query when reading mentions. */
const MENTION_CHUNK = 500;

/** People one comment mentions at most, so a comment cannot become a broadcast; later names stay plain text. */
export const MAX_MENTIONS = 20;

/**
 * "@" then an id-like word, at the start of the text or after anything but a letter, digit, "_", "@" or "." in any
 * script (so an email address is not a mention), and not running on into a letter or digit (so "@josé" is not "@jos").
 * The word is ASCII letters and digits, ".", "_", "@", "+" and "-", starting with a letter or digit; which part of it
 * names a person is decided by mentionCandidates(). The same rule as public/js/mentions.js.
 */
export const MENTION_RE = /(^|[^\p{L}\p{N}_@.])@([A-Za-z0-9][A-Za-z0-9._@+-]{0,253})(?![\p{L}\p{N}])/gu;

/**
 * What a mention word may name, longest first: the word, then the word without its trailing ".", "_", "@", "+" and
 * "-" one at a time ("@bob_" is bob_ if there is one, else bob; "@bob." at the end of a sentence is bob).
 * @param {string} word @returns {string[]}
 */
export function mentionCandidates(word) {
  const out = [word];
  let w = word;
  while (/[._@+-]$/.test(w)) { w = w.slice(0, -1); out.push(w); }
  return out;
}

/** The mention words of a text, in order, each once (as written). @param {string} text @returns {string[]} */
export function parseMentions(text) {
  const out = [];
  for (const m of String(text).matchAll(MENTION_RE)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/** @param {Record<string, any>} r */
function rowToComment(r) {
  return {
    id: r.id,
    item_type: r.item_type,
    item_id: r.item_id,
    author_id: r.author_id,
    author_name: r.author_name,
    body: r.body,
    version: Number(r.version),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at ?? null,
    mentions: [],
  };
}

/**
 * Attach `mentions` ({id, name}, in the order written) to comments read visibly. The query applies the comment
 * predicates again, so it never returns a mention of a comment the reader cannot see.
 * @param {import('../db/index.js').Db} db @param {any} user @param {any[]} list  rowToComment() results
 */
async function withMentions(db, user, list) {
  if (!list.length) return list;
  const vis = commentVisible('c', user);
  const shown = commentShown('c', user);
  const by = new Map(list.map((c) => [c.id, c]));
  // in chunks: an export reads every comment of up to a page of tasks, past any database's limit on placeholders
  for (let i = 0; i < list.length; i += MENTION_CHUNK) {
    const ids = list.slice(i, i + MENTION_CHUNK).map((c) => c.id);
    const { rows } = await db.query(
      `SELECT m.comment_id, m.person_id, m.person_name FROM comment_mentions m JOIN comments c ON c.id = m.comment_id
        WHERE m.comment_id IN (${ids.map(() => '?').join(', ')}) AND ${vis.sql} AND ${shown.sql}`,
      [...ids, ...vis.params, ...shown.params]);
    for (const r of rows) by.get(r.comment_id)?.mentions.push({ id: r.person_id, name: r.person_name });
  }
  // in the order the text names them
  for (const c of list) {
    if (c.mentions.length < 2) continue;
    const words = parseMentions(c.body);
    const place = (id) => {
      const i = words.findIndex((w) => mentionCandidates(w).some((x) => x === id || x.toLowerCase() === id));
      return i < 0 ? words.length : i;
    };
    c.mentions.sort((x, y) => place(x.id) - place(y.id));
  }
  return list;
}

/** The comment's parent, as the activity entry names it. @param {{item_type: string, item_id: string}} c */
const on = (c) => ({ on: { type: c.item_type, id: c.item_id } });

/**
 * The visible parent, or 404. With `lock`, the parent row (and a task's
 * project) is locked first, so a privacy flip or trash cannot slip in between
 * this check and the write. Projects are locked before tasks, the order a
 * privacy flip takes, so the two do not deadlock on PostgreSQL. The task's
 * project is locked again after the read in case the task moved meanwhile
 * (only that rare race takes the locks out of order).
 * @param {import('../db/index.js').Db} db @param {any} user
 * @param {'project'|'task'} type @param {string} id @param {{lock?: boolean}} [opts]
 * @returns {Promise<{record: any, trashed: 'project'|'task'|null}>}  trashed names what is in the trash, if anything
 */
async function parent(db, user, type, id, { lock = false } = {}) {
  if (type === 'project') {
    if (lock) await db.query('UPDATE projects SET version = version WHERE id = ?', [id]);
    const p = await projects.mustGet(db, user, id);
    return { record: p, trashed: p.deleted_at ? 'project' : null };
  }
  if (lock) {
    await db.query('UPDATE projects SET version = version WHERE id = (SELECT project_id FROM tasks WHERE id = ?)', [id]);
    await db.query('UPDATE tasks SET version = version WHERE id = ?', [id]);
  }
  const t = await tasks.mustGet(db, user, id);
  if (lock) await db.query('UPDATE projects SET version = version WHERE id = ?', [t.project_id]);
  const p = await projects.mustGet(db, user, t.project_id);
  return { record: t, trashed: p.deleted_at ? 'project' : t.deleted_at ? 'task' : null };
}

/**
 * The guestbook of a visible project or task, oldest first: live comments,
 * plus the caller's own trashed ones (so they can restore them).
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string} id
 */
export async function listFor(db, user, type, id) {
  await parent(db, user, type, id);
  const vis = commentVisible('c', user);
  const shown = commentShown('c', user);
  const { rows } = await db.query(
    `${SELECT} WHERE c.item_type = ? AND c.item_id = ? AND ${vis.sql} AND ${shown.sql} ORDER BY c.created_at ASC, c.id ASC`,
    [type, id, ...vis.params, ...shown.params]);
  return withMentions(db, user, rows.map(rowToComment));
}

/**
 * Live comments on many parents of one type, for the export. Trashed ones stay
 * out, even the caller's own.
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string[]} ids
 * @returns {Promise<Map<string, any[]>>} parent id -> comments, oldest first
 */
export async function liveFor(db, user, type, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const vis = commentVisible('c', user);
  const { rows } = await db.query(
    `${SELECT} WHERE c.item_type = ? AND c.item_id IN (${ids.map(() => '?').join(', ')}) AND c.deleted_at IS NULL AND ${vis.sql}
      ORDER BY c.created_at ASC, c.id ASC`,
    [type, ...ids, ...vis.params]);
  const all = await withMentions(db, user, rows.map(rowToComment));
  for (const c of all) {
    if (!out.has(c.item_id)) out.set(c.item_id, []);
    out.get(c.item_id).push(c);
  }
  return out;
}

/** Visible read by id. @param {import('../db/index.js').Db} db @param {any} user @param {string} id */
export async function get(db, user, id) {
  const vis = commentVisible('c', user);
  const shown = commentShown('c', user);
  const { rows } = await db.query(`${SELECT} WHERE c.id = ? AND ${vis.sql} AND ${shown.sql}`, [id, ...vis.params, ...shown.params]);
  return rows[0] ? (await withMentions(db, user, [rowToComment(rows[0])]))[0] : null;
}

/** @param {import('../db/index.js').Db} db @param {any} user @param {string} id */
export async function mustGet(db, user, id) {
  const c = await get(db, user, id);
  if (!c) throw notFound();
  return c;
}

/**
 * @param {import('../db/index.js').Db} tx @param {any} user @param {string} id @param {number} version
 * @param {string} setSql @param {unknown[]} setParams
 */
async function cas(tx, user, id, version, setSql, setParams) {
  const { changes } = await tx.query(
    `UPDATE comments SET ${setSql}, version = version + 1 WHERE id = ? AND version = ?`, [...setParams, id, version]);
  if (changes === 0) {
    const current = await get(tx, user, id);
    if (!current) throw notFound();
    throw conflict(current);
  }
}

/**
 * Sign the guestbook of a visible, live project or task. "@id" in the text mentions a person the caller may already
 * pick (people.mentionable()), never the author, at most MAX_MENTIONS of them.
 * @param {import('../db/index.js').Db} db @param {any} user @param {'project'|'task'} type @param {string} parentId
 * @param {string} body @param {string} now @param {import('../config.js').Config} config
 */
export async function create(db, user, type, parentId, body, now, config) {
  return db.transaction(async (tx) => {
    const { trashed } = await parent(tx, user, type, parentId, { lock: true });
    if (trashed) throw invalidState(`This ${trashed} is in the trash.`);
    await full(tx, type, parentId);
    const id = newId();
    await tx.query(
      `INSERT INTO comments (id, item_type, item_id, author_id, author_name, body, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      [id, type, parentId, user.id, user.name, body, now, now]);
    // naming yourself tells you nothing; an @word that is nobody here is just text; past MAX_MENTIONS people the rest
    // stay text too (a refusal would answer "are these all people?" without leaving a comment behind)
    const named = (await people.mentionable(tx, user, config, parseMentions(body))).filter((p) => p.id !== user.id).slice(0, MAX_MENTIONS);
    for (const p of named) {
      await tx.query('INSERT INTO comment_mentions (comment_id, person_id, person_name) VALUES (?, ?, ?)', [id, p.id, p.name]);
    }
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'create', changes: on({ item_type: type, item_id: parentId }) }, now);
    return mustGet(tx, user, id);
  });
}

/** Refuse a write that would put the guestbook over MAX_PER_GUESTBOOK live comments; the parent is locked and visible. */
async function full(tx, type, parentId) {
  const { rows } = await tx.query('SELECT COUNT(*) AS n FROM comments WHERE item_type = ? AND item_id = ? AND deleted_at IS NULL', [type, parentId]);
  if (Number(rows[0].n) >= MAX_PER_GUESTBOOK) throw invalidState('This item has as many comments as it can hold.');
}

/**
 * Move one's own comment to the trash.
 * @param {import('../db/index.js').Db} db @param {any} user @param {string} id @param {number} version @param {string} now
 */
export async function trash(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.author_id !== user.id) throw forbidden('Only the author can trash a comment.');
    if (before.deleted_at) throw invalidState('This comment is already in the trash.');
    await cas(tx, user, id, version, 'deleted_at = ?, updated_at = ?', [now, now]);
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'trash', changes: on(before) }, now);
    return mustGet(tx, user, id);
  });
}

/**
 * Bring one's own comment back, while its parent is live.
 * @param {import('../db/index.js').Db} db @param {any} user @param {string} id @param {number} version @param {string} now
 */
export async function restore(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.author_id !== user.id) throw forbidden('Only the author can restore a comment.');
    if (!before.deleted_at) throw invalidState('This comment is not in the trash.');
    const { trashed } = await parent(tx, user, before.item_type, before.item_id, { lock: true });
    if (trashed) throw invalidState(`Restore the ${trashed} first.`);
    await full(tx, before.item_type, before.item_id);
    await cas(tx, user, id, version, 'deleted_at = NULL, updated_at = ?', [now]);
    await record(tx, user, { item_type: 'comment', item_id: id, action: 'restore', changes: on(before) }, now);
    return mustGet(tx, user, id);
  });
}
