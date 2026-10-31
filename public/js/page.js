// page.js — shared bootstrap for every page: load /api/config and /api/me,
// apply the theme, mount the dev banner and nav state, wire the status
// region and the "session expired" notice, hide edit controls for viewers.

import { get, ApiError, SESSION_EXPIRED_EVENT } from './api.js';
import { el, setChildren } from './dom.js';
import { mountDevBanner } from './dev-user.js';

/** @typedef {{config: any, me: {id: string, name: string, auth: string, can_edit: boolean}}} PageContext */

let statusEl = null;
let statusTimer = null;

/**
 * Show a message in the aria-live status region.
 * @param {string} msg
 * @param {{error?: boolean, sticky?: boolean}} [opts]
 */
export function say(msg, opts = {}) {
  if (!statusEl) statusEl = document.getElementById('status');
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.classList.toggle('error', !!opts.error);
  statusEl.textContent = msg;
  if (!opts.sticky && !opts.error) statusTimer = setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 8000);
}

/**
 * Report an error from the API (or anything else) in the status region.
 * @param {unknown} err
 * @param {string} [prefix]
 */
export function sayError(err, prefix) {
  const msg = err instanceof ApiError ? err.humanMessage : (err?.message || String(err));
  say(prefix ? `${prefix}: ${msg}` : msg, { error: true });
  if (!(err instanceof ApiError)) console.error(err);
}

/**
 * Load the theme named in the config (css/theme-<name>.css), keeping the
 * plain theme the pages link by default if the file does not exist.
 * @param {string} theme
 */
function applyTheme(theme) {
  const current = document.getElementById('theme-css');
  if (!current || !theme || theme === 'plain' || !/^[a-z0-9_-]{1,40}$/i.test(theme)) return;
  const link = el('link', { rel: 'stylesheet', href: `css/theme-${theme}.css` });
  link.addEventListener('load', () => current.remove());
  link.addEventListener('error', () => link.remove());
  current.after(link);
}

/**
 * Bootstrap the page. Call once from each page module.
 * @param {{title: string}} opts  page title, prefixed to the site title
 * @returns {Promise<PageContext>}
 */
export async function boot(opts) {
  statusEl = document.getElementById('status');
  document.addEventListener(SESSION_EXPIRED_EVENT, () => say('Session expired. Reload the page to sign in again.', { error: true, sticky: true }));

  let config, me;
  try {
    [config, me] = await Promise.all([get('/api/config'), get('/api/me')]);
  } catch (err) {
    sayError(err, 'Could not load Taskscape');
    throw err;
  }

  applyTheme(config.theme);
  const site = config.site_title || 'Taskscape';
  document.title = opts?.title ? `${opts.title} - ${site}` : site;
  for (const n of document.querySelectorAll('[data-site-title]')) n.textContent = site;
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  for (const n of document.querySelectorAll('[data-served-by]')) n.textContent = `${site} at ${location.hostname} Port ${port}`;

  mountDevBanner(document.getElementById('dev-banner'), me, config);

  // Mark the current nav link.
  const here = location.pathname.split('/').pop() || 'index.html';
  for (const a of document.querySelectorAll('nav a')) {
    if ((a.getAttribute('href') || '').split('?')[0] === here) a.setAttribute('aria-current', 'page');
  }

  // Edit permission: anything marked data-needs-edit is for editors only.
  if (!me.can_edit) for (const n of document.querySelectorAll('[data-needs-edit]')) n.hidden = true;

  const who = document.getElementById('whoami');
  if (who) setChildren(who, ['Signed in as ', el('b', null, me.name)]);
  return { config, me };
}

/**
 * Run a write; on 409 hand the live record to `onConflict` and show the
 * standard conflict message. Other errors go to the status region.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {(current: any) => void} [onConflict]
 * @returns {Promise<T|undefined>}
 */
export async function attempt(fn, onConflict) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.current) {
      onConflict?.(err.current);
      say('Someone else changed this; showing the latest. Try again.', { error: true });
    } else {
      sayError(err);
    }
    return undefined;
  }
}
