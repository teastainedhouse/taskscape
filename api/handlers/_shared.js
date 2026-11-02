import { readJson } from '../lib/http.js';

/** Read the JSON body with the configured size limit. */
export const body = (req, ctx) => readJson(req, ctx.config.limits.body_bytes);

