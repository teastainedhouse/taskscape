import { json } from '../lib/http.js';
import { canEdit } from '../lib/config.js';
import { preferencesFor } from './preferences.js';
import { todayFor } from '../lib/repo/preferences.js';
import { nowIso } from '../lib/time.js';

/**
 * The Me shape (docs/API.md §4), preferences included so pages get them with
 * the one call they already make. Also the body of a successful POST /api/login.
 * @param {import('../lib/db/index.js').Db} db
 * @param {import('../lib/config.js').Config} config
 * @param {import('../lib/auth/index.js').Principal} u
 */
export const meBody = async (db, config, u, now = nowIso()) => ({
  id: u.id, name: u.name, email: u.email ?? null, auth: u.auth, can_edit: canEdit(config, u),
  preferences: await preferencesFor(db, config, u),
  // the server's today for this person (their time zone, else the site's): the browser marks overdue by it
  today: (await todayFor(db, config, u.id, now)).today,
});

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/me', handler: async (_req, ctx) => json(await meBody(ctx.db, ctx.config, ctx.user, ctx.now())) },
];
