import { json } from '../lib/http.js';
import * as tokens from '../lib/repo/tokens.js';
import { validateTokenInput } from '../lib/validate.js';
import { body } from './_shared.js';

/** All human-only: a leaked token can never mint or list tokens. */
/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/tokens', auth: 'human', handler: async (_req, ctx) => json({ items: await tokens.listForUser(ctx.db, ctx.user.id) }) },
  { method: 'POST', path: '/api/tokens', auth: 'human', handler: async (req, ctx) => {
    const { label } = validateTokenInput(await body(req, ctx));
    return json(await tokens.issue(ctx.db, ctx.user, label, ctx.now()), 201);
  } },
  // Revoking stays possible for someone who has lost edit rights: that is exactly when their tokens must die.
  { method: 'DELETE', path: '/api/tokens/:id', auth: 'human', edit: false, handler: async (_req, ctx) =>
    json(await tokens.revoke(ctx.db, ctx.user, ctx.params.id, ctx.now())) },
];
