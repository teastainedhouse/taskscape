import { json } from '../lib/http.js';
import * as projects from '../lib/repo/projects.js';
import * as tasks from '../lib/repo/tasks.js';

const byDeleted = (a, b) => (b.deleted_at > a.deleted_at ? 1 : b.deleted_at < a.deleted_at ? -1 : 0);

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/trash', handler: async (_req, ctx) => {
    const f = { include_trashed: 'only', sort: 'updated_at', dir: 'DESC', limit: ctx.config.limits.max_page_size, offset: 0 };
    const [p, t] = await Promise.all([
      projects.list(ctx.db, ctx.user, f, ctx.config),
      tasks.list(ctx.db, ctx.user, f, ctx.config),
    ]);
    return json({ projects: p.sort(byDeleted), tasks: t.sort(byDeleted) });
  } },
];
