// whats-new.js — the activity feed, newest first, with "Load more". "Show:
// For you" (or ?for=me) keeps only other people's changes to what I own;
// showing it marks those entries seen for the toolbar badge (for-you.js).

import { boot, sayError } from './page.js';
import { get } from './api.js';
import { el, btn, clear, timeEl, text, setChildren } from './dom.js';
import { describeActivity, viaBadge } from './activity-words.js';
import { commentWords } from './guestbook.js';
import { readSeen, markSeen } from './for-you.js';

const { config, me } = await boot({ title: "What's New?" });
const words = commentWords(me.preferences.comments_label);

const tbody = document.querySelector('#feed tbody');
const more = document.getElementById('load-more');
const empty = document.getElementById('feed-empty');
const viaSel = document.getElementById('f-via');
const forSel = document.getElementById('f-for');

const state = {
  cursor: null, via: '', count: 0, projectNames: new Map(),
  forMe: new URLSearchParams(location.search).get('for') === 'me',
  /** What was already seen when the page opened: newer For you rows say "New". */
  seenBefore: readSeen(me),
  generation: 0,
};
forSel.value = state.forMe ? 'me' : '';

try {
  const res = await get('/api/projects', { limit: config.limits?.max_page_size });
  for (const p of res.items ?? []) state.projectNames.set(p.id, p.name);
} catch { /* names are a nicety; the feed still renders */ }

more.addEventListener('click', () => load());
viaSel.addEventListener('change', () => { state.via = viaSel.value; reset(); });
forSel.addEventListener('change', () => {
  state.forMe = forSel.value === 'me';
  const url = new URL(location.href);
  if (state.forMe) url.searchParams.set('for', 'me'); else url.searchParams.delete('for');
  history.replaceState(null, '', url);
  reset();
});
await load();

function reset() {
  state.cursor = null; state.count = 0;
  clear(tbody);
  load();
}

/** Fetch one page (before the cursor) and append it. */
async function load() {
  const mine = ++state.generation;
  const first = !state.cursor;
  more.disabled = true;
  try {
    const res = await get('/api/activity', { limit: 50, before: state.cursor, via: state.via, for: state.forMe ? 'me' : undefined });
    if (mine !== state.generation) return; // the filters changed meanwhile
    for (const a of res.items ?? []) tbody.appendChild(row(a));
    state.count += (res.items ?? []).length;
    state.cursor = res.next_cursor ?? null;
    more.hidden = !state.cursor;
    empty.hidden = state.count > 0;
    if (!state.count) showEmpty();
    // The newest For you entry is on the first unfiltered page; showing it marks everything up to it seen.
    if (state.forMe && first && !state.via) markSeen(me, res.items?.[0]?.created_at);
  } catch (err) {
    if (mine === state.generation) sayError(err, 'Could not load activity');
  } finally {
    if (mine === state.generation) more.disabled = false;
  }
}

/** The right empty message for the view: nothing at all, nothing for you, or nothing through this door. */
function showEmpty() {
  const forYou = state.forMe ? ' for you' : '';
  const allSources = btn('See every source', () => { viaSel.value = ''; state.via = ''; reset(); });
  const items = state.via === 'mcp' ? [el('p', null, `Nothing${forYou} from Claude yet. Changes made through the MCP server show up here.`), el('p', null, allSources)]
    : state.via === 'ui' ? [el('p', null, `Nothing${forYou} from the browser yet.`), el('p', null, allSources)]
    : state.forMe ? [el('p', null, 'Nothing for you yet. When someone else changes a project or task you own, it shows up here.'),
      el('p', null, el('a', { href: 'whats-new.html' }, 'See everything instead'))]
    : [el('p', null, 'Nothing has happened yet. Every change to a project, task, tag or comment is listed here, newest first.'),
      me.can_edit ? el('p', null, el('a', { href: 'index.html', class: 'button' }, 'Create a project')) : null];
  setChildren(empty, items);
}

/** @param {any} a */
function row(a) {
  const d = describeActivity(a, { projectNames: state.projectNames, words });
  const fresh = state.forMe && a.created_at > state.seenBefore;
  return el('tr', { class: fresh ? 'activity-new' : null },
    el('td', null, timeEl(a.created_at), fresh ? [' ', el('b', { class: 'new-mark' }, 'New')] : null),
    el('td', null, a.actor_name),
    el('td', null, viaBadge(a.via)),
    el('td', { class: 'activity-what' }, d.what),
    el('td', null, d.link ?? text('')));
}
