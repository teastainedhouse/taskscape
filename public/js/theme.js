// theme.js — which look the page wears. Every page links the site's default
// theme (css/theme-<name>.css); applyTheme() swaps the link to the person's
// preferred one once /api/me is in, and remembers the name per browser so the
// next page load can swap before the first paint rather than after the
// request (storage is a nicety: every access is inside try).

const KEY = 'taskscape_theme';
const NAME = /^[a-z0-9-]{1,40}$/;

/** The theme stylesheet link, by its href shape. */
const link = () => [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => /^css\/theme-[a-z0-9-]+\.css$/.test(l.getAttribute('href') ?? ''));

/** Point the theme link at `name` (a validated short name). @param {string} name */
function swap(name) {
  const l = link();
  if (!l) return;
  const href = `css/theme-${name}.css`;
  if (l.getAttribute('href') !== href) l.setAttribute('href', href);
}

/**
 * Wear `name`, if it is one of the configured themes, and remember it here.
 * @param {string|null|undefined} name
 * @param {string[]} allowed  config.themes
 * @param {{remember?: boolean, fallback?: string}} [opts]  remember: false for the sign-in page, which shows the site default without
 *   forgetting the person's; fallback: the site default, worn when `name` is not listed (else the first listed)
 */
export function applyTheme(name, allowed, { remember = true, fallback } = {}) {
  // Every name that reaches an href passes NAME and sits in a fixed "css/theme-<name>.css", so no stored or
  // served value can leave css/ or change the scheme; a name the site no longer lists falls back to the default.
  const ok = (n) => typeof n === 'string' && NAME.test(n) && allowed.includes(n);
  if (!ok(name)) name = ok(fallback) ? fallback : allowed.find((n) => NAME.test(n));
  if (!name) return;
  swap(name);
  if (!remember) return;
  try { localStorage.setItem(KEY, name); } catch { /* the swap above still holds for this page */ }
}

/** Forget the remembered theme (sign-out, or switching dev user): the next person starts from the site default. */
export function forgetTheme() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}

/** The theme this browser last wore, applied before the API answers; boot() corrects it if it changed. */
export function applyRememberedTheme() {
  let name = null;
  try { name = localStorage.getItem(KEY); } catch { return; }
  if (typeof name === 'string' && NAME.test(name)) swap(name);
}
