// tokens.js — "My MCP tokens": list, issue (plaintext shown once), revoke;
// and, for password sessions, the change-password form.

import { boot, say, sayError } from './page.js';
import { get, post, del, ApiError } from './api.js';
import { el, btn, clear, setChildren, timeEl } from './dom.js';

const { me } = await boot({ title: 'My MCP tokens' });

const tbody = document.querySelector('#tokens tbody');
const reveal = document.getElementById('token-reveal');
const envBlock = document.getElementById('env-block');

renderEnv();
setupIssue();
if (me.auth === 'password') setupPassword();
await load();

/** Suggested environment and the command to start the MCP server. */
function renderEnv(plaintext) {
  envBlock.textContent = [
    `export TASKSCAPE_URL=${location.origin}`,
    `export TASKSCAPE_TOKEN=${plaintext ?? 'tsk_...your token...'}`,
    'node mcp/server.js',
  ].join('\n');
}

async function load() {
  let res;
  try { res = await get('/api/tokens'); } catch (err) { sayError(err, 'Could not load tokens'); return; }
  const items = res.items ?? [];
  clear(tbody);
  for (const t of items) tbody.appendChild(row(t));
  document.getElementById('tokens-empty').hidden = items.length > 0;
}

/** @param {any} t */
function row(t) {
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
  if (!confirm(`Revoke the token "${t.label}"?\nAnything using it stops working immediately. This cannot be undone.`)) return;
  try {
    await del(`/api/tokens/${encodeURIComponent(t.id)}`);
    say(`Token "${t.label}" revoked.`);
    await load();
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
      await load();
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
    btn('Done, hide it', () => { setChildren(reveal, []); renderEnv(); }));
  setChildren(reveal, [box]);
  renderEnv(res.plaintext);
  input.focus(); input.select();
}

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
      if (revoking) await load();
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
