import { json } from '../lib/http.js';
import { canEdit } from '../lib/config.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/me',
    handler: async (_req, ctx) => {
      const u = ctx.user;
      return json({ id: u.id, name: u.name, email: u.email ?? null, auth: u.auth, can_edit: canEdit(ctx.config, u) });
    },
  },
];
