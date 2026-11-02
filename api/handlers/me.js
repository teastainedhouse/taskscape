import { json } from '../lib/http.js';
import { canEdit } from '../lib/config.js';
import { preferencesFor } from './preferences.js';

/**
 * The Me shape (docs/API.md §4), preferences included so pages get them with
 * the one call they already make. Also the body of a successful POST /api/login.
 * @param {import('../lib/db/index.js').Db} db
 * @param {import('../lib/config.js').Config} config
 * @param {import('../lib/auth/index.js').Principal} u
 */
export const meBody = async (db, config, u) => ({
  id: u.id, name: u.name, email: u.email ?? null, auth: u.auth, can_edit: canEdit(config, u),
  preferences: await preferencesFor(db, config, u),
});

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/me', handler: async (_req, ctx) => json(await meBody(ctx.db, ctx.config, ctx.user)) },
];
