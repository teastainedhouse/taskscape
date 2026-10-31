import { json } from '../lib/http.js';
import { validationFailed } from '../lib/errors.js';
import * as projects from '../lib/repo/projects.js';
import * as tasks from '../lib/repo/tasks.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/search', handler: async (_req, ctx) => {
    const q = (ctx.query.q ?? '').trim();
    const limit = ctx.query.limit === undefined ? 20 : Number(ctx.query.limit);
    const errors = {};
    if (q.length < 2) errors.q = 'must be at least 2 characters';
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.limit = 'must be 1 to 100';
    if (Object.keys(errors).length) throw validationFailed(errors);
    const f = { q, include_trashed: 'false', sort: 'updated_at', dir: 'DESC', limit, offset: 0 };
    const [p, t] = await Promise.all([
      projects.list(ctx.db, ctx.user, f, ctx.config),
      tasks.list(ctx.db, ctx.user, f, ctx.config),
    ]);
    return json({ projects: p, tasks: t });
  } },
];
