// profile.js — the profile page: who you are (name and initial), preferences
// (theme, comments label, shortcuts, time zone), change password and active
// sign-ins for password sessions, MCP tokens (issue, plaintext shown once,
// revoke), and your own recent activity (GET /api/activity?actor=<me>).

import { boot, say, sayError, applyPreferences } from './page.js';
import { get, post, patch, del, ApiError } from './api.js';
import { el, btn, option, clear, setChildren, timeEl, oneLine } from './dom.js';
import { initialFor, letterSvg } from './avatar.js';
import { describeActivity, viaBadge } from './activity-words.js';
import { commentWords } from './guestbook.js';

const { config, me } = await boot({ title: 'Profile' });

const tokensBody = document.querySelector('#tokens tbody');
const reveal = document.getElementById('token-reveal');
const envBlock = document.getElementById('env-block');
/** Activity paging: the cursor of the next page, how many entries are shown, and whether a page is loading. */
let cursor = null;
let activityCount = 0;
let activityBusy = false;

renderWho();
setupPreferences();
renderEnv();
setupIssue();
if (me.auth === 'password') { setupPassword(); setupSessions(); }
document.getElementById('my-activity-more').addEventListener('click', () => loadActivity());
await Promise.all([loadTokens(), loadActivity(true), me.auth === 'password' ? loadSessions() : null]);

/* --------------------------------------------------------------------- who */

function renderWho() {
  const AUTH = { password: 'a Taskscape password', dev: 'the local development sign-in', headers: "your organisation's sign-in", token: 'an MCP token' };
  const big = el('span', { class: 'who__initial', 'aria-hidden': 'true' }, letterSvg(initialFor(me.name)));
  setChildren(document.getElementById('who'), [big,
    el('div', { class: 'who__text' },
      el('p', { class: 'who__name' }, el('b', null, me.name)),
      el('p', { class: 'muted' }, `User id: ${me.id}`, me.email ? ` · ${me.email}` : null),
      el('p', { class: 'muted' }, `Signed in with ${AUTH[me.auth] ?? me.auth}. `, me.can_edit ? 'You can edit.' : 'Your account is read-only.'))]);
}

/* ------------------------------------------------------------- preferences */

/** The IANA zones this browser knows, the person's own included; else just theirs and UTC. */
function timeZones(current) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  const set = new Set(['UTC', ...zones, current].filter(Boolean));
  return [...set];
}

/** The device's zone, for the "use this device's" button. */
function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/** Theme, comments label, shortcuts, time zone: one form, one PATCH, applied to this page at once. */
function setupPreferences() {
  const section = document.getElementById('prefs-section');
  const form = document.getElementById('prefs-form');
  const prefs = me.preferences;
  const theme = el('select', { id: 'pref-theme', name: 'theme' }, (config.themes ?? [config.theme]).map((t) => option(t, t === config.theme ? `${t} (site default)` : t, t === prefs.theme)));
  const label = el('select', { id: 'pref-comments', name: 'comments_label' }, ['Comments', 'Guestbook'].map((l) => option(l, l, l === prefs.comments_label)));
  const shortcuts = el('input', { type: 'checkbox', id: 'pref-shortcuts', name: 'shortcuts', checked: !!prefs.shortcuts });
  const zone = el('select', { id: 'pref-zone', name: 'time_zone' }, timeZones(prefs.time_zone).map((z) => option(z, z, z === prefs.time_zone)));
  const device = deviceZone();
  const useDevice = device ? btn(`Use this device's (${device})`, () => { if (![...zone.options].some((o) => o.value === device)) zone.appendChild(option(device)); zone.value = device; }) : null;
  const save = el('button', { type: 'submit' }, 'Save preferences');
  setChildren(form, [
    el('div', { class: 'field' }, el('label', { for: theme.id }, 'Look'), theme),
    el('div', { class: 'field' }, el('label', { for: label.id }, 'Call comments'), label),
    el('div', { class: 'field' }, el('label', null, shortcuts, ' Single-key keyboard shortcuts (press ? for the list)')),
    el('div', { class: 'field' }, el('label', { for: zone.id }, 'Time zone'), zone, useDevice ? [' ', useDevice] : null,
      el('p', { class: 'muted', id: 'pref-zone-hint' }, 'Due dates and "today" follow this zone, in the browser and for Claude.')),
    el('div', { class: 'field' }, save),
  ]);
  zone.setAttribute('aria-describedby', 'pref-zone-hint');
  section.hidden = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    save.disabled = true;
    try {
      // only what changed, so an untouched field keeps following the site default (NULL in the row)
      const wanted = { theme: theme.value, comments_label: label.value, shortcuts: shortcuts.checked, time_zone: zone.value };
      const changes = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => v !== me.preferences[k]));
      if (!Object.keys(changes).length) { say('Nothing changed.'); return; }
      const fresh = await patch('/api/me/preferences', changes);
      me.preferences = fresh;
      applyPreferences(config, fresh);
      say('Preferences saved. They follow you to every device you sign in on.');
      // dates and the comments wording follow the new settings
      await Promise.all([loadActivity(true), loadTokens(), me.auth === 'password' ? loadSessions() : null]);
    } catch (err) { sayError(err, 'Could not save the preferences'); } finally { save.disabled = false; save.focus(); }
  });
}

/* ------------------------------------------------------------------ tokens */

/** Suggested environment and the command to start the MCP server. */
function renderEnv(plaintext) {
  envBlock.textContent = [
    `export TASKSCAPE_URL=${location.origin}`,
    `export TASKSCAPE_TOKEN=${plaintext ?? 'tsk_...your token...'}`,
    'node mcp/server.js',
  ].join('\n');
}

async function loadTokens() {
  let res;
  try { res = await get('/api/tokens'); } catch (err) { sayError(err, 'Could not load tokens'); return; }
  const items = res.items ?? [];
  clear(tokensBody);
  for (const t of items) tokensBody.appendChild(tokenRow(t));
  document.getElementById('tokens').parentElement.hidden = items.length === 0;
  document.getElementById('tokens-empty').hidden = items.length > 0;
}

/** @param {any} t */
function tokenRow(t) {
  const revoked = !!t.revoked_at;
  const tr = el('tr', { class: revoked ? 'trashed' : '' },
    el('td', null, t.label),
    el('td', null, el('code', null, `${t.token_prefix}…`)),
    el('td', null, timeEl(t.created_at)),
    el('td', null, t.last_used_at ? timeEl(t.last_used_at) : 'never'),
    el('td', null, revoked ? ['Revoked ', timeEl(t.revoked_at)] : 'Active'));
  const actions = el('td', { class: 'row-actions' });
  if (!revoked) actions.appendChild(btn('Revoke', () => revoke(t), { class: 'danger', 'aria-label': `Revoke token ${t.label}` }));
  tr.appendChild(actions);
  return tr;
}

/** @param {any} t */
async function revoke(t) {
  if (!confirm(`Revoke the token "${oneLine(t.label)}"?\nAnything using it stops working immediately. This cannot be undone.`)) return;
  try {
    await del(`/api/tokens/${encodeURIComponent(t.id)}`);
    say(`Token "${t.label}" revoked.`);
    await loadTokens();
    focusFirst('#tokens tbody button', '#tokens-h');
  } catch (err) { sayError(err, 'Could not revoke the token'); }
}

function setupIssue() {
  const form = document.getElementById('issue-form');
  const label = document.getElementById('tok-label');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = label.value.trim();
    if (!name) return;
    try {
      const res = await post('/api/tokens', { label: name });
      form.reset();
      showPlaintext(res);
      await loadTokens();
    } catch (err) { sayError(err, 'Could not issue a token'); }
  });
}

/**
 * Show the plaintext once with a copy button and the warning.
 * @param {{token: any, plaintext: string}} res
 */
function showPlaintext(res) {
  const input = el('input', { type: 'text', readOnly: true, value: res.plaintext, class: 'plaintext', id: 'token-plaintext', 'aria-describedby': 'token-warning' });
  const copy = btn('Copy', async () => {
    try {
      await navigator.clipboard.writeText(res.plaintext);
      say('Token copied to the clipboard.');
    } catch {
      input.focus(); input.select();
      say('Could not use the clipboard; the token is selected, press Ctrl+C.', { error: true });
    }
  });
  const box = el('div', { class: 'token-box', role: 'region', 'aria-label': 'New token' },
    el('p', { id: 'token-warning' }, el('b', null, 'Copy this token now. It will not be shown again.'),
      ` Label: ${res.token.label}. Treat it like a password: it acts as you.`),
    el('label', { for: 'token-plaintext' }, 'Token'), ' ', input, ' ', copy, ' ',
    btn('Done, hide it', () => { setChildren(reveal, []); renderEnv(); focusFirst('#tok-label', '#tokens-h'); }));
  setChildren(reveal, [box]);
  renderEnv(res.plaintext);
  document.getElementById('use-token').open = true;
  input.focus(); input.select();
}

/* ---------------------------------------------------------------- password */

/** Change password (password sessions only): POST /api/me/password, then clear the form. */
function setupPassword() {
  const section = document.getElementById('password-section');
  const form = document.getElementById('password-form');
  const current = document.getElementById('pw-current');
  const fresh = document.getElementById('pw-new');
  const again = document.getElementById('pw-confirm');
  const revokeTokens = document.getElementById('pw-revoke-tokens');
  document.getElementById('pw-username').defaultValue = me.id;
  section.hidden = false;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const length = [...fresh.value].length; // characters, as the API counts them
    if (length < 10 || length > 200) {
      say('The new password needs 10 to 200 characters.', { error: true });
      fresh.focus();
      return;
    }
    if (fresh.value !== again.value) {
      say('The two new passwords do not match.', { error: true });
      again.focus();
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const revoking = revokeTokens.checked;
    try {
      // A wrong current password is a 400 naming current_password; a 401 means the session ended and takes the usual path.
      await post('/api/me/password', { current_password: current.value, new_password: fresh.value, revoke_tokens: revoking });
      form.reset();
      say(revoking ? 'Password changed. Your other sessions were signed out and your MCP tokens revoked.'
        : 'Password changed. Your other sessions were signed out.');
      await Promise.all([revoking ? loadTokens() : null, loadSessions()]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed' && err.details?.fields?.current_password) {
        say('The current password is wrong.', { error: true });
        current.value = '';
        current.focus();
      } else {
        sayError(err, 'Could not change the password');
      }
    } finally {
      submit.disabled = false;
    }
  });
}

/* ---------------------------------------------------------------- sessions */

function setupSessions() {
  document.getElementById('sessions-section').hidden = false;
  const others = document.getElementById('sign-out-others');
  others.addEventListener('click', async () => {
    if (!confirm('Sign out of every other session?\nThis browser stays signed in.')) return;
    others.disabled = true;
    try {
      const res = await del('/api/me/sessions');
      const n = Number(res?.ended ?? 0);
      say(n === 0 ? 'There were no other sessions.' : `Signed out of ${n} other session${n === 1 ? '' : 's'}.`);
      await loadSessions();
    } catch (err) { sayError(err, 'Could not sign out the other sessions'); } finally { others.disabled = false; focusFirst('#sign-out-others', '#sessions-h'); }
  });
}

async function loadSessions() {
  const tbody = document.querySelector('#sessions tbody');
  let res;
  try { res = await get('/api/me/sessions'); } catch (err) { sayError(err, 'Could not load your sign-ins'); return; }
  const items = res.items ?? [];
  clear(tbody);
  for (const s of items) tbody.appendChild(sessionRow(s));
  document.getElementById('sign-out-others').hidden = items.length < 2;
}

/** @param {any} s */
function sessionRow(s) {
  const tr = el('tr', { class: s.current ? 'current-session' : null },
    el('td', null, timeEl(s.created_at), s.current ? [' ', el('b', { class: 'new-mark' }, 'This browser')] : null),
    el('td', null, timeEl(s.last_seen_at)),
    el('td', null, timeEl(s.expires_at)));
  const actions = el('td', { class: 'row-actions' });
  if (!s.current) actions.appendChild(btn('End', () => endSession(s), { class: 'danger', 'aria-label': `End the sign-in from ${timeEl(s.created_at).textContent}, last seen ${timeEl(s.last_seen_at).textContent}` }));
  tr.appendChild(actions);
  return tr;
}

/** @param {any} s */
async function endSession(s) {
  if (!confirm('End this sign-in? That browser will have to sign in again.')) return;
  try {
    await del(`/api/me/sessions/${encodeURIComponent(s.id)}`);
    say('Sign-in ended.');
  } catch (err) {
    // already ended elsewhere: the row is stale either way
    if (err instanceof ApiError && err.status === 404) say('That sign-in had already ended.'); else { sayError(err, 'Could not end the sign-in'); return; }
  }
  await loadSessions();
  focusFirst('#sessions tbody button', '#sign-out-others', '#sessions-h');
}

/** Focus the first of these selectors that names a visible element (a heading with tabindex=-1 as the last resort). */
function focusFirst(...selectors) {
  for (const sel of selectors) {
    const n = document.querySelector(sel);
    if (n && !n.hidden && !n.closest('[hidden]') && n.getClientRects().length) { n.focus(); return; }
  }
}

/* ---------------------------------------------------------------- activity */

/** My own entries, newest first, a page at a time. @param {boolean} [first] */
async function loadActivity(first = false) {
  const list = document.getElementById('my-activity');
  const more = document.getElementById('my-activity-more');
  if (activityBusy) return;
  activityBusy = true;
  if (first) { cursor = null; activityCount = 0; clear(list); }
  more.setAttribute('aria-disabled', 'true');
  try {
    const res = await get('/api/activity', { actor: me.id, limit: 25, before: cursor ?? undefined });
    const items = res.items ?? [];
    for (const a of items) {
      const d = describeActivity(a, { words: commentWords(me.preferences.comments_label) });
      list.appendChild(el('li', null, timeEl(a.created_at), ' — ', el('b', null, 'You'), ' (', viaBadge(a.via), ') ', d.what, d.link ? [' — ', d.link] : null));
    }
    activityCount += items.length;
    cursor = res.next_cursor ?? null;
    more.hidden = !cursor;
    document.getElementById('my-activity-empty').hidden = activityCount > 0;
  } catch (err) { sayError(err, 'Could not load your activity'); } finally { more.removeAttribute('aria-disabled'); activityBusy = false; }
}
