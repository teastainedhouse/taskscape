import { json } from '../lib/http.js';
import * as people from '../lib/repo/people.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/people', handler: async (_req, ctx) => json({ items: await people.list(ctx.db, ctx.user, ctx.config) }) },
];
