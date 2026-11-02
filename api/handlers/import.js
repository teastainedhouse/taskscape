import { json, readText } from '../lib/http.js';
import { validationFailed, unsupportedMediaType } from '../lib/errors.js';
import { planImport, runImport } from '../lib/import.js';

/** @param {string|undefined} v  a boolean query flag; anything but true/false is 400 */
function flag(name, v) {
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  throw validationFailed({ [name]: 'must be true or false' });
}

/**
 * POST /api/projects/import: the body is the Markdown an export produces
 * (text/markdown). `?dry_run=true` answers with what would be created and
 * writes nothing; `?private=true` makes everything private to the caller.
 * Registered before the project routes, so "import" is never read as an id.
 * @type {import('../lib/router.js').Route[]}
 */
export const routes = [
  { method: 'POST', path: '/api/projects/import', accepts: ['text/markdown'], handler: async (req, ctx) => {
    if ((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'text/markdown') throw unsupportedMediaType(); // the body is a Markdown file, from anyone
    const dryRun = flag('dry_run', ctx.query.dry_run);
    const makePrivate = flag('private', ctx.query.private);
    const text = await readText(req, ctx.config.limits.body_bytes);
    const plan = await planImport(ctx.db, ctx.user, text, ctx.config, { makePrivate });
    if (dryRun) return json({ dry_run: true, ...plan });
    const made = await runImport(ctx.db, ctx.user, plan, ctx.config, ctx.now());
    return json({ ...made, comments_skipped: plan.comments_skipped, notes: plan.notes }, 201);
  } },
];
