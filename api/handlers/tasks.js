import { json } from '../lib/http.js';
import * as tasks from '../lib/repo/tasks.js';
import { validateItem, validateVersionOnly, parseListQuery } from '../lib/validate.js';
import { body, requireOwnerName } from './_shared.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/tasks', handler: async (_req, ctx) => {
    const f = parseListQuery(ctx.query, ctx.config, 'task');
    const items = await tasks.list(ctx.db, ctx.user, f, ctx.config);
    return json({ items, limit: f.limit, offset: f.offset });
  } },
  { method: 'POST', path: '/api/tasks', handler: async (req, ctx) => {
    const fields = validateItem(await body(req, ctx), ctx.config, 'task', { partial: false });
    requireOwnerName(fields, ctx.user);
    return json(await tasks.create(ctx.db, ctx.user, fields, ctx.config, ctx.now()), 201);
  } },
  { method: 'GET', path: '/api/tasks/:id', handler: async (_req, ctx) => json(await tasks.mustGet(ctx.db, ctx.user, ctx.params.id)) },
  { method: 'PATCH', path: '/api/tasks/:id', handler: async (req, ctx) => {
    const fields = validateItem(await body(req, ctx), ctx.config, 'task', { partial: true });
    requireOwnerName(fields, ctx.user);
    return json(await tasks.update(ctx.db, ctx.user, ctx.params.id, fields, ctx.config, ctx.now()));
  } },
  { method: 'DELETE', path: '/api/tasks/:id', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await tasks.trash(ctx.db, ctx.user, ctx.params.id, version, ctx.now()));
  } },
  { method: 'POST', path: '/api/tasks/:id/restore', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await tasks.restore(ctx.db, ctx.user, ctx.params.id, version, ctx.now()));
  } },
  { method: 'PUT', path: '/api/tasks/:id/tags/:tagId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await tasks.setTag(ctx.db, ctx.user, ctx.params.id, ctx.params.tagId, version, true, ctx.now()));
  } },
  { method: 'DELETE', path: '/api/tasks/:id/tags/:tagId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await tasks.setTag(ctx.db, ctx.user, ctx.params.id, ctx.params.tagId, version, false, ctx.now()));
  } },
];
