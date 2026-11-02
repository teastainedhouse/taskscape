// profile-feeds.js — "Calendar and feed links" on the profile page: create a
// feed link (a secret URL a calendar app subscribes to), list your links, and
// revoke one. The full link is shown once, when it is made, like an MCP token;
// afterwards only its first characters are. Human-only (the API refuses a token).

import { get, post, del } from './api.js';
import { el, btn, setChildren, timeEl } from './dom.js';
import { say, sayError } from './page.js';

const SCOPES = { mine: 'My tasks', all: 'Everything I can see' };

/** @param {HTMLElement} host */
export function mountFeeds(host) {
  const list = el('tbody');
  const empty = el('p', { class: 'muted', id: 'feeds-empty' }, 'No feed links yet. Make one to see your due dates in a calendar app.');
  const table = el('div', { class: 'table-wrap' }, el('table', { id: 'feeds' },
    el('caption', { class: 'visually-hidden' }, 'Your feed links'),
    el('thead', null, el('tr', null, ['Label', 'Shows', 'Starts with', 'Made', 'Last used', ''].map((h) => el('th', { scope: 'col' }, h)))), list));
  const reveal = el('div', { id: 'feed-reveal', class: 'token-reveal', hidden: true, tabindex: '-1' });
  const label = el('input', { type: 'text', id: 'feed-label', required: true, maxlength: '100', size: '24', value: 'My calendar' });
  const scope = el('select', { id: 'feed-scope' }, Object.entries(SCOPES).map(([v, l]) => el('option', { value: v }, l)));
  const form = el('form', { class: 'filters', 'aria-label': 'Make a feed link' },
    el('div', { class: 'field' }, el('label', { for: 'feed-label' }, 'Label'), label),
    el('div', { class: 'field' }, el('label', { for: 'feed-scope' }, 'Shows'), scope),
    el('div', { class: 'field' }, el('button', { type: 'submit' }, 'Make a feed link')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const res = await post('/api/feeds', { label: label.value.trim(), scope: scope.value });
      showOnce(res);
      await load();
    } catch (err) { sayError(err, 'Could not make the feed link'); }
  });
  setChildren(host, [
    el('p', null, 'A feed link lets a calendar app show your due dates. ',
      'Anyone who has the link can read what it shows, so treat it like a password: revoke it here if it leaks. It can only read; it cannot change anything.'),
    form, reveal, empty, table,
  ]);

  /** The full links, once. @param {{plaintext: string, calendar_url: string}} res */
  function showOnce(res) {
    const field = (id, text, value) => el('div', { class: 'field' }, el('label', { for: id }, text),
      el('input', { type: 'text', id, value, readonly: true, size: '60', class: 'token-plain' }));
    setChildren(reveal, [
      el('p', null, el('b', null, 'Copy these now: they are shown only once.')),
      field('feed-calendar-url', 'Calendar (iCal) link: subscribe to it in your calendar app', res.calendar_url),
      btn('Done, hide them', () => { reveal.hidden = true; setChildren(reveal, []); label.focus(); }),
    ]);
    reveal.hidden = false;
    reveal.focus();
    say('Feed link made. It is shown once; copy it now.');
  }

  async function load() {
    try {
      const items = (await get('/api/feeds')).items ?? [];
      setChildren(list, items.map((f) => el('tr', { id: `feed-${f.id}` },
        el('td', null, f.label), el('td', null, SCOPES[f.scope] ?? f.scope), el('td', null, el('code', null, `${f.token_prefix}…`)),
        el('td', null, timeEl(f.created_at)), el('td', null, f.last_used_at ? timeEl(f.last_used_at) : 'never'),
        el('td', null, f.revoked_at ? ['Revoked ', timeEl(f.revoked_at)] : btn('Revoke', () => revoke(f), { class: 'danger', 'aria-label': `Revoke the feed link ${f.label}` })))));
      table.hidden = items.length === 0;
      empty.hidden = items.length > 0;
    } catch (err) { sayError(err, 'Could not load your feed links'); }
  }

  /** @param {any} f */
  async function revoke(f) {
    if (!confirm(`Revoke the feed link "${f.label}"?\nCalendars and readers using it stop updating.`)) return;
    try {
      await del(`/api/feeds/${encodeURIComponent(f.id)}`);
      say('Feed link revoked.');
      await load();
      document.getElementById('feeds-h')?.focus();
    } catch (err) { sayError(err, 'Could not revoke the feed link'); }
  }

  return load();
}
