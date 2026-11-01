import { json } from '../lib/http.js';
import { canEdit } from '../lib/config.js';

/**
 * The Me shape (docs/API.md §4). Also the body of a successful POST /api/login.
 * @param {import('../lib/config.js').Config} config
 * @param {import('../lib/auth/index.js').Principal} u
 */
export const meBody = (config, u) => ({ id: u.id, name: u.name, email: u.email ?? null, auth: u.auth, can_edit: canEdit(config, u) });

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/me', handler: async (_req, ctx) => json(meBody(ctx.config, ctx.user)) },
];
