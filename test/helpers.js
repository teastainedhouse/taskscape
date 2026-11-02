import { readFileSync } from 'node:fs';
import { prepareConfig } from '../api/lib/config.js';
import { openDb } from '../api/lib/db/index.js';
import { createApp } from '../api/index.js';
import { ensureCatchAll } from '../api/lib/repo/projects.js';

const ROOT = new URL('../', import.meta.url);
export const MIGRATIONS = new URL('migrations/', ROOT).pathname;
const BASE_CONFIG = JSON.parse(readFileSync(new URL('taskscape.config.json', ROOT), 'utf8'));
/** Set TASKSCAPE_TEST_POSTGRES_URL to run the suite against PostgreSQL (use --test-concurrency=1: one shared database). */
const PG_URL = process.env.TASKSCAPE_TEST_POSTGRES_URL;

/** Deep-merge plain objects (arrays replace). */
function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a?.[k], v);
  return out;
}

/**
 * A clock that moves 1 ms forward on every read, for tests that assert the
 * order of activity entries: writes in the same millisecond tie on created_at
 * and then sort by a random id.
 * @param {string} [start]
 */
export function tickingClock(start = '2026-11-01T09:00:00.000Z') {
  let ms = Date.parse(start);
  return () => new Date(ms++).toISOString();
}

/**
 * An in-process app over an in-memory SQLite database.
 * @param {{config?: object, env?: object, now?: () => string}} [opts]
 */
export async function createTestApp(opts = {}) {
  const raw = merge(BASE_CONFIG, opts.config);
  const config = prepareConfig(raw, { TASKSCAPE_ENV: 'test', ...(opts.env ?? {}) });
  const db = await openDb(PG_URL || 'sqlite::memory:');
  await db.migrate(MIGRATIONS);
  if (PG_URL) await db.exec('TRUNCATE feed_tokens, task_checklist_items, task_links, comment_mentions, comments, activity, task_tags, project_tags, tasks, mcp_tokens, projects, tags, sessions, users, preferences');
  await ensureCatchAll(db, config, opts.now?.()); // same clock as the app, so General is never newer than a test's rows
  const errors = [];
  const app = createApp({ config, db, now: opts.now, log: (e) => errors.push(e) });

  const call = (headers) => {
    const send = (method) => async (path, body, extraHeaders = {}) => {
      const init = { method, headers: { ...headers, ...extraHeaders } };
      if (body !== undefined) {
        // JSON unless the test names another type (the Markdown import sends text/markdown)
        if (!Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')) init.headers['content-type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await app.fetch(new Request('http://test' + path, init));
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const parsed = ct.includes('application/json') && text ? JSON.parse(text) : text;
      return { status: res.status, headers: res.headers, body: parsed, text };
    };
    return { get: send('GET'), post: send('POST'), patch: send('PATCH'), put: send('PUT'), delete: send('DELETE'), raw: (req) => app.fetch(req) };
  };

  return {
    app,
    db,
    config,
    errors,
    catchAllId: config.catch_all_project.id,
    /** Requests as a dev user. */
    as: (userId) => call({ 'x-dev-user': userId }),
    /** Requests with arbitrary headers (for the headers provider). */
    withHeaders: (headers) => call(headers),
    /** Requests as an MCP token holder. */
    tokenAs: (plaintext, sessionId = 'sess-test') =>
      call({ authorization: `Bearer ${plaintext}`, ...(sessionId ? { 'x-taskscape-session': sessionId } : {}) }),
    anon: () => call({}),
    close: () => db.close(),
  };
}

export const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Not found.' } };
