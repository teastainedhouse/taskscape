import { Router } from './lib/router.js';
import { nowIso } from './lib/time.js';
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

/**
 * Build the API. This is the only entry point: the dev server, tests, and
 * any host adapter call `app.fetch(request)`.
 * @param {{config: import('./lib/config.js').Config, db: import('./lib/db/index.js').Db, now?: () => string, log?: (e: unknown) => void}} env
 * @returns {{ fetch: (request: Request) => Promise<Response> }}
 */
export function createApp(env) {
  const router = new Router();
  router.add(health).add(config).add(me).add(people)
    .add(projects).add(exportMd).add(tasks).add(tags).add(trash).add(activity).add(search).add(tokens);
  const full = { ...env, now: env.now ?? nowIso, log: env.log ?? console.error };
  return { fetch: (request) => router.handle(request, full) };
}
