/**
 * THE privacy and trash predicates. Every read in api/lib/repo goes through
 * these; nothing else in the codebase decides who may see what.
 *
 * Rules (docs/PLAN.md §3):
 *  - a project is visible to its owner, or to everyone when public
 *  - a task is visible when the task AND its project are visible
 *  - a non-owner reaching a private item gets the same 404 as a missing id
 *  - a comment has no privacy of its own: it shows to whoever can see its
 *    parent project or task, and once trashed only to its author
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

/**
 * A comment's parent (project or task) is visible to the user.
 * @param {string} c  alias of the comments table
 * @param {{id: string}} user
 * @returns {Fragment}
 */
export function commentVisible(c, user) {
  const p = projectVisible('cvp', user);
  const t = taskVisible('cvt', 'cvtp', user);
  return {
    sql: `((${c}.item_type = 'project' AND EXISTS (SELECT 1 FROM projects cvp WHERE cvp.id = ${c}.item_id AND ${p.sql}))
      OR (${c}.item_type = 'task' AND EXISTS (
            SELECT 1 FROM tasks cvt JOIN projects cvtp ON cvtp.id = cvt.project_id WHERE cvt.id = ${c}.item_id AND ${t.sql})))`,
    params: [...p.params, ...t.params],
  };
}

/**
 * A trashed comment shows only to its author (who alone may restore it).
 * @param {string} c  alias of the comments table
 * @param {{id: string}} user
 * @returns {Fragment}
 */
export function commentShown(c, user) {
  return { sql: `(${c}.deleted_at IS NULL OR ${c}.author_id = ?)`, params: [user.id] };
}

/**
 * An activity entry is visible when the item it is about is visible NOW, so
 * flipping an item private hides its history too. Tag entries are public; a
 * comment's entries follow its parent (they never carry the comment's text).
 * @param {string} a  alias of the activity table
 * @param {{id: string}} user
 * @returns {Fragment}
 */
export function activityVisible(a, user) {
  const p = projectVisible('vp', user);
  const t = taskVisible('vt', 'vtp', user);
  const c = commentVisible('vc', user);
  return {
    sql: `(${a}.item_type = 'tag'
      OR (${a}.item_type = 'project' AND EXISTS (SELECT 1 FROM projects vp WHERE vp.id = ${a}.item_id AND ${p.sql}))
      OR (${a}.item_type = 'task' AND EXISTS (
            SELECT 1 FROM tasks vt JOIN projects vtp ON vtp.id = vt.project_id WHERE vt.id = ${a}.item_id AND ${t.sql}))
      OR (${a}.item_type = 'comment' AND EXISTS (SELECT 1 FROM comments vc WHERE vc.id = ${a}.item_id AND ${c.sql})))`,
    params: [...p.params, ...t.params, ...c.params],
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
