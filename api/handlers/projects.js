import { json } from '../lib/http.js';
import * as projects from '../lib/repo/projects.js';
import { validateItem, validateVersionOnly, parseListQuery } from '../lib/validate.js';
import { body, requireOwnerName } from './_shared.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/projects', handler: async (_req, ctx) => {
    const f = parseListQuery(ctx.query, ctx.config, 'project');
    const items = await projects.list(ctx.db, ctx.user, f, ctx.config);
    return json({ items, limit: f.limit, offset: f.offset });
  } },
  { method: 'POST', path: '/api/projects', handler: async (req, ctx) => {
    const fields = validateItem(await body(req, ctx), ctx.config, 'project', { partial: false });
    requireOwnerName(fields, ctx.user);
    return json(await projects.create(ctx.db, ctx.user, fields, ctx.config, ctx.now()), 201);
  } },
  { method: 'GET', path: '/api/projects/:id', handler: async (_req, ctx) => json(await projects.mustGet(ctx.db, ctx.user, ctx.params.id)) },
  { method: 'PATCH', path: '/api/projects/:id', handler: async (req, ctx) => {
    const fields = validateItem(await body(req, ctx), ctx.config, 'project', { partial: true });
    requireOwnerName(fields, ctx.user);
    const { project, moved_tasks } = await projects.update(ctx.db, ctx.user, ctx.params.id, fields, ctx.config, ctx.now());
    return json(moved_tasks === undefined ? project : { ...project, moved_tasks });
  } },
  { method: 'DELETE', path: '/api/projects/:id', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await projects.trash(ctx.db, ctx.user, ctx.params.id, version, ctx.config, ctx.now()));
  } },
  { method: 'POST', path: '/api/projects/:id/restore', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await projects.restore(ctx.db, ctx.user, ctx.params.id, version, ctx.now()));
  } },
  { method: 'PUT', path: '/api/projects/:id/tags/:tagId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await projects.setTag(ctx.db, ctx.user, ctx.params.id, ctx.params.tagId, version, true, ctx.now()));
  } },
  { method: 'DELETE', path: '/api/projects/:id/tags/:tagId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await projects.setTag(ctx.db, ctx.user, ctx.params.id, ctx.params.tagId, version, false, ctx.now()));
  } },
  { method: 'POST', path: '/api/projects/:id/hit', auth: 'human', handler: async (_req, ctx) =>
    json(await projects.recordHit(ctx.db, ctx.user, ctx.params.id)) },
];
