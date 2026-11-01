// for-you.js — "For you" in What's New (docs/PLAN.md §8): entries by other
// people about what I own (GET /api/activity?for=me), and the unread badge on
// the toolbar's What's New entry. "Last seen" is the created_at of the newest
// entry shown in the For you view, kept per browser and per user in
// localStorage; every access is wrapped, so blocked or full storage costs
// only the badge.

import { get } from './api.js';
import { el } from './dom.js';

/** The badge counts this many at most, then says "N+". */
const BADGE_LIMIT = 20;

/** Kept in memory too, so a page whose storage refuses writes still clears its own badge. */
let memorySeen = '';

/** @param {{id: string}} me */
const storageKey = (me) => `taskscape_for_you_seen:${me.id}`;

/** created_at of the newest For you entry this user has seen here, or ''. @param {{id: string}} me */
export function readSeen(me) {
  let stored = '';
  try { stored = localStorage.getItem(storageKey(me)) || ''; } catch { /* storage unavailable */ }
  return stored > memorySeen ? stored : memorySeen;
}

/**
 * Remember the newest entry shown in the For you view and clear the badge.
 * @param {{id: string}} me @param {string|undefined} newest
 */
export function markSeen(me, newest) {
  if (newest && newest > readSeen(me)) {
    memorySeen = newest;
    try { localStorage.setItem(storageKey(me), newest); } catch { /* the memory copy covers this page */ }
  }
  showBadge(0, false);
}

/** Count unseen For you entries and show them on the toolbar. @param {{id: string}} me */
export async function refreshBadge(me) {
  const res = await get('/api/activity', { for: 'me', limit: BADGE_LIMIT + 1 });
  const seen = readSeen(me); // read after the request, so a markSeen() meanwhile wins
  const unread = (res.items ?? []).filter((a) => a.created_at > seen).length;
  showBadge(Math.min(unread, BADGE_LIMIT), unread > BADGE_LIMIT);
}

/** @param {number} n @param {boolean} more */
function showBadge(n, more) {
  const link = document.querySelector('nav a[href="whats-new.html"]');
  if (!link) return;
  link.querySelector('.nav-badge')?.remove();
  if (!n) return;
  link.appendChild(el('span', { class: 'nav-badge' },
    el('span', { class: 'visually-hidden' }, ': '), `${n}${more ? '+' : ''}`, el('span', { class: 'visually-hidden' }, ' new for you')));
}
