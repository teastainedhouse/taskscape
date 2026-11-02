// Importing a project from the Markdown the export writes: plan, then run.
// planImport() turns the text into exactly what would be created, checked
// against the config and the people the importer may pick, and names the
// field and line of anything wrong (never the value). runImport() creates
// the project and its tasks in one transaction through the repo layer (no
// SQL here), with an activity entry for each, so a failure halfway leaves
// nothing behind. Both are reusable: a "duplicate project" can plan from a
// record instead of a file and run the same way.

import { parseProjectExport, ImportParseError } from './markdown-import.js';
import { validateItem, validateTag } from './validate.js';
import { ApiError, validationFailed, forbidden } from './errors.js';
import * as people from './repo/people.js';
import * as projects from './repo/projects.js';
import * as tasks from './repo/tasks.js';
import * as tags from './repo/tags.js';
import { canEdit } from './config.js';

/**
 * @typedef {{name: string, description: string, status: string, owner_id: string, owner_name: string, private: boolean, tags: string[]}} PlannedProject
 * @typedef {{title: string, status: string, owner_id: string, owner_name: string, private: boolean, due_date: string|null, notes: string, tags: string[], line: number}} PlannedTask
 * @typedef {{project: PlannedProject, tasks: PlannedTask[], comments_skipped: number, notes: string[]}} ImportPlan
 */

/** Caps, so one file cannot hold the database or fill everyone's tag picker; each is a 400 naming field and line. */
export const MAX_TAGS_PER_ITEM = 20;
export const MAX_NEW_TAGS = 50;
/** The most comma-separated parts one 40-character tag name can be split into. */
const MAX_PARTS_PER_TAG = 14;

/** Re-throw a validation error from validateItem() with the line it came from. @param {unknown} err @param {number|null} line */
function withLine(err, line) {
  if (err instanceof ApiError && err.code === 'validation_failed' && err.details?.fields && line) {
    const fields = Object.fromEntries(Object.entries(err.details.fields).map(([k, v]) => [k, `${v} (line ${line})`]));
    return validationFailed(fields);
  }
  return err;
}

/**
 * Who a name in the file maps to: exactly one person the importer may pick
 * with exactly that name. Anyone else, and any ambiguous name, is the importer.
 * @param {Array<{id: string, name: string}>} picks
 */
function ownerResolver(picks) {
  const byName = new Map();
  for (const p of picks) byName.set(p.name, byName.has(p.name) ? null : p); // null marks a duplicate name
  return (name) => (name ? byName.get(name) ?? null : null);
}

/**
 * The export joins tag names with ", ", and a tag name may itself contain a
 * comma, so the cell is regrouped against the tags that exist: the longest
 * run of parts that joins back into a known name wins; the rest stay single.
 * @param {string[]} parts  the cell split on commas
 * @param {Set<string>} known  normalized existing names
 */
export function regroupTags(parts, known) {
  const out = [];
  for (let i = 0; i < parts.length;) {
    let taken = 1;
    // a tag name is at most 40 characters and parts are joined with ", ", so no name spans more than 14 parts
    for (let len = Math.min(parts.length - i, MAX_PARTS_PER_TAG); len > 1; len--) {
      if (known.has(tags.normalizeTagName(parts.slice(i, i + len).join(', ')))) { taken = len; break; }
    }
    out.push(parts.slice(i, i + taken).join(', '));
    i += taken;
  }
  return out;
}

/**
 * What importing `text` would create.
 * @param {import('./db/index.js').Db} db
 * @param {import('./auth/index.js').Principal} user
 * @param {string} text
 * @param {import('./config.js').Config} config
 * @param {{makePrivate?: boolean}} [opts]
 * @returns {Promise<ImportPlan>}
 */
export async function planImport(db, user, text, config, { makePrivate = false } = {}) {
  if (!canEdit(config, user)) throw forbidden('Your account is read-only.');
  let parsed;
  try {
    parsed = parseProjectExport(text);
  } catch (err) {
    if (err instanceof ImportParseError) throw validationFailed({ [err.field]: `${err.problem} (line ${err.line})` });
    throw err;
  }
  // at most a page of tasks per file: one import is one request, one transaction, and one screenful of preview
  if (parsed.tasks.length > config.limits.max_page_size) {
    throw validationFailed({ tasks: `at most ${config.limits.max_page_size} tasks per import (line ${parsed.tasks[config.limits.max_page_size].line})` });
  }
  const resolve = ownerResolver(await people.list(db, user, config));
  const known = new Set((await tags.list(db)).map((x) => tags.normalizeTagName(x.name)));
  const p = parsed.project;
  const L = parsed.lines;
  // Private in the file stays private (the export of a private project says so, and publishing it by accident would
  // be the one thing an import must never do); public in the file follows the privacy default, or the make-private switch.
  const projectPrivate = makePrivate || config.privacy.default_private || p.private === true;
  const me = { id: user.id, name: user.name };
  const notes = [];
  let unmatched = 0;
  let reassigned = 0;

  /**
   * The owner a file name becomes; a private item is always the importer's (nobody makes an item
   * private for someone else). Like POST /api/projects, someone the directory does not know (under
   * `password`: a disabled account) cannot be given an item, and a directory name wins over the file's.
   */
  const directoryNames = new Map();
  const ownerFor = async (name, isPrivate) => {
    const who = resolve(name);
    if (!who) { if (name && name !== user.name) unmatched++; return me; }
    if (who.id === user.id) return me;
    if (isPrivate) { reassigned++; return me; }
    if (!directoryNames.has(who.id)) directoryNames.set(who.id, await people.directoryName(db, config, who.id));
    const known = directoryNames.get(who.id);
    if (known === null && config.auth.provider === 'password') { unmatched++; return me; }
    return { id: who.id, name: known ?? who.name };
  };

  /** Tag names regrouped against existing tags and checked like POST /api/tags, with the line. @param {string[]} parts @param {number} line */
  const tagNames = (parts, line) => {
    // the parts check comes before regrouping, which is bounded by it (a cell of thousands of commas is not an export)
    if (parts.length > MAX_TAGS_PER_ITEM * MAX_PARTS_PER_TAG) throw validationFailed({ tags: `at most ${MAX_TAGS_PER_ITEM} tags on one item (line ${line})` });
    const names = regroupTags(parts, known);
    if (names.length > MAX_TAGS_PER_ITEM) throw validationFailed({ tags: `at most ${MAX_TAGS_PER_ITEM} tags on one item (line ${line})` });
    for (const name of names) {
      try { validateTag({ name }); } catch (err) { throw withLine(validationFailed({ tags: err.details?.fields?.name ?? 'is invalid' }), line); }
    }
    return names;
  };

  /** A project-level validation error gets the line of the field it names. @param {unknown} err */
  const projectLines = (err) => {
    if (!(err instanceof ApiError) || !err.details?.fields) return err;
    const fields = Object.fromEntries(Object.entries(err.details.fields).map(([k, v]) => {
      const line = k === 'name' ? L.name : k === 'description' ? L.description : k === 'status' ? L.status : k === 'owner_id' || k === 'owner_name' ? L.owner : 0;
      return [k, line ? `${v} (line ${line})` : v];
    }));
    return validationFailed(fields);
  };

  const projectOwner = await ownerFor(p.owner_name, projectPrivate);
  const projectBody = { name: p.name, description: p.description, status: p.status ?? config.default_status.project,
    owner_id: projectOwner.id, owner_name: projectOwner.name, private: projectPrivate };
  let projectFields;
  try { projectFields = validateItem(projectBody, config, 'project', { partial: false }); } catch (err) { throw projectLines(err); }
  const projectTags = tagNames(p.tags, L.tags || L.name);

  const plannedTasks = [];
  for (const t of parsed.tasks) {
    // a private project holds only its owner's tasks, so every task in one is the importer's and private too
    const isPrivate = projectPrivate || t.private === true;
    const owner = await ownerFor(t.owner_name, isPrivate);
    const body = { title: t.title, status: t.status ?? config.default_status.task, owner_id: owner.id, owner_name: owner.name,
      private: isPrivate, due_date: t.due_date, notes: t.notes };
    let fields;
    try { fields = validateItem(body, config, 'task', { partial: false }); } catch (err) { throw withLine(err, t.line); }
    plannedTasks.push({ ...fields, owner_name: owner.name, private: isPrivate, due_date: fields.due_date ?? null, notes: fields.notes ?? '', tags: tagNames(t.tags, t.line), line: t.line });
  }

  const privateCount = (projectPrivate ? 1 : 0) + plannedTasks.filter((t) => t.private).length;
  if (unmatched) notes.push(`${unmatched} item${unmatched === 1 ? '' : 's'} named an owner nobody here matches exactly; ${unmatched === 1 ? 'it goes' : 'they go'} to you.`);
  if (reassigned) notes.push(`${reassigned} item${reassigned === 1 ? '' : 's'} named another owner but ${reassigned === 1 ? 'is' : 'are'} private, so ${reassigned === 1 ? 'it is' : 'they are'} yours: nobody makes an item private for someone else.`);
  if (privateCount) notes.push(`${privateCount} item${privateCount === 1 ? ' is' : 's are'} private to you${makePrivate ? '' : ' (marked private in the file, or by the site default)'}.`);
  if (parsed.comments_skipped) notes.push(`${parsed.comments_skipped} comment${parsed.comments_skipped === 1 ? ' was' : 's were'} not imported: a comment is signed by whoever writes it, and a file cannot sign for anyone.`);
  if (parsed.ambiguous_notes) notes.push(`${parsed.ambiguous_notes} task${parsed.ambiguous_notes === 1 ? ' shares its' : 's share a'} title with another, so notes were attached in file order; check them.`);
  // tags are a shared public vocabulary (PLAN.md §2 rule 2): new names show to everyone, private import or not
  const wanted = new Set([...projectTags, ...plannedTasks.flatMap((t) => t.tags)].map(tags.normalizeTagName).filter(Boolean));
  const fresh = [...wanted].filter((n) => !known.has(n)).length;
  if (fresh > MAX_NEW_TAGS) throw validationFailed({ tags: `at most ${MAX_NEW_TAGS} new tag names per import` });
  if (fresh) notes.push(`${fresh} tag name${fresh === 1 ? ' is' : 's are'} new and will be created; tag names and colours are shared with everyone.`);

  return {
    project: { ...projectFields, description: projectFields.description ?? '', owner_name: projectOwner.name, private: projectPrivate, tags: projectTags },
    tasks: plannedTasks,
    comments_skipped: parsed.comments_skipped,
    notes,
  };
}

/**
 * Create everything in the plan, in one transaction: tags by name (existing
 * names match), the project, then its tasks, each with an activity entry.
 * Only a plan this module built is ever run: the handler never takes one from a client.
 * @param {import('./db/index.js').Db} db
 * @param {import('./auth/index.js').Principal} user
 * @param {ImportPlan} plan
 * @param {import('./config.js').Config} config
 * @param {string} now
 * @returns {Promise<{project: object, tasks: object[]}>}
 */
export async function runImport(db, user, plan, config, now) {
  // one millisecond apart per record, so What's New lists the project before its tasks and the tasks in file order
  let tick = Date.parse(now);
  const next = () => new Date(tick++).toISOString();
  return db.transaction(async (tx) => {
    const tagIds = new Map();
    const idsFor = async (names) => {
      const out = [];
      for (const name of names) {
        const key = tags.normalizeTagName(name);
        if (!key) continue;
        if (!tagIds.has(key)) tagIds.set(key, (await tags.createIn(tx, user, { name }, config, next())).tag.id);
        if (!out.includes(tagIds.get(key))) out.push(tagIds.get(key));
      }
      return out;
    };
    const { tags: projectTags, ...projectInput } = plan.project;
    const project = await projects.createIn(tx, user, { ...projectInput, tag_ids: await idsFor(projectTags) }, config, next());
    const created = [];
    for (const t of plan.tasks) {
      const { tags: taskTags, line, ...input } = t;
      created.push(await tasks.createIn(tx, user, { ...input, project_id: project.id, tag_ids: await idsFor(taskTags) }, config, next()));
    }
    return { project, tasks: created };
  });
}
