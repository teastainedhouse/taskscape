import { json } from '../lib/http.js';
import * as tags from '../lib/repo/tags.js';
import { validateTag } from '../lib/validate.js';
import { body } from './_shared.js';

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/tags', handler: async (_req, ctx) => json({ items: await tags.list(ctx.db) }) },
  { method: 'POST', path: '/api/tags', handler: async (req, ctx) => {
    const input = validateTag(await body(req, ctx));
    const { tag, created } = await tags.create(ctx.db, ctx.user, input, ctx.config, ctx.now());
    return json(tag, created ? 201 : 200);
  } },
];
