import { readJson } from '../lib/http.js';
import { validationFailed } from '../lib/errors.js';
import * as people from '../lib/repo/people.js';

/** Read the JSON body with the configured size limit. */
export const body = (req, ctx) => readJson(req, ctx.config.limits.body_bytes);

/**
 * Settle `owner_name` when a caller sets `owner_id` to someone else. When the
 * server's directory knows the id (an enabled password user, a configured dev
 * user), its name is used and whatever the client sent is ignored. Under
 * `password` nobody else can be named, so a look-alike id cannot carry a
 * borrowed name. Otherwise (`dev` for unlisted ids, always `headers`) the
 * client must send a display name.
 * @param {Record<string, unknown>} fields  from validateItem(); changed in place
 * @param {import('../lib/router.js').Ctx} ctx
 */
export async function resolveOwnerName(fields, ctx) {
  if (fields.owner_id === undefined || fields.owner_id === ctx.user.id) return;
  const known = await people.directoryName(ctx.db, ctx.config, /** @type {string} */ (fields.owner_id));
  if (known !== null) fields.owner_name = known;
  else if (ctx.config.auth.provider === 'password') throw validationFailed({ owner_id: 'must be someone who can sign in' });
  else if (!fields.owner_name) throw validationFailed({ owner_name: 'is required when owner_id is someone else' });
}
