// pager.js — "Load more" for the list routes. They answer {items, limit, offset}
// (docs/API.md §5) with no total, so there is more exactly when a page comes
// back full. The query is captured when the list starts over, so every later
// page keeps the sort and filters the first page had.

import { get } from './api.js';

/**
 * @param {{
 *   path: string,
 *   button: {hidden: boolean, ariaDisabled?: string|null, addEventListener: (type: string, fn: () => void) => void},
 *   query: () => Record<string, any>,
 *   onPage: (items: any[], first: boolean) => ({focus?: () => void}|null|undefined),
 *   onError: (err: unknown) => void,
 *   fetchPage?: (path: string, query: Record<string, any>) => Promise<{items?: any[], limit: number}>,
 * }} spec
 *   onPage gets each page as it arrives (first = the list starts over), without items
 *   already shown, and may return a control to take focus when the button goes away
 *   under it: the first new row, or, after an empty last page, the last row.
 */
export function createPager(spec) {
  const fetchPage = spec.fetchPage ?? get;
  let query = {};
  let offset = 0;
  let generation = 0;
  let busy = false;
  /** Ids already handed to onPage: an edit can move a loaded row past the offset, and it must not show twice. */
  let shown = new Set();
  spec.button.hidden = true;
  // The button stays enabled while a page loads (aria-disabled plus a busy flag), so it keeps focus.
  spec.button.addEventListener('click', () => (busy ? undefined : load(false)));

  /** @param {boolean} first */
  async function load(first) {
    if (first) { generation++; query = spec.query(); offset = 0; shown = new Set(); }
    const mine = generation;
    setBusy(true);
    try {
      const res = await fetchPage(spec.path, offset ? { ...query, offset } : query);
      if (mine !== generation) return; // the list started over meanwhile
      const items = res.items ?? [];
      offset += items.length;
      const fresh = items.filter((x) => x?.id === undefined || !shown.has(x.id));
      for (const x of fresh) if (x?.id !== undefined) shown.add(x.id);
      const hadFocus = typeof document !== 'undefined' && document.activeElement === spec.button;
      spec.button.hidden = items.length < res.limit;
      const target = spec.onPage(fresh, first);
      if (hadFocus && spec.button.hidden) target?.focus?.();
    } catch (err) {
      if (mine === generation) spec.onError(err);
    } finally {
      if (mine === generation) setBusy(false);
    }
  }

  /** @param {boolean} on */
  function setBusy(on) { busy = on; spec.button.ariaDisabled = on ? 'true' : null; }

  return {
    /** Start over with the current query. */
    reload: () => load(true),
    /** Items left the loaded list (trashed, moved away, no longer matching), so the next page starts that much earlier. */
    removed: (n = 1) => { offset = Math.max(0, offset - n); },
  };
}
