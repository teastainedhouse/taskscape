import { json } from '../lib/http.js';
import { publicConfig } from '../lib/config.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/config', handler: async (_req, ctx) => json(publicConfig(ctx.config)) },
];
