import { json } from '../lib/http.js';
import * as activity from '../lib/repo/activity.js';
import { parseActivityQuery } from '../lib/validate.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/activity', handler: async (_req, ctx) =>
    json(await activity.list(ctx.db, ctx.user, parseActivityQuery(ctx.query))) },
];
