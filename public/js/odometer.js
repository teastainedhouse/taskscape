// odometer.js — the 1996 visitor counter (docs/PLAN.md §9). Not named after
// "hit counter": tracker blocklists refuse files with that name.
// Six zero-padded digit cells, role="img", and the webring Easter egg:
// three clicks within two seconds reveal the hidden webring footer bar.

import { el, safeUrl } from './dom.js';

const MIN_DIGITS = 6;
const CLICKS_NEEDED = 3;
const CLICK_WINDOW_MS = 2000;

/**
 * Render the counter.
 * @param {number} count
 * @param {{isPrivate?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function renderHitCounter(count, opts = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const span = el('span', {
    class: 'hit-counter',
    role: 'img',
    'aria-label': `You are visitor number ${n}`,
    tabindex: '0',
  });
  if (opts.isPrivate) span.title = "Private project: only the owner's visits are counted.";
  else span.title = 'Visitor counter';
  for (const d of String(n).padStart(MIN_DIGITS, '0')) span.appendChild(el('span', { class: 'digit', 'aria-hidden': 'true' }, d));
  return span;
}

/**
 * Update an existing counter in place (after POST /hit returns).
 * @param {HTMLElement} span
 * @param {number} count
 */
export function updateHitCounter(span, count) {
  const fresh = renderHitCounter(count, { isPrivate: span.title.startsWith('Private') });
  span.replaceWith(fresh);
  return fresh;
}

/**
 * Build the "Taskscape Webring: Prev | Random | Next" bar from config.webring.
 * Returns null when the list is empty (the bar is then not rendered at all).
 * @param {Array<{name?: string, url?: string}>} webring
 * @returns {HTMLElement|null}
 */
export function buildWebringBar(webring) {
  const entries = (webring ?? []).filter((w) => {
    try { return typeof w?.url === 'string' && safeUrl(w.url); } catch { return false; }
  });
  if (!entries.length) return null;
  const pick = (i) => entries[((i % entries.length) + entries.length) % entries.length];
  const link = (label, entry) => el('a', { href: entry.url, title: entry.name ? String(entry.name) : undefined, rel: 'noopener' }, label);
  const random = pick(Math.floor(Math.random() * entries.length));
  return el('div', { class: 'webring', hidden: true, id: 'webring-bar' },
    'Taskscape Webring: ', link('Prev', pick(-1)), ' | ', link('Random', random), ' | ', link('Next', pick(0)));
}

/**
 * Wire the Easter egg: three clicks (or Enter presses) on the counter within
 * two seconds un-hide the webring bar.
 * @param {HTMLElement} counterHost  the element that contains the counter (survives re-renders)
 * @param {HTMLElement|null} bar
 */
export function attachWebringEgg(counterHost, bar) {
  if (!bar) return;
  let clicks = [];
  const tap = () => {
    const now = Date.now();
    clicks = clicks.filter((t) => now - t < CLICK_WINDOW_MS);
    clicks.push(now);
    if (clicks.length >= CLICKS_NEEDED) { bar.hidden = false; clicks = []; }
  };
  counterHost.addEventListener('click', (ev) => { if (ev.target.closest('.hit-counter')) tap(); });
  counterHost.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest('.hit-counter')) { ev.preventDefault(); tap(); }
  });
}
