// inline-edit.js — click a value to edit it, the one module every page uses
// for editing in place (docs/PLAN.md §8). The value is a real button: Tab
// reaches it, Enter or Space opens the editor. In the editor, Escape cancels;
// Enter (Ctrl/Cmd+Enter in a textarea) or leaving the field saves when the
// value changed; a select saves when a pointer picks an option (a keyboard
// steps through options and saves with Enter or Tab), a checkbox when it
// changes. Each save is one call to `save(v)`, which the caller makes a PATCH
// of that one field with the version it was drawn with (through attempt(), so
// a 409 shows the current record). Focus comes back to the value after a
// key-driven save or cancel; a save triggered by leaving the field keeps focus
// where the person put it, even when the caller redraws the section (see
// redraw()). Results are announced through say(). When the caller may not
// edit, or the item is in the trash, the value is plain text with no control.

import { el, setChildren, append, clear } from './dom.js';
import { say } from './page.js';

/**
 * @typedef {Object} InlineEditSpec
 * @property {string} key       unique on the page (e.g. "project-name", "task-<id>-status"); focus finds the value by it after a redraw
 * @property {string} label     what the field is called, for the accessible name and the announcement ("Status")
 * @property {boolean} allowed  false shows plain text
 * @property {any} value        the stored value (string, boolean, or null)
 * @property {(v: any) => (Node|string|Array<Node|string>)} [format]  how the value shows; default: the value as text
 * @property {string} [empty]   shown muted when the value is empty; default "(none)"
 * @property {(v: any) => HTMLElement} control  builds the editor preset with the value (input, select, textarea, checkbox)
 * @property {(control: HTMLElement) => any} [read]  the control's value; default: `checked` for a checkbox, else `value`
 * @property {(v: any) => Promise<any>} save  performs the write; resolves truthy on success (an object with a string `note`
 *   adds that note to the announcement), falsy when nothing was saved
 * @property {boolean} [block]  the value is a block (notes, description): the button fills the line and keeps line breaks
 */

/** Values that count as "nothing": null, undefined, and the empty string. */
const norm = (v) => (v === undefined || v === null ? '' : v);

/**
 * Build a click-to-edit value.
 * @param {InlineEditSpec} spec
 * @returns {HTMLElement}
 */
export function inlineEdit(spec) {
  const host = el('span', { class: spec.block ? 'editable editable--block' : 'editable', 'data-field': spec.key });
  let value = spec.value;
  show();
  return host;

  /** The display content for a value. */
  function content(v) {
    if (norm(v) === '' && spec.format === undefined) return el('span', { class: 'muted' }, spec.empty ?? '(none)');
    return spec.format ? spec.format(v) : String(v);
  }

  /** View mode: plain text, or a button that opens the editor. */
  function show() {
    if (!spec.allowed) {
      setChildren(host, [el('span', { class: 'editable__text' }, content(value))]);
      return;
    }
    const button = el('button', { type: 'button', class: 'editable__value' }, content(value),
      el('span', { class: 'visually-hidden' }, `, edit ${spec.label.toLowerCase()}`));
    button.addEventListener('click', edit);
    setChildren(host, [button]);
  }

  /** Edit mode. */
  function edit() {
    const control = spec.control(value);
    control.setAttribute('aria-label', spec.label);
    const isText = control instanceof HTMLTextAreaElement;
    const isSelect = control instanceof HTMLSelectElement;
    const isCheck = control instanceof HTMLInputElement && control.type === 'checkbox';
    const isLine = control instanceof HTMLInputElement && control.type === 'text';
    const read = spec.read ?? ((c) => (isCheck ? c.checked : c.value));
    let settled = false; // once a save or cancel began, later blur events are ignored
    let pointer = false; // a select's change came from a pointer (keyboard changes wait for Enter or Tab)
    /** Where focus went when the field was left, so a redraw during the save can give it back. */
    let wentTo = null;

    const finish = (refocus) => {
      settled = true;
      show();
      if (refocus) host.querySelector('button')?.focus();
    };
    const cancel = () => {
      if (settled) return;
      finish(true);
      say('Edit cancelled.');
    };
    const unchanged = (v) => (isLine ? String(v).trim() === String(norm(value)).trim() : norm(v) === norm(value));
    const commit = async (refocus) => {
      if (settled) return;
      const v = read(control);
      if (unchanged(v)) { finish(refocus); return; }
      settled = true;
      control.setAttribute('aria-busy', 'true');
      control.disabled = true; // the blur this causes is ignored: settled
      let result = null;
      try {
        result = await spec.save(v);
      } finally {
        if (result) value = v;
        // The caller may have redrawn the section meanwhile; find the value by its key either way.
        if (host.isConnected) show();
        if (refocus) (host.isConnected ? host.querySelector('button') : findEditable(spec.key))?.focus();
        else if (wentTo && document.activeElement === document.body) focusLike(wentTo);
      }
      if (result) say(result?.note ? `${spec.label} saved. ${result.note}` : `${spec.label} saved.`);
    };

    control.addEventListener('keydown', (ev) => {
      pointer = false; // back on the keyboard: the next change waits for Enter or Tab
      if (ev.isComposing) return;
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      else if (ev.key === 'Enter' && (!isText || ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(true); }
    });
    control.addEventListener('blur', (ev) => {
      if (settled) return;
      wentTo = describe(ev.relatedTarget);
      // Next tick: a blur because the window lost focus leaves the control active (nothing to save yet),
      // and a blur because the section was redrawn under the editor leaves it detached (never sent).
      setTimeout(() => {
        if (settled || document.activeElement === control) return;
        if (!control.isConnected) { settled = true; return; }
        commit(false);
      }, 0);
    });
    if (isSelect) {
      control.addEventListener('pointerdown', () => { pointer = true; });
      control.addEventListener('change', () => { if (pointer) commit(true); });
    }
    if (isCheck) control.addEventListener('change', () => commit(true));

    setChildren(host, [control]);
    control.focus();
    if (isLine) control.select();
  }
}

/** The value button with this key, found without building a selector from the key. @param {string} key */
function findEditable(key) {
  for (const host of document.querySelectorAll('.editable')) if (host.dataset.field === key) return host.querySelector('button');
  return null;
}

/**
 * Put focus on the value with this key, after a page section was redrawn.
 * @param {string} key
 */
export function focusEditable(key) {
  findEditable(key)?.focus();
}

/** Enough about an element to find its twin after a redraw: an editable's key, or an id. @param {EventTarget|null} node */
function describe(node) {
  if (!(node instanceof Element)) return null;
  const key = node.closest('.editable')?.dataset.field;
  if (key) return { key };
  const withId = node.closest('[id]');
  return withId ? { id: withId.id, tag: node.tagName } : null;
}

/** Focus the twin of a described element. @param {{key?: string, id?: string, tag?: string}} d */
function focusLike(d) {
  if (d.key) { findEditable(d.key)?.focus(); return; }
  const root = d.id && document.getElementById(d.id);
  if (!root) return;
  (root.tagName === d.tag ? root : root.querySelector(d.tag)) ?.focus();
}

/**
 * Replace a container's children with fresh ones while keeping what the person
 * is doing: an editor that is open stays open (its host moves into the fresh
 * content; its save still carries the version it was drawn with, so a stale
 * edit meets a 409), and focus stays on the control at the same position.
 * @param {Element} container
 * @param {any} children  as for setChildren()
 */
export function redraw(container, children) {
  const fresh = document.createDocumentFragment();
  append(fresh, children);
  // Focus, as a path of child indexes from the container.
  const active = document.activeElement;
  let path = null;
  if (active && active !== container && container.contains(active)) {
    path = [];
    for (let n = active; n !== container; n = n.parentNode) path.unshift([...n.parentNode.children].indexOf(n));
  }
  // Open editors move across. One whose save is in flight (its control is disabled) is not open: the
  // fresh value wins, and its save finds the fresh host by key when it settles.
  const twins = new Map([...fresh.querySelectorAll('.editable')].map((h) => [h.dataset.field, h]));
  for (const host of container.querySelectorAll('.editable')) {
    const control = host.querySelector('input, select, textarea');
    if (control && !control.disabled && twins.has(host.dataset.field)) twins.get(host.dataset.field).replaceWith(host);
  }
  const keep = document.activeElement; // inside a moved host, it stays focused
  clear(container);
  container.appendChild(fresh);
  if (keep && keep !== document.body && keep.isConnected) return;
  if (!path) return;
  let n = container;
  for (const i of path) n = n?.children[i];
  if (n && typeof n.focus === 'function') n.focus();
}

/**
 * A select preset to `current`, with an extra option for a value that is not in the list.
 * @param {Array<{value: string, label?: string}>} options
 * @param {string|null} current
 * @param {{missing?: string}} [opts]  label for a current value that is not in the list; default "<value> (not configured)"
 */
export function selectFor(options, current, opts = {}) {
  const s = el('select');
  if (current && !options.some((o) => o.value === current)) append(s, el('option', { value: current, selected: true }, opts.missing ?? `${current} (not configured)`));
  for (const o of options) append(s, el('option', { value: o.value, selected: o.value === current }, o.label ?? o.value));
  return s;
}
