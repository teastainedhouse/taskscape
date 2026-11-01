import { json } from '../lib/http.js';
import { ApiError, notFound, wrongCredentials, tooManyRequests, validationFailed } from '../lib/errors.js';
import { validateLogin, validatePasswordChange } from '../lib/validate.js';
import { hashPassword, verifyPassword, verifyDummy } from '../lib/auth/passwords.js';
import { lockoutKey } from '../lib/auth/lockout.js';
import { sessionCookie, clearSessionCookie, sessionCookieValue } from '../lib/auth/providers/password.js';
import * as users from '../lib/repo/users.js';
import * as sessions from '../lib/repo/sessions.js';
import { body } from './_shared.js';
import { meBody } from './me.js';

/** @param {import('../lib/router.js').Ctx} ctx  the password routes do not exist under another provider */
function requirePasswordProvider(ctx) {
  if (ctx.config.auth.provider !== 'password') throw notFound();
}

/**
 * Count an attempt against `lockout`, then check the password. A 503 from the
 * scrypt limit takes the attempt back: the password was never checked.
 * @param {import('../lib/auth/lockout.js').Lockout} lockout
 * @param {string} key
 * @param {string} now
 * @param {() => Promise<boolean>} check
 */
async function limited(lockout, key, now, check) {
  const at = Date.parse(now);
  const wait = lockout.attempt(key, at);
  if (wait > 0) throw tooManyRequests(wait);
  try {
    const ok = await check();
    if (ok) lockout.succeeded(key);
    return ok;
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) lockout.undo(key, at);
    throw err;
  }
}

/** @param {number} status @param {Record<string,string>} [headers] */
const empty = (status, headers = {}) => new Response(null, { status, headers });

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  // The one unauthenticated way for a signed-out page to learn the title and whether to show a sign-in form.
  { method: 'GET', path: '/api/login', auth: 'none', handler: async (_req, ctx) =>
    json({ provider: ctx.config.auth.provider, site_title: ctx.config.site_title }) },

  { method: 'POST', path: '/api/login', auth: 'none', sameOrigin: true, handler: async (req, ctx) => {
    requirePasswordProvider(ctx);
    const { username, password } = validateLogin(await body(req, ctx));
    const cfg = ctx.config.auth.password;
    const now = ctx.now();
    const cred = await users.credentials(ctx.db, username);
    // Unknown and disabled users still pay for one scrypt, so all three refusals look and take the same.
    const ok = await limited(ctx.lockouts.signIn, lockoutKey(username), now, () =>
      (cred && !cred.user.disabled_at ? verifyPassword(password, cred.password_hash) : verifyDummy(password)));
    if (!ok || !cred) throw wrongCredentials();
    await sessions.removeExpired(ctx.db, now);
    const previous = sessionCookieValue(req, cfg);
    if (previous) await sessions.removeByToken(ctx.db, previous); // signing in again replaces this browser's old session
    const session = await sessions.create(ctx.db, cred.user.id, now, cfg.session_days);
    /** @type {import('../lib/auth/index.js').Principal} */
    const user = { id: cred.user.id, name: cred.user.name, email: cred.user.email ?? undefined, groups: cred.user.groups,
      via: 'ui', auth: 'password', login_session_id: session.id };
    return json(meBody(ctx.config, user), 200, { 'Set-Cookie': sessionCookie(cfg, session.plaintext) });
  } },

  // Unauthenticated so an expired or unknown cookie can still be cleared.
  { method: 'POST', path: '/api/logout', auth: 'none', sameOrigin: true, handler: async (req, ctx) => {
    requirePasswordProvider(ctx);
    const cfg = ctx.config.auth.password;
    const value = sessionCookieValue(req, cfg);
    if (value) await sessions.removeByToken(ctx.db, value);
    return empty(204, { 'Set-Cookie': clearSessionCookie(cfg) });
  } },

  // Self-scoped, so a read-only account can still change its own password.
  { method: 'POST', path: '/api/me/password', auth: 'human', edit: false, handler: async (req, ctx) => {
    requirePasswordProvider(ctx);
    if (ctx.user.auth !== 'password') throw notFound();
    const { current_password, new_password, revoke_tokens } = validatePasswordChange(await body(req, ctx));
    const now = ctx.now();
    const cred = await users.credentials(ctx.db, ctx.user.id);
    // Its own counter: failed sign-ins for this name (anyone can cause those) never block a signed-in owner here.
    const ok = cred ? await limited(ctx.lockouts.passwordChange, ctx.user.id, now, () => verifyPassword(current_password, cred.password_hash)) : false;
    // 400, not 401: the session is fine, and a 401 tells the UI it has been signed out.
    if (!ok) throw validationFailed({ current_password: 'is incorrect' });
    await users.setPassword(ctx.db, ctx.user.id, await hashPassword(new_password), now,
      { keepSessionId: ctx.user.login_session_id, revokeTokens: revoke_tokens });
    return empty(204);
  } },
];
