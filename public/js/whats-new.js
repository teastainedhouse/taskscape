// whats-new.js — the activity feed, newest first, with "Load more".

import { boot, sayError } from './page.js';
import { get } from './api.js';
import { el, clear, timeEl, text } from './dom.js';
import { describeActivity, viaBadge } from './activity-words.js';

await boot({ title: "What's New?" });

const tbody = document.querySelector('#feed tbody');
const more = document.getElementById('load-more');
const empty = document.getElementById('feed-empty');
const viaSel = document.getElementById('f-via');

const state = { cursor: null, via: '', count: 0, projectNames: new Map() };

try {
  const res = await get('/api/projects', { limit: 1000 });
  for (const p of res.items ?? []) state.projectNames.set(p.id, p.name);
} catch { /* names are a nicety; the feed still renders */ }

more.addEventListener('click', () => load());
viaSel.addEventListener('change', () => { state.via = viaSel.value; reset(); });
await load();

function reset() {
  state.cursor = null; state.count = 0;
  clear(tbody);
  load();
}

/** Fetch one page (before the cursor) and append it. */
async function load() {
  more.disabled = true;
  try {
    const res = await get('/api/activity', { limit: 50, before: state.cursor, via: state.via });
    for (const a of res.items ?? []) tbody.appendChild(row(a));
    state.count += (res.items ?? []).length;
    state.cursor = res.next_cursor ?? null;
    more.hidden = !state.cursor;
    empty.hidden = state.count > 0;
  } catch (err) {
    sayError(err, 'Could not load activity');
  } finally {
    more.disabled = false;
  }
}

/** @param {any} a */
function row(a) {
  const d = describeActivity(a, { projectNames: state.projectNames });
  return el('tr', null,
    el('td', null, timeEl(a.created_at)),
    el('td', null, a.actor_name),
    el('td', null, viaBadge(a.via)),
    el('td', { class: 'activity-what' }, d.what),
    el('td', null, d.link ?? text('')));
}
