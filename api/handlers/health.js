import { json } from '../lib/http.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/health', auth: 'none', handler: async () => json({ ok: true }) },
];
