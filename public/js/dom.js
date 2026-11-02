// dom.js — element helpers. Everything goes through createElement and
// textContent, so user-entered text can never become markup.

/** Attributes that are set as properties, not attributes. */
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'hidden', 'required', 'open']);
/** Attributes that carry URLs and are allow-listed to http(s), mailto, or relative. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

/**
 * Validate a URL for an href/src: only http(s), mailto, or a relative URL.
 * Anything else (other schemes) throws, so it can never reach the DOM.
 * @param {string} url
 * @returns {string}
 */
export function safeUrl(url) {
  const u = new URL(String(url), document.baseURI);
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('URL scheme not allowed');
  return String(url);
}

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]  'class', 'text', properties in PROPS, URL attrs (validated), the rest via setAttribute.
 *   Event handler attributes are refused; use addEventListener.
 * @param {...(Node|string|number|null|undefined|Array)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (/^on/i.test(k)) throw new Error('event handlers go through addEventListener');
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (PROPS.has(k)) node[k] = v;
      else if (URL_ATTRS.has(k)) node.setAttribute(k, safeUrl(v));
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

/**
 * Append children (strings become text nodes; arrays are flattened; null is skipped).
 * @param {Node} parent
 * @param {any} children
 */
export function append(parent, children) {
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

/** The only SVG we draw: shapes. No links, scripts, foreign content, or animation. */
const SVG_TAGS = new Set(['svg', 'g', 'rect', 'title']);
const SVG_ATTRS = new Set(['viewBox', 'width', 'height', 'x', 'y', 'fill', 'shape-rendering', 'aria-hidden', 'focusable', 'class', 'role']);

/**
 * An SVG element (createElementNS), from a short allowlist of tags and
 * attributes, so no caller can build a link, a script, or an animation out of it.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {...(Node|null|undefined)} children
 */
export function svg(tag, attrs, ...children) {
  if (!SVG_TAGS.has(tag)) throw new Error('SVG tag not allowed');
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null) continue;
    if (!SVG_ATTRS.has(k)) throw new Error('SVG attribute not allowed');
    node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/**
 * User text made safe for a confirm() dialog: one line, no control or
 * bidirectional override characters (which could rewrite what the dialog
 * appears to say), cut to `max` characters.
 * @param {unknown} s @param {number} [max]
 */
export function oneLine(s, max = 80) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].length > max ? [...t].slice(0, max - 1).join('') + '…' : t;
}

/** Remove every child of a node. @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace the children of a node. @param {Node} node @param {any} children */
export function setChildren(node, children) {
  clear(node);
  append(node, children);
}

/** A text node. @param {any} s */
export function text(s) {
  return document.createTextNode(String(s ?? ''));
}

/**
 * A button with a click handler.
 * @param {string} label
 * @param {(ev: MouseEvent) => any} onClick
 * @param {Record<string, any>} [attrs]
 */
export function btn(label, onClick, attrs) {
  const b = el('button', { type: 'button', ...(attrs ?? {}) }, label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * An <option>.
 * @param {string} value
 * @param {string} [label]
 * @param {boolean} [selected]
 */
export function option(value, label, selected) {
  return el('option', { value, selected: !!selected }, label ?? value);
}

/**
 * A <select> with a label.
 * @param {{id: string, label: string, options: Array<{value: string, label?: string}>, value?: string, blank?: string}} spec
 * @returns {{wrap: HTMLElement, select: HTMLSelectElement}}
 */
export function labeledSelect(spec) {
  const select = el('select', { id: spec.id, name: spec.id });
  if (spec.blank != null) select.appendChild(option('', spec.blank));
  for (const o of spec.options) select.appendChild(option(o.value, o.label ?? o.value, o.value === spec.value));
  const wrap = el('div', { class: 'field' }, el('label', { for: spec.id }, spec.label), select);
  return { wrap, select };
}

/** Private marker: a padlock icon. */
export function padlock() {
  return el('span', { class: 'padlock', title: 'Private: only you can see this' },
    el('img', { src: 'img/padlock.svg', alt: 'Private', width: '14', height: '14' }));
}

/**
 * Link to a project page (ids are URL-encoded).
 * @param {string} id
 * @param {string} label
 */
export function projectLink(id, label) {
  return el('a', { href: `project.html?id=${encodeURIComponent(id)}` }, label);
}

/**
 * Link to a task page.
 * @param {string} id
 * @param {string} label
 */
export function taskLink(id, label) {
  return el('a', { href: `task.html?id=${encodeURIComponent(id)}` }, label);
}

/**
 * Colored tag chip. The color is applied only if it is a strict #rrggbb value.
 * @param {{name: string, color?: string}} tag
 * @param {HTMLElement} [extra]  e.g. a detach button
 */
export function tagChip(tag, extra) {
  const chip = el('span', { class: 'tag-chip' }, tag.name, extra ?? null);
  if (typeof tag.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(tag.color)) {
    chip.style.backgroundColor = tag.color;
    chip.style.color = luminance(tag.color) > 0.45 ? '#000000' : '#ffffff';
  }
  return chip;
}

/** Relative luminance of a #rrggbb color (0..1). @param {string} hex */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The person's preferred IANA time zone (page.js sets it from /api/me); null means the device's. */
let zone = null;

/** Use this time zone for every date shown and for "today". @param {string|null|undefined} tz */
export function setTimeZone(tz) {
  zone = typeof tz === 'string' && tz ? tz : null;
}

/**
 * Format an ISO timestamp for humans in the viewer's locale, in their preferred time zone.
 * @param {string|null} iso
 */
export function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone ?? undefined });
  } catch {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}

/** A <time> element. @param {string|null} iso */
export function timeEl(iso) {
  return iso ? el('time', { datetime: iso }, fmtWhen(iso)) : text('');
}

/** Today's date as YYYY-MM-DD in the preferred time zone (else the device's). */
export function todayLocal() {
  const d = new Date();
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const get = (type) => parts.find((x) => x.type === type)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')}`;
    } catch { /* an unknown zone: fall back to the device's */ }
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
