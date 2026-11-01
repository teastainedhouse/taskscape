import { Router } from './lib/router.js';
import { nowIso } from './lib/time.js';
import { createLockout } from './lib/auth/lockout.js';
import { warmDummyHash } from './lib/auth/passwords.js';
import { routes as health } from './handlers/health.js';
import { routes as config } from './handlers/config.js';
import { routes as me } from './handlers/me.js';
import { routes as people } from './handlers/people.js';
import { routes as projects } from './handlers/projects.js';
import { routes as exportMd } from './handlers/export.js';
import { routes as tasks } from './handlers/tasks.js';
import { routes as tags } from './handlers/tags.js';
import { routes as trash } from './handlers/trash.js';
import { routes as activity } from './handlers/activity.js';
import { routes as search } from './handlers/search.js';
import { routes as tokens } from './handlers/tokens.js';
import { routes as login } from './handlers/login.js';

/**
 * Build the API. This is the only entry point: the dev server, tests, and
 * any host adapter call `app.fetch(request)`.
 * @param {{config: import('./lib/config.js').Config, db: import('./lib/db/index.js').Db, now?: () => string, log?: (e: unknown) => void,
 *   lockouts?: {signIn: import('./lib/auth/lockout.js').Lockout, passwordChange: import('./lib/auth/lockout.js').Lockout}}} env
 * @returns {{ fetch: (request: Request) => Promise<Response> }}
 */
export function createApp(env) {
  const router = new Router();
  router.add(health).add(login).add(config).add(me).add(people)
    .add(projects).add(exportMd).add(tasks).add(tags).add(trash).add(activity).add(search).add(tokens);
  // The lockouts live with the app instance: one per process in production, one per test app.
  // Password changes count separately, so failed sign-ins for a name cannot block its owner's change.
  const lockouts = env.lockouts ?? { signIn: createLockout(), passwordChange: createLockout() };
  if (env.config.auth.provider === 'password') warmDummyHash().catch(() => {});
  const full = { ...env, now: env.now ?? nowIso, log: env.log ?? console.error, lockouts };
  return { fetch: (request) => router.handle(request, full) };
}
