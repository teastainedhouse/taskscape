import { validationFailed } from './errors.js';
import * as tagsRepo from './repo/tags.js';

const READ_ONLY = ['id', 'created_at', 'updated_at', 'deleted_at', 'hit_count', 'tags', 'project_name'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** @param {string} s */
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param {Record<string, unknown>} body
 * @param {import('./config.js').Config} config
 * @param {'project'|'task'} kind
 * @param {{partial: boolean}} opts  partial = PATCH
 * @returns {Record<string, unknown>} the cleaned fields (plus version on PATCH)
 */
export function validateItem(body, config, kind, { partial }) {
  /** @type {Record<string,string>} */
  const errors = {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of READ_ONLY) if (k in body) errors[k] = 'read-only';
  if (partial) {
    if (!Number.isInteger(body.version) || body.version < 1) errors.version = 'is required and must be a positive integer';
    else out.version = body.version;
  } else if ('version' in body) errors.version = 'read-only';

  const str = (k, { min = 0, max = 200, required = false } = {}) => {
    const v = body[k];
    if (v === undefined) { if (required && !partial) errors[k] = 'is required'; return; }
    if (typeof v !== 'string') { errors[k] = 'must be a string'; return; }
    const trimmed = v.trim();
    if (trimmed.length < min) { errors[k] = min === 1 ? 'must not be empty' : `must be at least ${min} characters`; return; }
    if (trimmed.length > max) { errors[k] = `must be at most ${max} characters`; return; }
    out[k] = k === 'description' || k === 'notes' ? v : trimmed;
  };
  if (kind === 'project') str('name', { min: 1, max: 200, required: true });
  else str('title', { min: 1, max: 200, required: true });
  str(kind === 'project' ? 'description' : 'notes', { max: 20_000 });
  if ('status' in body) {
    if (!config.statuses[kind].includes(body.status)) errors.status = `must be one of the configured ${kind} statuses`;
    else out.status = body.status;
  }
  if ('owner_id' in body) {
    if (typeof body.owner_id !== 'string' || !body.owner_id.trim() || body.owner_id.length > 200) errors.owner_id = 'must be a non-empty string';
    else out.owner_id = body.owner_id.trim();
  }
  if ('owner_name' in body) {
    if (!('owner_id' in body)) errors.owner_name = 'can only be set together with owner_id';
    else if (typeof body.owner_name !== 'string' || !body.owner_name.trim() || body.owner_name.length > 200) errors.owner_name = 'must be a non-empty string';
    else out.owner_name = body.owner_name.trim();
  }
  if ('private' in body) {
    if (typeof body.private !== 'boolean') errors.private = 'must be true or false';
    else out.private = body.private;
  }
  if (kind === 'task') {
    if ('project_id' in body) {
      if (body.project_id === null && partial) errors.project_id = 'must be a project id';
      else if (body.project_id !== null && (typeof body.project_id !== 'string' || !body.project_id)) errors.project_id = 'must be a project id';
      else if (typeof body.project_id === 'string') out.project_id = body.project_id;
    }
    if ('due_date' in body) {
      if (body.due_date === null) out.due_date = null;
      else if (typeof body.due_date !== 'string' || !validDate(body.due_date)) errors.due_date = 'must be YYYY-MM-DD or null';
      else out.due_date = body.due_date;
    }
  }
  if ('tag_ids' in body) {
    if (partial) errors.tag_ids = 'use the tag routes to change tags';
    else if (!Array.isArray(body.tag_ids) || body.tag_ids.some((x) => typeof x !== 'string' || !x)) errors.tag_ids = 'must be an array of tag ids';
    else out.tag_ids = [...new Set(body.tag_ids)];
  }
  if (Object.keys(errors).length) throw validationFailed(errors);
  return out;
}

/** @param {Record<string, unknown>} body @returns {{version: number}} */
export function validateVersionOnly(body) {
  if (!Number.isInteger(body.version) || body.version < 1) throw validationFailed({ version: 'is required and must be a positive integer' });
  return { version: body.version };
}

/** @param {Record<string, unknown>} body @returns {{name: string, color?: string}} */
export function validateTag(body) {
  const errors = {};
  const out = {};
  if (typeof body.name !== 'string' || !tagsRepo.normalizeTagName(body.name)) errors.name = 'must not be empty';
  else if (tagsRepo.normalizeTagName(body.name).length > 40) errors.name = 'must be at most 40 characters';
  else out.name = body.name;
  if ('color' in body && body.color !== undefined) {
    if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) errors.color = 'must be #rrggbb';
    else out.color = body.color.toLowerCase();
  }
  if (Object.keys(errors).length) throw validationFailed(errors);
  return out;
}

/** @param {Record<string, unknown>} body @returns {{label: string}} */
export function validateTokenInput(body) {
  if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 100) {
    throw validationFailed({ label: 'must be 1 to 100 characters' });
  }
  return { label: body.label.trim() };
}

const PROJECT_SORTS = ['updated_at', 'created_at', 'name', 'status', 'owner_name'];
const TASK_SORTS = [...PROJECT_SORTS.filter((s) => s !== 'name'), 'title', 'due_date'];
const ASC_DEFAULT = new Set(['name', 'title', 'due_date']);

/**
 * Parse and validate list query parameters (docs/API.md §5).
 * @param {Record<string,string>} q
 * @param {import('./config.js').Config} config
 * @param {'project'|'task'} kind
 */
export function parseListQuery(q, config, kind) {
  const errors = {};
  const sorts = kind === 'project' ? PROJECT_SORTS : TASK_SORTS;
  const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const f = {
    status: csv(q.status)?.filter((s) => config.statuses[kind].includes(s)),
    owner: q.owner || undefined,
    tag: csv(q.tag),
    q: q.q?.trim() || undefined,
    include_trashed: q.include_trashed ?? 'false',
    sort: q.sort || 'updated_at',
    dir: q.dir,
  };
  if (kind === 'task') {
    f.project = q.project || undefined;
    for (const k of ['due_before', 'due_after']) {
      if (q[k]) { if (validDate(q[k])) f[k] = q[k]; else errors[k] = 'must be YYYY-MM-DD'; }
    }
  }
  if (!['false', 'true', 'only'].includes(f.include_trashed)) errors.include_trashed = 'must be false, true, or only';
  if (!sorts.includes(f.sort)) errors.sort = `must be one of ${sorts.join(', ')}`;
  if (!f.dir) f.dir = ASC_DEFAULT.has(f.sort) ? 'asc' : 'desc';
  if (!['asc', 'desc'].includes(f.dir)) errors.dir = 'must be asc or desc';
  f.dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = q.limit === undefined ? config.limits.page_size : Number(q.limit);
  const offset = q.offset === undefined ? 0 : Number(q.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.limits.max_page_size) errors.limit = `must be 1 to ${config.limits.max_page_size}`;
  if (!Number.isInteger(offset) || offset < 0) errors.offset = 'must be a non-negative integer';
  f.limit = limit; f.offset = offset;
  if (Object.keys(errors).length) throw validationFailed(errors);
  return f;
}

/** @param {Record<string,string>} q */
export function parseActivityQuery(q) {
  const errors = {};
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) errors.limit = 'must be 1 to 200';
  if (q.item_type && !['project', 'task', 'tag'].includes(q.item_type)) errors.item_type = 'must be project, task, or tag';
  if (q.via && !['ui', 'mcp'].includes(q.via)) errors.via = 'must be ui or mcp';
  if (Object.keys(errors).length) throw validationFailed(errors);
  return { limit, before: q.before || undefined, item_type: q.item_type || undefined, item_id: q.item_id || undefined,
    project: q.project || undefined, actor: q.actor || undefined, via: q.via || undefined };
}
