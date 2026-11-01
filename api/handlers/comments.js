import { json } from '../lib/http.js';
import * as comments from '../lib/repo/comments.js';
import { validateComment, validateVersionOnly } from '../lib/validate.js';
import { body } from './_shared.js';

/** GET and POST for one parent type's guestbook. @param {'project'|'task'} type */
const guestbook = (type) => [
  { method: 'GET', path: `/api/${type}s/:id/comments`, handler: async (_req, ctx) =>
    json({ items: await comments.listFor(ctx.db, ctx.user, type, ctx.params.id) }) },
  { method: 'POST', path: `/api/${type}s/:id/comments`, handler: async (req, ctx) => {
    const { body: text } = validateComment(await body(req, ctx));
    return json(await comments.create(ctx.db, ctx.user, type, ctx.params.id, text, ctx.now()), 201);
  } },
];

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  ...guestbook('project'),
  ...guestbook('task'),
  { method: 'DELETE', path: '/api/comments/:id', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await comments.trash(ctx.db, ctx.user, ctx.params.id, version, ctx.now()));
  } },
  { method: 'POST', path: '/api/comments/:id/restore', handler: async (req, ctx) => {
    const { version } = validateVersionOnly(await body(req, ctx));
    return json(await comments.restore(ctx.db, ctx.user, ctx.params.id, version, ctx.now()));
  } },
];
