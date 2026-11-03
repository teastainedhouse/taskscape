import { json, readText } from '../lib/http.js';
import { validationFailed, unsupportedMediaType } from '../lib/errors.js';
import { planImport, planDuplicate, runImport } from '../lib/import.js';
import { validateDuplicate } from '../lib/validate.js';
import { body } from './_shared.js';

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
  // POST /api/projects/:id/duplicate: a new project from what the caller sees of this one, built from its records and
  // run through the import's rules (lib/import.js planDuplicate()), in one transaction with an activity entry for everything created
  { method: 'POST', path: '/api/projects/:id/duplicate', handler: async (req, ctx) => {
    const opts = validateDuplicate(await body(req, ctx));
    const plan = await planDuplicate(ctx.db, ctx.user, ctx.params.id, opts, ctx.config);
    const made = await runImport(ctx.db, ctx.user, plan, ctx.config, ctx.now());
    return json({ ...made, notes: plan.notes }, 201);
  } },
];
