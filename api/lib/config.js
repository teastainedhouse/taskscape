import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Config
 * @property {string} site_title
 * @property {string} theme
 * @property {{project: string[], task: string[]}} statuses
 * @property {{project: string[], task: string[]}} closed_statuses
 * @property {{project: string, task: string}} default_status
 * @property {string[]} tag_palette
 * @property {string[]} task_fields
 * @property {object} default_views
 * @property {{default_private: boolean}} privacy
 * @property {{edit: 'everyone'|'group', groups: string[]}} permissions
 * @property {Array<{name: string, url: string}>} webring
 * @property {{page_size: number, max_page_size: number, body_bytes: number}} limits
 * @property {{id: string, name: string, description?: string}} catch_all_project
 * @property {{provider: 'dev'|'headers', headers: object, dev: {default_user: string, users: Array<{id:string,name:string,email?:string,groups?:string[]}>}}} auth
 * @property {string} env  'development' | 'production' | 'test'
 */

/**
 * Load, validate, and apply environment overrides to the config file.
 * @param {string} [file]  defaults to TASKSCAPE_CONFIG or ./taskscape.config.json
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(file, env = process.env) {
  const resolved = path.resolve(file ?? env.TASKSCAPE_CONFIG ?? 'taskscape.config.json');
  const raw = JSON.parse(readFileSync(resolved, 'utf8'));
  return prepareConfig(raw, env);
}

/**
 * Validate a config object (already parsed) and apply env overrides.
 * @param {object} raw
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function prepareConfig(raw, env = process.env) {
  const config = structuredClone(raw);
  config.env = env.TASKSCAPE_ENV || 'development';
  if (env.TASKSCAPE_AUTH_PROVIDER) config.auth = { ...config.auth, provider: env.TASKSCAPE_AUTH_PROVIDER };
  validate(config);
  return config;
}

/** @param {Config} c */
function validate(c) {
  const fail = (msg) => { throw new Error(`taskscape.config.json: ${msg}`); };
  for (const kind of ['project', 'task']) {
    const list = c.statuses?.[kind];
    if (!Array.isArray(list) || list.length === 0) fail(`statuses.${kind} must be a non-empty array`);
    if (new Set(list).size !== list.length) fail(`statuses.${kind} has duplicates`);
    if (!list.includes(c.default_status?.[kind])) fail(`default_status.${kind} must be one of statuses.${kind}`);
    for (const s of c.closed_statuses?.[kind] ?? []) if (!list.includes(s)) fail(`closed_statuses.${kind} contains unknown status`);
  }
  if (!Array.isArray(c.tag_palette) || c.tag_palette.some((x) => !/^#[0-9a-f]{6}$/i.test(x))) fail('tag_palette must be #rrggbb colors');
  if (!c.catch_all_project?.id || !c.catch_all_project?.name) fail('catch_all_project needs id and name');
  if (!['everyone', 'group'].includes(c.permissions?.edit)) fail('permissions.edit must be "everyone" or "group"');
  if (!['dev', 'headers'].includes(c.auth?.provider)) fail('auth.provider must be "dev" or "headers"');
  if (c.auth.provider === 'dev') {
    if (c.env === 'production') fail('the dev identity provider cannot be used when TASKSCAPE_ENV=production');
    const users = c.auth.dev?.users;
    if (!Array.isArray(users) || users.length === 0) fail('auth.dev.users must list at least one user');
    if (new Set(users.map((u) => u.id)).size !== users.length) fail('auth.dev.users ids must be unique');
    if (!users.some((u) => u.id === c.auth.dev.default_user)) fail('auth.dev.default_user must be one of auth.dev.users');
  }
  c.limits = { page_size: 500, max_page_size: 1000, body_bytes: 262144, ...(c.limits ?? {}) };
  c.privacy = { default_private: false, ...(c.privacy ?? {}) };
  c.permissions = { groups: [], ...c.permissions };
  c.webring = Array.isArray(c.webring) ? c.webring : [];
}

/**
 * The subset of the config the browser may see. Never header names.
 * @param {Config} c
 */
export function publicConfig(c) {
  const out = {
    site_title: c.site_title,
    theme: c.theme,
    statuses: c.statuses,
    closed_statuses: c.closed_statuses,
    default_status: c.default_status,
    tag_palette: c.tag_palette,
    task_fields: c.task_fields,
    default_views: c.default_views,
    privacy: c.privacy,
    permissions: { edit: c.permissions.edit },
    webring: c.webring,
    limits: { page_size: c.limits.page_size },
    catch_all_project_id: c.catch_all_project.id,
    auth: { provider: c.auth.provider },
  };
  if (c.auth.provider === 'dev') out.auth.dev_users = c.auth.dev.users.map((u) => ({ id: u.id, name: u.name }));
  return out;
}

/**
 * @param {Config} c
 * @param {import('./auth/index.js').Principal} user
 * @returns {boolean}
 */
export function canEdit(c, user) {
  if (c.permissions.edit === 'everyone') return true;
  const groups = user.groups ?? []; // for a token principal: the groups snapshotted when the token was issued
  return c.permissions.groups.some((g) => groups.includes(g));
}
