// login.js — the sign-in page for the password provider. Learns the site
// title and provider from GET /api/login (the one call that works
// signed out), posts the form to /api/login, then goes to `next` if it names
// one of the app's pages, else today.html. Cancel clears the form.

import { applySiteTitle, say, sayError } from './page.js';
import { api, get, ApiError } from './api.js';
import { applyTheme } from './theme.js';

/** The pages `next` may name. login.html itself is not one of them. */
const PAGES = new Set(['today.html', 'projects.html', 'mine.html', 'project.html', 'task.html', 'whats-new.html', 'trash.html', 'profile.html']);

const form = document.getElementById('login-form');
const username = document.getElementById('login-username');
const password = document.getElementById('login-password');
const ok = document.getElementById('login-ok');
const next = safeNext(new URLSearchParams(location.search).get('next'));

document.getElementById('login-host').textContent = location.host;
form.addEventListener('submit', submit);
document.getElementById('login-cancel').addEventListener('click', cancel);

await start();

/**
 * Where to go after signing in. Only a same-site relative path to one of the
 * app's pages: an optional leading "/", a page name, then an optional query
 * or fragment. Never "//", a backslash, a scheme, whitespace or control characters.
 * @param {string|null} raw
 * @returns {string}
 */
function safeNext(raw) {
  const fallback = 'today.html';
  if (typeof raw !== 'string' || raw.length > 2000) return fallback;
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  const m = /^\/?([a-z-]+\.html)(?:[?#].*)?$/.exec(raw);
  if (!m || !PAGES.has(m[1])) return fallback;
  try {
    if (new URL(raw, location.href).origin !== location.origin) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

async function start() {
  let info;
  try {
    info = await get('/api/login');
  } catch (err) {
    sayError(err, 'Could not reach Taskscape');
    username.focus();
    return;
  }
  applySiteTitle(info?.site_title, 'Sign in');
  if (info?.theme) applyTheme(info.theme, [info.theme], { remember: false }); // the site default; a person's own theme comes back once they sign in

  if (info?.provider !== 'password') {
    form.hidden = true;
    document.getElementById('login-prompt').hidden = true;
    document.getElementById('login-elsewhere').hidden = false;
    return;
  }

  // Already signed in (say, after Back from a page): carry on to `next`.
  try {
    await api('GET', '/api/me', { noExpiry: true });
    location.replace(next);
    return;
  } catch { /* not signed in: stay on the form */ }
  username.focus();
}

/** @param {SubmitEvent} ev */
async function submit(ev) {
  ev.preventDefault();
  const name = username.value.trim();
  if (!name) { say('Enter your user name.', { error: true }); username.focus(); return; }
  if (!password.value) { say('Enter your password.', { error: true }); password.focus(); return; }

  ok.disabled = true;
  form.setAttribute('aria-busy', 'true');
  say('Signing in…', { sticky: true });
  try {
    await api('POST', '/api/login', { body: { username: name, password: password.value }, noExpiry: true });
    say('Signed in.', { sticky: true });
    location.replace(next);
  } catch (err) {
    showFailure(err);
  } finally {
    ok.disabled = false;
    form.removeAttribute('aria-busy');
  }
}

/** The server's own words for 401 and 429 (never which of name or password was wrong). */
function showFailure(err) {
  if (!(err instanceof ApiError)) { sayError(err, 'Could not sign in'); return; }
  if (err.status === 401) {
    say(err.message, { error: true });
    password.value = '';
    password.focus();
  } else if (err.status === 429) {
    say(err.retryAfter ? `${err.message} (Wait ${waitWords(err.retryAfter)}.)` : err.message, { error: true });
  } else if (err.status === 404) {
    say('Password sign-in is not enabled on this site.', { error: true });
  } else {
    sayError(err, 'Could not sign in');
  }
}

/** @param {number} seconds */
function waitWords(seconds) {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minutes`;
}

/** Cancel: nothing is sent; the form is cleared and ready again. */
function cancel() {
  form.reset();
  say('Cancelled. Nothing was sent.');
  username.focus();
}
