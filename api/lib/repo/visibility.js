/**
 * THE privacy and trash predicates. Every read in api/lib/repo goes through
 * these; nothing else in the codebase decides who may see what.
 *
 * Rules (docs/PLAN.md §3):
 *  - a project is visible to its owner, or to everyone when public
 *  - a task is visible when the task AND its project are visible
 *  - a non-owner reaching a private item gets the same 404 as a missing id
 */

/** @typedef {{ sql: string, params: unknown[] }} Fragment */

/**
 * @param {string} p  alias of the projects table
 * @param {{id: string}} user
 * @returns {Fragment}
 */
export function projectVisible(p, user) {
  return { sql: `(${p}.private = 0 OR ${p}.owner_id = ?)`, params: [user.id] };
}

/**
 * @param {string} t  alias of the tasks table
 * @param {string} p  alias of the joined projects table
 * @param {{id: string}} user
 * @returns {Fragment}
 */
export function taskVisible(t, p, user) {
  return {
    sql: `(${t}.private = 0 OR ${t}.owner_id = ?) AND (${p}.private = 0 OR ${p}.owner_id = ?)`,
    params: [user.id, user.id],
  };
}

/** @param {string} alias @returns {string} */
export function live(alias) {
  return `${alias}.deleted_at IS NULL`;
}

/**
 * Trash filter for a list.
 * @param {string} alias
 * @param {'false'|'true'|'only'} mode  include_trashed
 * @returns {string}
 */
export function trashState(alias, mode) {
  if (mode === 'true') return '1 = 1';
  if (mode === 'only') return `${alias}.deleted_at IS NOT NULL`;
  return live(alias);
}

/**
 * Escape a user string for use inside a LIKE pattern with ESCAPE '\'.
 * @param {string} s
 */
export function likeContains(s) {
  return '%' + s.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}
