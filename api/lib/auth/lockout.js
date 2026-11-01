// Brute-force limit for password checks, in memory and per process.
// Keyed by the normalized username, whether or not that user exists, so a 429
// never tells anyone which names are real. A restart forgets everything, and
// several processes each keep their own count.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const DEFAULT_MAX_KEYS = 10_000;

/** @param {string} username @returns {string} */
export const lockoutKey = (username) => username.trim().toLowerCase();

/**
 * @typedef {{ failures: number[], locked_until: number }} Entry
 * @typedef {ReturnType<typeof createLockout>} Lockout
 */

/**
 * @param {{maxKeys?: number}} [opts]  maxKeys: how many names to track (tests use a small number)
 */
export function createLockout(opts = {}) {
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  /** @type {Map<string, Entry>} */
  const entries = new Map();

  /** @param {Entry} e @param {number} now @returns {number} ms when this entry stops mattering (0 = already) */
  const liveUntil = (e, now) => {
    if (e.locked_until > now) return e.locked_until;
    const recent = e.failures.filter((t) => t > now - WINDOW_MS);
    return recent.length ? recent[0] + WINDOW_MS : 0;
  };

  /**
   * Drop entries that no longer count. A locked entry, or one with failures
   * inside the window, is never dropped: forgetting it would hand out fresh
   * guesses. Returns when the soonest live entry expires.
   * @param {number} now
   */
  const prune = (now) => {
    let soonest = Infinity;
    for (const [k, e] of entries) {
      const until = liveUntil(e, now);
      if (until === 0) entries.delete(k);
      else soonest = Math.min(soonest, until);
    }
    return soonest;
  };

  return {
    /**
     * Call before checking a password. Returns the seconds to wait if the name
     * is locked (or, when every slot is taken by live entries, for any new name:
     * fail closed); otherwise counts this attempt as a failure up front (so
     * parallel guesses cannot slip past the limit) and returns 0. Call
     * succeeded() after a correct password.
     * @param {string} key  lockoutKey(username)
     * @param {number} now  ms
     * @returns {number}
     */
    attempt(key, now) {
      let e = entries.get(key);
      if (e && e.locked_until > now) return (e.locked_until - now) / 1000;
      if (e && e.locked_until) { entries.delete(key); e = undefined; } // a lock that ran out starts a clean slate
      if (!e) {
        if (entries.size >= maxKeys) {
          const soonest = prune(now);
          if (entries.size >= maxKeys) return (soonest - now) / 1000;
        }
        e = { failures: [], locked_until: 0 };
        entries.set(key, e);
      }
      e.failures = e.failures.filter((t) => t > now - WINDOW_MS);
      e.failures.push(now);
      if (e.failures.length >= MAX_FAILURES) e.locked_until = now + LOCK_MS;
      return 0;
    },

    /**
     * Take back the failure attempt() counted at `at`, when the password was never
     * checked (the server was too busy), so load alone cannot lock anyone out.
     * @param {string} key
     * @param {number} at  the `now` given to attempt()
     */
    undo(key, at) {
      const e = entries.get(key);
      if (!e) return;
      const i = e.failures.lastIndexOf(at);
      if (i >= 0) e.failures.splice(i, 1);
      if (e.failures.length < MAX_FAILURES) e.locked_until = 0;
    },

    /** @param {string} key */
    succeeded(key) {
      entries.delete(key);
    },
  };
}
