import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMENTS_LABELS, validTimeZone } from './validate.js';

/** Where the themes live: public/css/theme-<name>.css, relative to this repo. */
const PUBLIC_CSS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'css');

/**
 * @typedef {Object} Config
 * @property {string} site_title
 * @property {{project: string[], task: string[]}} statuses
 * @property {{project: string[], task: string[]}} closed_statuses
 * @property {{project: string, task: string}} default_status
 * @property {string[]} priorities  task priorities, highest first; a task's priority is one of these or null
 * @property {{task: string[]}} attention_statuses  task statuses that need someone's attention (the Today page)
 * @property {string[]} tag_palette
 * @property {string[]} task_fields
 * @property {object} default_views
 * @property {{default_private: boolean}} privacy
 * @property {{edit: 'everyone'|'group', groups: string[]}} permissions
 * @property {Array<{name: string, url: string}>} webring
 * @property {{page_size: number, max_page_size: number, body_bytes: number}} limits
 * @property {{id: string, name: string, description?: string}} catch_all_project
 * @property {{provider: 'dev'|'headers'|'password', headers: object, dev: {default_user: string, users: Array<{id:string,name:string,email?:string,groups?:string[]}>}, password: {session_days: number, cookie_name: string}}} auth
 * @property {string} theme  the site's default theme; each theme is public/css/theme-<name>.css
 * @property {string[]} themes  the themes people may pick from
 * @property {{comments_label: 'Comments'|'Guestbook', shortcuts: boolean, time_zone: string}} preference_defaults
 * @property {string|null} public_url  the site's address for links in feeds (else the request's origin)
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
  if (env.TASKSCAPE_PUBLIC_URL) config.public_url = env.TASKSCAPE_PUBLIC_URL;
  if (env.TASKSCAPE_AUTH_PROVIDER) config.auth = { ...config.auth, provider: env.TASKSCAPE_AUTH_PROVIDER };
  validate(config);
  return config;
}

/** @param {Config} c */
function validate(c) {
  const fail = (msg) => { throw new Error(`taskscape.config.json: ${msg}`); };
  // a name in a comma-separated list filter (?status=, ?priority=) is split on commas and trimmed, so no name may hold either
  const listName = (x) => typeof x === 'string' && x.trim() !== '' && x === x.trim() && !x.includes(',') && x.length <= 40;
  for (const kind of ['project', 'task']) {
    const list = c.statuses?.[kind];
    if (!Array.isArray(list) || list.length === 0) fail(`statuses.${kind} must be a non-empty array`);
    if (!list.every(listName)) fail(`statuses.${kind} must be names of 1 to 40 characters, without commas or spaces at either end`);
    if (new Set(list).size !== list.length) fail(`statuses.${kind} has duplicates`);
    if (!list.includes(c.default_status?.[kind])) fail(`default_status.${kind} must be one of statuses.${kind}`);
    for (const s of c.closed_statuses?.[kind] ?? []) if (!list.includes(s)) fail(`closed_statuses.${kind} contains unknown status`);
  }
  c.priorities = c.priorities ?? ['High', 'Medium', 'Low'];
  if (!Array.isArray(c.priorities) || !c.priorities.every(listName)) fail('priorities must be names of 1 to 40 characters, without commas or spaces at either end');
  if (new Set(c.priorities).size !== c.priorities.length) fail('priorities has duplicates');
  c.attention_statuses = { task: [], ...(c.attention_statuses ?? {}) };
  if (!Array.isArray(c.attention_statuses.task) || c.attention_statuses.task.some((s) => !c.statuses.task.includes(s))) fail('attention_statuses.task must list task statuses');
  if (!Array.isArray(c.tag_palette) || c.tag_palette.some((x) => !/^#[0-9a-f]{6}$/i.test(x))) fail('tag_palette must be #rrggbb colors');
  if (!c.catch_all_project?.id || !c.catch_all_project?.name) fail('catch_all_project needs id and name');
  if (!['everyone', 'group'].includes(c.permissions?.edit)) fail('permissions.edit must be "everyone" or "group"');
  if (!['dev', 'headers', 'password'].includes(c.auth?.provider)) fail('auth.provider must be "dev", "headers", or "password"');
  c.auth.password = { session_days: 30, cookie_name: '__Host-taskscape_session', ...(c.auth.password ?? {}) };
  const pw = c.auth.password;
  if (!Number.isInteger(pw.session_days) || pw.session_days < 1 || pw.session_days > 365) fail('auth.password.session_days must be an integer from 1 to 365');
  if (typeof pw.cookie_name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pw.cookie_name)) fail('auth.password.cookie_name must be 1 to 64 letters, digits, _ or -');
  if (c.auth.provider === 'dev') {
    if (c.env === 'production') fail('the dev identity provider cannot be used when TASKSCAPE_ENV=production');
    const users = c.auth.dev?.users;
    if (!Array.isArray(users) || users.length === 0) fail('auth.dev.users must list at least one user');
    if (new Set(users.map((u) => u.id)).size !== users.length) fail('auth.dev.users ids must be unique');
    if (!users.some((u) => u.id === c.auth.dev.default_user)) fail('auth.dev.default_user must be one of auth.dev.users');
  }
  if (c.themes !== undefined && (!Array.isArray(c.themes) || c.themes.length === 0)) fail('themes must be a non-empty array of theme names');
  c.theme = c.theme ?? (Array.isArray(c.themes) ? c.themes[0] : 'toolbar');
  c.themes = Array.isArray(c.themes) ? c.themes : [c.theme];
  // The file check runs where public/ is present (dev, tests, a single-process host); a function bundled
  // without public/css skips it rather than refusing to start, since the static host serves the files.
  const checkFiles = existsSync(PUBLIC_CSS);
  for (const name of c.themes) {
    if (typeof name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(name)) fail('themes must be short lowercase names (a-z, 0-9, -)');
    if (checkFiles && !existsSync(path.join(PUBLIC_CSS, `theme-${name}.css`))) fail(`theme "${name}" needs public/css/theme-${name}.css`);
  }
  if (new Set(c.themes).size !== c.themes.length) fail('themes has duplicates');
  if (!c.themes.includes(c.theme)) fail('theme must be one of themes');
  c.preference_defaults = { comments_label: 'Comments', shortcuts: true, time_zone: 'UTC', ...(c.preference_defaults ?? {}) };
  const pd = c.preference_defaults;
  if (!COMMENTS_LABELS.includes(pd.comments_label)) fail(`preference_defaults.comments_label must be ${COMMENTS_LABELS.join(' or ')}`);
  if (typeof pd.shortcuts !== 'boolean') fail('preference_defaults.shortcuts must be true or false');
  if (!validTimeZone(pd.time_zone)) fail('preference_defaults.time_zone must be an IANA time zone name');
  if (c.public_url !== undefined && c.public_url !== null) {
    let u = null;
    try { u = new URL(c.public_url); } catch { /* refused below */ }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('public_url must be an http or https URL with no query, fragment or credentials');
    c.public_url = u.href.replace(/\/+$/, '');
  } else c.public_url = null;
  // feed links carry their secret in the path: in production they must be built for https, never from a request's own origin
  if (c.env === 'production' && !(c.public_url ?? '').startsWith('https://')) fail('public_url (or TASKSCAPE_PUBLIC_URL) must be an https URL when TASKSCAPE_ENV=production, so feed links are never sent in the clear');
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
    statuses: c.statuses,
    closed_statuses: c.closed_statuses,
    default_status: c.default_status,
    priorities: c.priorities,
    attention_statuses: c.attention_statuses,
    tag_palette: c.tag_palette,
    task_fields: c.task_fields,
    default_views: c.default_views,
    privacy: c.privacy,
    permissions: { edit: c.permissions.edit },
    webring: c.webring,
    limits: { page_size: c.limits.page_size, max_page_size: c.limits.max_page_size, body_bytes: c.limits.body_bytes },
    catch_all_project_id: c.catch_all_project.id,
    theme: c.theme,
    themes: c.themes,
    preference_defaults: { comments_label: c.preference_defaults.comments_label, shortcuts: c.preference_defaults.shortcuts, time_zone: c.preference_defaults.time_zone },
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
