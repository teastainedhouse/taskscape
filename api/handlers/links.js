import { json } from '../lib/http.js';
import * as links from '../lib/repo/links.js';
import { validateLink, validateVersionOnly } from '../lib/validate.js';
import { body } from './_shared.js';

/** Links on a task: each write is a compare-and-set on the task's version and returns the task. */
/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'POST', path: '/api/tasks/:id/links', handler: async (req, ctx) => {
    const { version, ...input } = validateLink(await body(req, ctx), { partial: false });
    return json(await links.add(ctx.db, ctx.user, ctx.params.id, version, input, ctx.now()), 201);
  } },
  { method: 'PATCH', path: '/api/tasks/:id/links/:linkId', handler: async (req, ctx) => {
    const { version, ...input } = validateLink(await body(req, ctx), { partial: true });
    return json(await links.update(ctx.db, ctx.user, ctx.params.id, ctx.params.linkId, version, input, ctx.now()));
  } },
  { method: 'DELETE', path: '/api/tasks/:id/links/:linkId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await links.trash(ctx.db, ctx.user, ctx.params.id, ctx.params.linkId, version, ctx.now()));
  } },
];
