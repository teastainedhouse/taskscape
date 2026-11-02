// page.js — shared bootstrap for every page: load /api/config and /api/me,
// fill in the site title, mount the dev banner, the avatar (the header's
// link to the profile page) and nav state, wire the status region and the
// "session expired" notice, hide edit controls for viewers.
// Under the password provider: send signed-out visitors to login.html,
// link the expiry notice to it, and show the Sign out button.

import { get, post, ApiError, SESSION_EXPIRED_EVENT } from './api.js';
import { el, setChildren, setTimeZone } from './dom.js';
import { mountDevBanner } from './dev-user.js';
import { mountAvatar } from './avatar.js';
import { refreshBadge } from './for-you.js';
import { applyTheme, applyRememberedTheme, forgetTheme } from './theme.js';
import { mountShortcuts } from './shortcuts.js';

/**
 * @typedef {{theme: string, comments_label: 'Comments'|'Guestbook', shortcuts: boolean, time_zone: string, chosen: Record<string, boolean>}} Preferences
 * @typedef {{config: any, me: {id: string, name: string, auth: string, can_edit: boolean, preferences: Preferences}}} PageContext
 */

// The theme this browser wore last time goes on before the first request, so a page
// rarely flashes the default; boot() puts the real preference on once /api/me answers.
// Not on the sign-in page: nobody is signed in there, so it wears the site default.
if (!document.body.classList.contains('login-page')) applyRememberedTheme();

let statusEl = null;
let statusTimer = null;
/** Set once boot() has loaded /api/me; expiry before that is boot()'s to handle. */
let ready = false;
/** The signed-in principal came from a password session (so login.html applies). */
let passwordSession = false;
/** The sticky expiry notice is showing; later 401s must not replace it. */
let expiredShown = false;

/**
 * Show a message in the aria-live status region.
 * @param {string|Array<Node|string>} msg  text, or text and nodes (e.g. a link)
 * @param {{error?: boolean, sticky?: boolean}} [opts]
 */
export function say(msg, opts = {}) {
  if (!statusEl) statusEl = document.getElementById('status');
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.classList.toggle('error', !!opts.error);
  setChildren(statusEl, [msg]);
  const shown = statusEl.textContent;
  if (!opts.sticky && !opts.error) statusTimer = setTimeout(() => { if (statusEl.textContent === shown) statusEl.textContent = ''; }, 8000);
}

/**
 * Report an error from the API (or anything else) in the status region.
 * A 401 after the expiry notice is up leaves that notice (and its link) in place.
 * @param {unknown} err
 * @param {string} [prefix]
 */
export function sayError(err, prefix) {
  if (err instanceof ApiError && err.status === 401 && expiredShown) return;
  const msg = err instanceof ApiError ? err.humanMessage : (err?.message || String(err));
  say(prefix ? `${prefix}: ${msg}` : msg, { error: true });
  if (!(err instanceof ApiError)) console.error(err);
}

/**
 * Put the site title into the document title, [data-site-title] and [data-served-by].
 * @param {string} [siteTitle]
 * @param {string} [pageTitle]
 */
export function applySiteTitle(siteTitle, pageTitle) {
  const site = siteTitle || 'Taskscape';
  document.title = pageTitle ? `${pageTitle} - ${site}` : site;
  for (const n of document.querySelectorAll('[data-site-title]')) n.textContent = site;
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  for (const n of document.querySelectorAll('[data-served-by]')) n.textContent = `${site} at ${location.hostname} Port ${port}`;
}

/** This page as login.html's `next`: the page name, query, and fragment (login.js validates it). */
function loginHref() {
  const page = location.pathname.split('/').pop() || 'index.html';
  return `login.html?next=${encodeURIComponent(page + location.search + location.hash)}`;
}

/** Whether this site signs people in with login.html (GET /api/login works signed out). */
async function usesPasswordLogin() {
  try {
    const info = await get('/api/login');
    return info?.provider === 'password';
  } catch {
    return false;
  }
}

function onSessionExpired() {
  if (!ready) return;
  expiredShown = true;
  if (passwordSession) {
    say(['Your session has ended. ', el('a', { href: loginHref() }, 'Sign in again'), '. Unsaved changes on this page will be lost.'],
      { error: true, sticky: true });
  } else {
    say('Session expired. Reload the page to sign in again.', { error: true, sticky: true });
  }
}

/**
 * Show the Sign out button for password sessions: end the session, then go to login.html.
 * @param {{auth: string}} me
 */
function mountSignOut(me) {
  const button = document.getElementById('sign-out');
  if (!button || me.auth !== 'password') return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await post('/api/logout');
      forgetTheme();
      location.replace('login.html');
    } catch (err) {
      button.disabled = false;
      sayError(err, 'Could not sign out');
    }
  });
}

/**
 * Bootstrap the page. Call once from each page module.
 * Signed out under the password provider, it goes to login.html and never resolves.
 * @param {{title: string}} opts  page title, prefixed to the site title
 * @returns {Promise<PageContext>}
 */
export async function boot(opts) {
  statusEl = document.getElementById('status');
  document.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);

  let config, me;
  try {
    [config, me] = await Promise.all([get('/api/config'), get('/api/me')]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && await usesPasswordLogin()) {
      say('Not signed in; opening the sign-in page.', { sticky: true });
      location.replace(loginHref());
      return new Promise(() => {}); // the page is leaving; nothing below should run
    }
    sayError(err, 'Could not load Taskscape');
    throw err;
  }
  ready = true;
  passwordSession = me.auth === 'password';
  /** Pages built before preferences existed still work: every key has a site default. */
  me.preferences = { theme: config.theme, comments_label: 'Comments', shortcuts: true, time_zone: 'UTC', chosen: {}, ...(config.preference_defaults ?? {}), ...(me.preferences ?? {}) };
  applyPreferences(config, me.preferences);

  applySiteTitle(config.site_title, opts?.title);

  mountDevBanner(document.getElementById('dev-banner'), me, config);

  // Mark the current nav link.
  const here = location.pathname.split('/').pop() || 'index.html';
  for (const a of document.querySelectorAll('nav a')) {
    if ((a.getAttribute('href') || '').split('?')[0] === here) a.setAttribute('aria-current', 'page');
  }

  // Edit permission: anything marked data-needs-edit is for editors only.
  if (!me.can_edit) for (const n of document.querySelectorAll('[data-needs-edit]')) n.hidden = true;

  mountAvatar(document.getElementById('avatar'), me);
  mountSignOut(me);
  refreshBadge(me).catch(() => {}); // the badge is a nicety; What's New itself still works
  return { config, me };
}

/**
 * Put a set of preferences into effect on this page: the theme and the time zone.
 * The profile page calls it again after a save.
 * @param {any} config @param {Preferences} prefs
 */
export function applyPreferences(config, prefs) {
  applyTheme(prefs.theme, config.themes ?? [config.theme], { fallback: config.theme });
  // a zone the person chose follows them everywhere; otherwise this device's zone decides "today", as it always did
  // (Claude, which has no device, follows the site default through the MCP me tool)
  setTimeZone(prefs.chosen?.time_zone ? prefs.time_zone : null);
  mountShortcuts(!!prefs.shortcuts);
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
