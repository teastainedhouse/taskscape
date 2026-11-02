import { json } from '../lib/http.js';
import * as checklist from '../lib/repo/checklist.js';
import { validateChecklistItem, validateVersionOnly } from '../lib/validate.js';
import { body } from './_shared.js';

/** Checklist items on a task: each write is a compare-and-set on the task's version and returns the task. */
/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'POST', path: '/api/tasks/:id/checklist', handler: async (req, ctx) => {
    const { version, ...input } = validateChecklistItem(await body(req, ctx), { partial: false });
    return json(await checklist.add(ctx.db, ctx.user, ctx.params.id, version, input, ctx.now()), 201);
  } },
  { method: 'PATCH', path: '/api/tasks/:id/checklist/:itemId', handler: async (req, ctx) => {
    const { version, ...input } = validateChecklistItem(await body(req, ctx), { partial: true });
    return json(await checklist.update(ctx.db, ctx.user, ctx.params.id, ctx.params.itemId, version, input, ctx.now()));
  } },
  { method: 'DELETE', path: '/api/tasks/:id/checklist/:itemId', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await checklist.trash(ctx.db, ctx.user, ctx.params.id, ctx.params.itemId, version, ctx.now()));
  } },
];
