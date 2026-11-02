import { json } from '../lib/http.js';
import * as preferences from '../lib/repo/preferences.js';
import { validatePreferences } from '../lib/validate.js';
import { body } from './_shared.js';

/** The caller's effective preferences (site defaults overlaid with their choices). */
export const preferencesFor = async (db, config, user) => preferences.effective(config, await preferences.get(db, user.id));

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/me/preferences', handler: async (_req, ctx) => json(await preferencesFor(ctx.db, ctx.config, ctx.user)) },
  // Human-only (a token sets nobody's theme) and self-scoped, so a read-only account still picks its own theme.
  { method: 'PATCH', path: '/api/me/preferences', auth: 'human', edit: false, handler: async (req, ctx) => {
    const fields = validatePreferences(await body(req, ctx), ctx.config);
    const row = await preferences.set(ctx.db, ctx.user.id, fields, ctx.now());
    return json(preferences.effective(ctx.config, row));
  } },
];
