import { readJson } from '../lib/http.js';
import { validationFailed } from '../lib/errors.js';

/** Read the JSON body with the configured size limit. */
export const body = (req, ctx) => readJson(req, ctx.config.limits.body_bytes);

/**
 * When a caller sets an owner other than themselves, they must also send a
 * display name, since the API has no user directory to look one up in.
 */
export function requireOwnerName(fields, user) {
  if (fields.owner_id !== undefined && fields.owner_id !== user.id && !fields.owner_name) {
    throw validationFailed({ owner_name: 'is required when owner_id is someone else' });
  }
}
