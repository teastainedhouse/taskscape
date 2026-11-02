import { json } from '../lib/http.js';
import { BASE_HEADERS } from '../lib/http.js';
import { notFound, validationFailed } from '../lib/errors.js';
import * as feeds from '../lib/repo/feeds.js';
import * as tasks from '../lib/repo/tasks.js';
import { todayFor } from '../lib/repo/preferences.js';
import { renderCalendar } from '../lib/ical.js';
import { addDays } from '../lib/recurrence.js';
import { body } from './_shared.js';

/**
 * The site's public base URL for links in feeds: `public_url` from the config (or TASKSCAPE_PUBLIC_URL), else the
 * request's own origin. The fallback is only as good as the Host header the server saw: behind a proxy that
 * rewrites it, links point at the internal name, so a real site sets public_url.
 * @param {Request} req @param {import('../lib/config.js').Config} config
 */
export function publicBase(req, config) {
  return (config.public_url ?? new URL(req.url).origin).replace(/\/+$/, '');
}

/** Headers for a feed: the token is in the URL, so nothing may cache it or pass it on as a referrer. */
export const FEED_HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

/** A feed answer: the body with the base headers, no-store made private, and no referrer. */
export function feedResponse(text, contentType, filename) {
  return new Response(text, { status: 200, headers: { ...BASE_HEADERS, ...FEED_HEADERS, 'Content-Type': contentType, 'Content-Disposition': `inline; filename="${filename}"` } });
}

/**
 * The principal and scope behind a feed URL, or the generic 404 (an unknown, revoked, or disabled-account token
 * all answer the same).
 */
export async function feedPrincipal(ctx) {
  const found = await feeds.lookup(ctx.db, ctx.config, ctx.params.token, ctx.now());
  if (!found) throw notFound();
  return found;
}

/** @param {Record<string, unknown>} b */
function validateFeedInput(b) {
  const errors = {};
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  if (!label || [...label].length > 100) errors.label = 'must be 1 to 100 characters';
  if (!feeds.FEED_SCOPES.includes(b.scope)) errors.scope = 'must be mine or all';
  if (Object.keys(errors).length) throw validationFailed(errors);
  return { label, scope: /** @type {'mine'|'all'} */ (b.scope) };
}

/** @type {import('../lib/router.js').Route[]} */
export const routes = [
  { method: 'GET', path: '/api/feeds', auth: 'human', handler: async (_req, ctx) => json({ items: await feeds.listForUser(ctx.db, ctx.user.id) }) },
  // edit: false: a feed link only reads, so a read-only account may make one
  { method: 'POST', path: '/api/feeds', auth: 'human', edit: false, handler: async (req, ctx) => {
    const input = validateFeedInput(await body(req, ctx));
    const { feed, plaintext } = await feeds.issue(ctx.db, ctx.user, input, ctx.now());
    const base = `${publicBase(req, ctx.config)}/api/feeds/${plaintext}`;
    return json({ feed, plaintext, calendar_url: `${base}/calendar.ics` }, 201);
  } },
  { method: 'DELETE', path: '/api/feeds/:id', auth: 'human', edit: false, handler: async (_req, ctx) => json(await feeds.revoke(ctx.db, ctx.user.id, ctx.params.id, ctx.now())) },
  { method: 'GET', path: '/api/feeds/:token/calendar.ics', auth: 'none', handler: async (req, ctx) => {
    const { user, scope } = await feedPrincipal(ctx);
    const { today } = await todayFor(ctx.db, ctx.config, user.id, ctx.now());
    // tasks not in a closed status (a renamed status still shows) with a due date from 90 days back on, not in the trash,
    // that the feed's owner can see now; nearest first, so the cap cuts the far future, never this week. The status rule
    // is in the query, so closed tasks never use up the cap.
    const items = await tasks.list(ctx.db, user, {
      owner: scope === 'mine' ? 'me' : undefined, due_after: addDays(today, -90), open: true,
      include_trashed: 'false', sort: 'due_date', dir: 'ASC', limit: ctx.config.limits.max_page_size, offset: 0,
    }, ctx.config);
    const name = `${ctx.config.site_title || 'Taskscape'}: ${scope === 'mine' ? `${user.name}'s tasks` : `tasks ${user.name} can see`}`;
    return feedResponse(renderCalendar({ name, base: publicBase(req, ctx.config), stamp: ctx.now() }, items), 'text/calendar; charset=utf-8', 'taskscape.ics');
  } },
];
