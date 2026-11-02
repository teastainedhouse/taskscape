import { text } from '../lib/http.js';
import * as projects from '../lib/repo/projects.js';
import * as tasks from '../lib/repo/tasks.js';
import * as comments from '../lib/repo/comments.js';
import { renderProjectExport, slug } from '../lib/markdown.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/projects/:id/export.md', handler: async (_req, ctx) => {
    const project = await projects.mustGet(ctx.db, ctx.user, ctx.params.id);
    // a trashed project's tasks went with it and come back with it, so its export keeps them; tasks trashed on their own stay out
    const all = await tasks.list(ctx.db, ctx.user,
      { project: project.id, include_trashed: project.deleted_at ? 'true' : 'false', sort: 'due_date', dir: 'ASC', limit: ctx.config.limits.max_page_size, offset: 0 }, ctx.config);
    const items = all.filter((t) => !t.deleted_at);
    const guestbook = {
      project: (await comments.liveFor(ctx.db, ctx.user, 'project', [project.id])).get(project.id) ?? [],
      tasks: await comments.liveFor(ctx.db, ctx.user, 'task', items.map((t) => t.id)),
    };
    const md = renderProjectExport(project, items, { userName: ctx.user.name, date: ctx.now().slice(0, 10) }, guestbook);
    return text(md, 'text/markdown; charset=utf-8', 200, { 'Content-Disposition': `attachment; filename="${slug(project.name)}.md"` });
  } },
];
