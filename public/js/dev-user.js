// dev-user.js — red "DEV MODE" banner with a user switcher. Shown only when
// /api/me says auth: "dev". Switching sets the dev cookie and reloads.

import { el, option } from './dom.js';

const COOKIE = 'taskscape_dev_user'; // matches api/lib/auth/providers/dev.js

/**
 * Mount the banner into `host` when the dev identity provider is active.
 * @param {HTMLElement} host
 * @param {{id: string, auth: string}} me
 * @param {{auth?: {provider?: string, dev_users?: Array<{id: string, name: string}>}}} config
 */
export function mountDevBanner(host, me, config) {
  if (!host || me?.auth !== 'dev') return;
  const users = config?.auth?.dev_users ?? [];
  const select = el('select', { id: 'dev-user-select' });
  for (const u of users) select.appendChild(option(u.id, `${u.name} (${u.id})`, u.id === me.id));
  select.addEventListener('change', () => {
    const id = select.value;
    document.cookie = `${COOKIE}=${encodeURIComponent(id)}; path=/; SameSite=Lax`;
    location.reload();
  });
  host.appendChild(el('div', { class: 'dev-banner', role: 'region', 'aria-label': 'Development mode' },
    'DEV MODE — local identity only. ',
    el('label', { for: 'dev-user-select' }, 'Signed in as'),
    select));
}
