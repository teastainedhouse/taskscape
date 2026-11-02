import { newId } from '../ids.js';
import { notFound, conflict, invalidState, forbidden } from '../errors.js';
import { taskVisible, visibleTaskRef, live, likeContains } from './visibility.js';
import { rowToTask, tagsFor, statusOrder, diff } from './common.js';
import { record } from './activity.js';
import * as tags from './tags.js';
import * as projects from './projects.js';
import * as people from './people.js';
import * as links from './links.js';
import * as checklist from './checklist.js';
import * as preferences from './preferences.js';
import { nextDue, isMonthEnd, dayOfMonth, addDays } from '../recurrence.js';
import { validDate } from '../validate.js';

const SETTABLE = ['project_id', 'title', 'status', 'priority', 'owner_id', 'owner_name', 'private', 'due_date', 'notes', 'recurrence'];
const SORTS = { updated_at: 't.updated_at', created_at: 't.created_at', title: 'LOWER(t.title)', status: null, owner_name: 'LOWER(t.owner_name)', due_date: null, priority: null };
/** The task columns, with recurred_from and recurred_to as ids only when the reader can see that task. @param {{id: string}} user */
function select(user) {
  const from = visibleTaskRef('t.recurred_from', user);
  const to = visibleTaskRef('t.recurred_to', user);
  return { sql: `SELECT t.*, ${from.sql} AS recurred_from_ref, ${to.sql} AS recurred_to_ref, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id`,
    params: [...from.params, ...to.params] };
}

/** Tags, links and the checklist for rows already read through the visibility predicate. */
async function withTags(db, user, rows) {
  const ids = rows.map((r) => r.id);
  // one after another: inside a transaction `db` is one client, which must not run two queries at once
  const tagMap = await tagsFor(db, 'task', ids);
  const linkMap = await links.linksFor(db, user, ids);
  const checkMap = await checklist.checklistFor(db, user, ids);
  return rows.map((r) => ({ ...rowToTask(r, tagMap.get(r.id)), links: linkMap.get(r.id) ?? [], checklist: checkMap.get(r.id) ?? [] }));
}

/** Visible read by id (trash state ignored). */
export async function get(db, user, id) {
  const vis = taskVisible('t', 'p', user);
  const s = select(user);
  const { rows } = await db.query(`${s.sql} WHERE t.id = ? AND ${vis.sql}`, [...s.params, id, ...vis.params]);
  if (!rows[0]) return null;
  return (await withTags(db, user, rows))[0];
}

/**
 * The task just handed over, for the writer's answer, though they may no longer see it. Its own row, links and
 * checklist are read as its new owner, who can always see their own task (a private project holds only its owner's
 * tasks); but the ids of the other task in its recurring pair are judged by the writer, the one reading the answer,
 * so a handover never names a task the writer cannot see.
 */
async function unsafeGet(db, id, writer) {
  const s = select(writer);
  const { rows } = await db.query(`${s.sql} WHERE t.id = ?`, [...s.params, id]);
  return rows[0] ? (await withTags(db, { id: rows[0].owner_id }, rows))[0] : null;
}

export async function mustGet(db, user, id) {
  const t = await get(db, user, id);
  if (!t) throw notFound();
  return t;
}

/**
 * @param {{project?: string, status?: string[], priority?: string[], owner?: string, tag?: string[], q?: string, due_before?: string, due_after?: string, open?: boolean, include_trashed: string, sort: string, dir: string, limit: number, offset: number}} f
 */
export async function list(db, user, f, config) {
  const vis = taskVisible('t', 'p', user);
  const where = [vis.sql];
  const params = [...vis.params];
  if (f.include_trashed === 'only') where.push('t.deleted_at IS NOT NULL');
  else if (f.include_trashed !== 'true') where.push(live('t'), live('p'));
  if (f.project) { where.push('t.project_id = ?'); params.push(f.project); }
  if (f.status?.length) { where.push(`t.status IN (${f.status.map(() => '?').join(', ')})`); params.push(...f.status); }
  if (f.priority?.length) { where.push(`t.priority IN (${f.priority.map(() => '?').join(', ')})`); params.push(...f.priority); }
  if (f.owner) { where.push('t.owner_id = ?'); params.push(f.owner === 'me' ? user.id : f.owner); }
  if (f.tag?.length) {
    where.push(`EXISTS (SELECT 1 FROM task_tags j JOIN tags g ON g.id = j.tag_id WHERE j.task_id = t.id AND g.name IN (${f.tag.map(() => '?').join(', ')}))`);
    params.push(...f.tag.map(tags.normalizeTagName));
  }
  if (f.q) {
    // title, notes, the task's live links (a URL or a label is often what someone remembers), and its checklist items
    where.push(`(LOWER(t.title) LIKE ? ESCAPE '\\' OR LOWER(t.notes) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM task_links ql
      WHERE ql.task_id = t.id AND ql.deleted_at IS NULL AND (LOWER(ql.url) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ql.label, '')) LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM task_checklist_items qc WHERE qc.task_id = t.id AND qc.deleted_at IS NULL AND LOWER(qc.text) LIKE ? ESCAPE '\\'))`);
    const l = likeContains(f.q); params.push(l, l, l, l, l);
  }
  // `due` needs the caller's today (f.today, from preferences.todayFor()); overdue also means not in a closed status.
  // `open` (internal callers only, such as the calendar feed) is that status rule alone, so closed rows never use up the limit.
  const closedList = config.closed_statuses.task;
  if ((f.due === 'overdue' || f.open) && closedList.length) { where.push(`t.status NOT IN (${closedList.map(() => '?').join(', ')})`); params.push(...closedList); }
  if (f.due === 'overdue') {
    where.push('t.due_date IS NOT NULL AND t.due_date < ?'); params.push(f.today);
  } else if (f.due === 'today') { where.push('t.due_date = ?'); params.push(f.today); }
  else if (f.due === 'week') { where.push('t.due_date >= ? AND t.due_date <= ?'); params.push(f.today, addDays(f.today, 6)); }
  if (f.closed_since) { where.push('t.closed_at IS NOT NULL AND t.closed_at >= ?'); params.push(f.closed_since); }
  if (f.due_before) { where.push('t.due_date IS NOT NULL AND t.due_date <= ?'); params.push(f.due_before); }
  if (f.due_after) { where.push('t.due_date >= ?'); params.push(f.due_after); }
  let order;
  if (f.sort === 'status') { const so = statusOrder(config.statuses.task, 't.status'); order = `${so.sql} ${f.dir}`; params.push(...so.params); }
  // priority sorts in config order like status; in either direction a name no longer configured comes after the
  // configured ones, and a task without one comes last
  else if (f.sort === 'priority') {
    const po = statusOrder(config.priorities, 't.priority');
    const known = config.priorities.length ? `WHEN t.priority IN (${config.priorities.map(() => '?').join(', ')}) THEN 0 ` : '';
    order = `CASE WHEN t.priority IS NULL THEN 2 ${known}ELSE 1 END ASC, ${po.sql} ${f.dir}`;
    params.push(...config.priorities, ...po.params);
  }
  else if (f.sort === 'due_date') order = `CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END ASC, t.due_date ${f.dir}`;
  else order = `${SORTS[f.sort]} ${f.dir}`;
  params.push(f.limit, f.offset);
  const s = select(user);
  const { rows } = await db.query(`${s.sql} WHERE ${where.join(' AND ')} ORDER BY ${order}, t.id ASC LIMIT ? OFFSET ?`, [...s.params, ...params]);
  return withTags(db, user, rows);
}

/**
 * Enforce "a private project only contains its owner's tasks" for a task
 * that is about to live in `project` with owner `ownerId`.
 */
function checkInvariant(project, ownerId) {
  if (project.private && project.owner_id !== ownerId) {
    throw invalidState("A private project can only contain its owner's tasks.");
  }
}

/**
 * Load a project visibly, after taking its row lock. The no-op UPDATE makes a
 * concurrent privacy flip (which updates the same row) finish first, so the
 * invariant check below sees the project's committed state on both databases.
 */
async function lockedProject(tx, user, projectId) {
  await tx.query('UPDATE projects SET version = version WHERE id = ?', [projectId]);
  return projects.mustGet(tx, user, projectId);
}

/** Load the target project visibly; refuse trashed targets. */
async function targetProject(tx, user, projectId) {
  const p = await lockedProject(tx, user, projectId);
  if (p.deleted_at) throw invalidState('That project is in the trash.');
  return p;
}

/**
 * @param {{project_id?: string, title: string, status?: string, priority?: string|null, owner_id?: string, owner_name?: string, private?: boolean, due_date?: string|null, notes?: string, tag_ids?: string[], links?: Array<{url: string, label: string|null}>, checklist?: Array<{text: string, done?: boolean}>}} input
 *   `links`, `checklist` and `closed_at` only from internal callers (the import and the duplicate), already validated;
 *   `closed_at` (null for unknown) is kept only when the task is created in a closed status
 */
export async function create(db, user, input, config, now) {
  return db.transaction((tx) => createIn(tx, user, input, config, now));
}

/**
 * Must run inside db.transaction(): the activity entry, the row locks and the visible read-back all
 * assume it (pass the `tx` the transaction hands you, never `db`).
 * create() inside a transaction the caller holds (the import makes a project and its tasks in one).
 * @param {import('../db/index.js').Db} tx
 */
export async function createIn(tx, user, input, config, now) {
  if (!tx.inTransaction) throw new Error('createIn must run inside db.transaction()');
  const id = input.id ?? newId();
  const ownerId = input.owner_id ?? user.id;
  const projectId = input.project_id ?? config.catch_all_project.id;
  const row = {
    id, project_id: projectId, title: input.title, status: input.status ?? config.default_status.task, priority: input.priority ?? null,
    recurrence: input.recurrence ?? null, recurred_from: input.recurred_from ?? null,
    owner_id: ownerId, owner_name: user.name, private: input.private ?? config.privacy.default_private,
    due_date: input.due_date ?? null, notes: input.notes ?? '',
  };
  if (row.private && row.owner_id !== user.id) throw invalidState('Only the owner can make an item private. Create it as yourself or public.');
  {
    const project = await targetProject(tx, user, projectId);
    checkInvariant(project, ownerId);
    const tagList = [];
    for (const tagId of input.tag_ids ?? []) tagList.push(await tags.mustExist(tx, tagId));
    // last check: see people.js. A recurring task's next copy keeps its owner (`copyOwnerName`, the directory's name
    // when there is one, else the stored one): nobody chose a new owner, so a disabled account must not block a close.
    if (ownerId !== user.id) row.owner_name = input.copyOwnerName ?? await people.ownerNameFor(tx, config, ownerId, input.owner_name);
    await tx.query(
      `INSERT INTO tasks (id, project_id, title, status, priority, owner_id, owner_name, private, due_date, notes, recurrence, recurred_from, closed_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, row.project_id, row.title, row.status, row.priority, row.owner_id, row.owner_name, row.private, row.due_date, row.notes, row.recurrence, row.recurred_from,
        config.closed_statuses.task.includes(row.status) ? (input.closed_at !== undefined ? input.closed_at : now) : null, now, now]);
    for (const tag of tagList) await tx.query('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)', [id, tag.id]);
    const linkList = (input.links ?? []).slice(0, links.MAX_LINKS);
    await links.insertIn(tx, user, id, linkList, now);
    const checkList = (input.checklist ?? []).slice(0, checklist.MAX_ITEMS);
    await checklist.insertIn(tx, user, id, checkList, now);
    const tagNames = tagList.map((tag) => tag.name);
    const changes = Object.fromEntries(SETTABLE.map((k) => [k, { to: row[k] }]));
    if (tagNames.length) changes.tags = { to: tagNames.sort() };
    if (linkList.length) changes.links = { to: linkList.map((l) => ({ url: l.url, label: l.label ?? null })) };
    if (checkList.length) changes.checklist = { to: checkList.map((c) => ({ text: c.text, done: c.done === true })) };
    if (row.recurred_from) changes.recurred_from = { to: row.recurred_from };
    await record(tx, user, { item_type: 'task', item_id: id, action: 'create', changes }, now);
    return mustGet(tx, user, id);
  }
}

/** Compare-and-set, like projects.js; with `setSql` null it checks the version and bumps nothing. */
async function cas(tx, user, id, version, setSql, setParams = []) {
  const set = setSql === null ? 'version = version' : `${setSql}, version = version + 1`;
  const { changes } = await tx.query(
    `UPDATE tasks SET ${set} WHERE id = ? AND version = ?`, [...setParams, id, version]);
  if (changes === 0) {
    const current = await get(tx, user, id);
    if (!current) throw notFound();
    throw conflict(current);
  }
}

/**
 * @param {{version: number} & Partial<{project_id: string, title: string, status: string, priority: string|null, owner_id: string, owner_name: string, private: boolean, due_date: string|null, notes: string}>} input
 */
export async function update(db, user, id, input, config, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This task is in the trash. Restore it before editing.');
    const next = { ...before };
    for (const k of SETTABLE) if (input[k] !== undefined) next[k] = input[k];
    if (next.private !== before.private && before.owner_id !== user.id) {
      throw forbidden('Only the owner can change whether a task is private.');
    }
    // as on create: nobody makes an item private for someone else (handing over an already private item is fine)
    if (next.private && !before.private && next.owner_id !== user.id) {
      throw invalidState('Only the owner can make an item private. Make it private first, then hand it over.');
    }
    if (next.owner_id !== before.owner_id) {
      if (next.owner_id === user.id) next.owner_name = user.name;
    } else if (before.owner_id === user.id) {
      next.owner_name = user.name;
    }
    if (before.version !== input.version) throw conflict(before); // so `before` is the row the locked version check approves
    const projectChanged = next.project_id !== before.project_id;
    const ownerChanged = next.owner_id !== before.owner_id;
    if (projectChanged || ownerChanged) { // either one makes the change non-empty, so this always ran before the write
      const project = projectChanged ? await targetProject(tx, user, next.project_id) : await lockedProject(tx, user, before.project_id);
      checkInvariant(project, next.owner_id);
    }
    if (input.owner_id !== undefined && input.owner_id !== user.id) { // last check: see people.js
      next.owner_name = await people.ownerNameFor(tx, config, input.owner_id, input.owner_name);
    }
    const changes = diff(before, next, SETTABLE);
    if (Object.keys(changes).length === 0) { // no stored value would change, so not a write: check the version only
      await cas(tx, user, id, input.version, null);
      return mustGet(tx, user, id);
    }
    // The owner's own name refresh rides along silently, and is logged only when it is the whole change.
    if (changes.owner_name && !changes.owner_id && before.owner_id === user.id && Object.keys(changes).length > 1) delete changes.owner_name;
    // Closing a recurring task makes its next copy, once: a task that already produced one never makes another
    // (reopening and closing again, or a copy in the trash, PLAN.md §2 rule 17).
    const closed = config.closed_statuses.task;
    // No copy (and no recurred_to, so a later close still makes one) when the task's project is in the trash, or when
    // this same write hands a private task to someone else: its copy could only be private to them, and nobody makes
    // an item private for someone else (rule 6).
    // Cheap conditions first; a possible copy then takes the project's row lock BEFORE the task's (the CAS below),
    // the order a project write uses, so a close racing a privacy flip queues instead of deadlocking on PostgreSQL.
    const mayCopy = !!next.recurrence && closed.includes(next.status) && !closed.includes(before.status);
    const projectLive = mayCopy ? !(await lockedProject(tx, user, next.project_id)).deleted_at : false;
    const makesCopy = mayCopy && projectLive && !(await unsafeStoredRecurredTo(tx, id)) && !(next.private && next.owner_id !== user.id);
    const copyId = makesCopy ? newId() : null;
    if (copyId) changes.recurred_to = { from: null, to: copyId };
    await cas(tx, user, id, input.version,
      'project_id = ?, title = ?, status = ?, priority = ?, owner_id = ?, owner_name = ?, private = ?, due_date = ?, notes = ?, recurrence = ?, recurred_to = COALESCE(?, recurred_to), closed_at = ?, updated_at = ?',
      [next.project_id, next.title, next.status, next.priority, next.owner_id, next.owner_name, next.private, next.due_date, next.notes, next.recurrence, copyId,
        closed.includes(next.status) ? (closed.includes(before.status) ? before.closed_at : now) : null, now]); // staying closed keeps it, even unknown
    await record(tx, user, { item_type: 'task', item_id: id, action: 'update', changes }, now);
    if (copyId) await makeNextCopy(tx, user, { ...before, ...next }, copyId, config, now);
    // Only a reassignment can hide the task from its writer, and that path holds the project's row lock, so the
    // unfiltered read cannot pick up a concurrent privacy flip. Any other edit re-reads visibly: if a concurrent
    // flip hid the task meanwhile, the 404 rolls this write back.
    return ownerChanged ? unsafeGet(tx, id, user) : mustGet(tx, user, id);
  });
}

/**
 * A task's stored recurred_to, which select() hides when the reader cannot see the copy. Only for the copy-once check,
 * inside the closing transaction after the visible read of that same task; never returned to anyone.
 * @param {import('../db/index.js').Db} tx @param {string} id
 */
async function unsafeStoredRecurredTo(tx, id) {
  return (await tx.query('SELECT recurred_to FROM tasks WHERE id = ?', [id])).rows[0]?.recurred_to ?? null;
}

/** A task's stored recurred_from, for anchorDay() only (inside the closing transaction; the task it names is then read visibly). */
async function unsafeRecurredFrom(tx, id) {
  return (await tx.query('SELECT recurred_from FROM tasks WHERE id = ?', [id])).rows[0]?.recurred_from ?? null;
}

/**
 * The day of the month a monthly or yearly series means. Usually the old due date's day; when that date is the
 * last day of its month, it may have been cut short (the 31st landing on the 30th), so the previous copies say
 * what was meant: the largest day among them, walking back through month ends (at most four steps, enough for
 * a 29 February that fell on the 28th for three years). Only copies the user can see are read.
 */
async function anchorDay(tx, task) {
  const owner = { id: task.owner_id }; // the series is the owner's: read it as they see it, whoever closes
  let day = dayOfMonth(task.due_date);
  let cur = task;
  for (let i = 0, from = await unsafeRecurredFrom(tx, task.id); i < 4 && isMonthEnd(cur.due_date) && from; i++) {
    const prev = await get(tx, owner, from);
    if (!prev?.due_date || prev.recurrence !== task.recurrence) break;
    day = Math.max(day, dayOfMonth(prev.due_date));
    cur = prev;
    from = await unsafeRecurredFrom(tx, prev.id);
  }
  return day;
}

/**
 * Create the next copy of a recurring task that `user` just closed, in the same transaction: same title, project,
 * owner, priority, privacy, tags, notes, links and recurrence; the checklist with every item unticked; the default
 * status; the due date moved forward from the old one (or from today in the owner's time zone when it had none).
 * Its create entry names the task it came from.
 */
async function makeNextCopy(tx, user, task, copyId, config, now) {
  const from = task.due_date ?? (await preferences.todayFor(tx, config, task.owner_id, now)).today;
  const anchor = ['monthly', 'yearly'].includes(task.recurrence) && task.due_date ? await anchorDay(tx, task) : undefined;
  const due = nextDue(from, task.recurrence, anchor);
  if (!validDate(due)) throw invalidState('The next due date would be past the year 9999. Change the due date or stop the repeat, then close it.');
  const at = new Date(Date.parse(now) + 1).toISOString(); // its entry sorts after the close
  await createIn(tx, user, {
    id: copyId, project_id: task.project_id, title: task.title, status: config.default_status.task, priority: task.priority,
    owner_id: task.owner_id, copyOwnerName: (await people.directoryName(tx, config, task.owner_id)) ?? task.owner_name, private: task.private, due_date: due,
    notes: task.notes, recurrence: task.recurrence, recurred_from: task.id,
    tag_ids: task.tags.map((t) => t.id),
    links: task.links.map((l) => ({ url: l.url, label: l.label })),
    checklist: task.checklist.map((c) => ({ text: c.text, done: false })),
  }, config, at);
}

export async function trash(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This task is already in the trash.');
    await cas(tx, user, id, version, 'deleted_at = ?, updated_at = ?', [now, now]);
    await record(tx, user, { item_type: 'task', item_id: id, action: 'trash', changes: {} }, now);
    return mustGet(tx, user, id);
  });
}

export async function restore(db, user, id, version, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (!before.deleted_at) throw invalidState('This task is not in the trash.');
    const project = await lockedProject(tx, user, before.project_id);
    if (project.deleted_at) throw invalidState('Restore the project first.');
    checkInvariant(project, before.owner_id);
    await cas(tx, user, id, version, 'deleted_at = NULL, updated_at = ?', [now]);
    await record(tx, user, { item_type: 'task', item_id: id, action: 'restore', changes: {} }, now);
    return mustGet(tx, user, id);
  });
}

/**
 * A write to something that belongs to a task (a link, a checklist item), done the way tag attach and detach are:
 * the task is read visibly (else 404), refused when trashed, and version-checked; `apply(tx, task)` makes the change
 * and returns the activity entry's `changes`, or null when nothing would change (then it is not a write: the version
 * is checked under the row lock and nothing is bumped or logged, as in PLAN.md §2 rule 11). Otherwise the task's
 * version and updated_at move and the entry is recorded, all in one transaction, so a stale version rolls back
 * whatever `apply` wrote.
 * @param {import('../db/index.js').Db} db
 * @param {(tx: import('../db/index.js').Db, task: any) => Promise<Record<string, unknown>|null>} apply
 */
export async function childWrite(db, user, id, version, now, apply) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This task is in the trash.');
    if (before.version !== version) throw conflict(before);
    // The task's row lock first, with the version check under it, before any child row is touched: two writes to
    // one task's children then queue on the task instead of locking child rows in different orders (a deadlock
    // on PostgreSQL), and the second meets the 409.
    await cas(tx, user, id, version, null);
    const changes = await apply(tx, before);
    if (!changes) return mustGet(tx, user, id);
    await tx.query('UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?', [now, id]);
    await record(tx, user, { item_type: 'task', item_id: id, action: 'update', changes }, now);
    return mustGet(tx, user, id);
  });
}

export async function setTag(db, user, id, tagId, version, attach, now) {
  return db.transaction(async (tx) => {
    const before = await mustGet(tx, user, id);
    if (before.deleted_at) throw invalidState('This task is in the trash.');
    await tags.mustExist(tx, tagId);
    if (before.version !== version) throw conflict(before); // the no-op decision below reads `before`
    if (before.tags.some((t) => t.id === tagId) === attach) {
      await cas(tx, user, id, version, null); // already as asked: check the version, write nothing
      return mustGet(tx, user, id);
    }
    await cas(tx, user, id, version, 'updated_at = ?', [now]);
    if (attach) await tx.query('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)', [id, tagId]);
    else await tx.query('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?', [id, tagId]);
    const after = await mustGet(tx, user, id);
    const changes = { tags: { from: before.tags.map((t) => t.name), to: after.tags.map((t) => t.name) } };
    await record(tx, user, { item_type: 'task', item_id: id, action: 'update', changes }, now);
    return after;
  });
}
