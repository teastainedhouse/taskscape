// mentions.js — @mentions in the comment box. mentionText() splits a
// comment's text into text and highlighted spans for the people the server
// says it mentions (textContent only). mentionPicker() adds a list of people
// to a textarea while "@name" is being typed: the ARIA combobox pattern as far
// as a textarea allows (HTML gives a textarea no combobox role, so it keeps
// its textbox role with aria-autocomplete, aria-controls and
// aria-activedescendant on a listbox). Typing "@id" by hand works the same;
// the server decides what is a mention.

import { el, setChildren } from './dom.js';

/** The server's rule, character for character (api/lib/repo/comments.js MENTION_RE; a test compares them). */
export const MENTION_RE = /(^|[^\p{L}\p{N}_@.])@([A-Za-z0-9][A-Za-z0-9._@+-]{0,253})(?![\p{L}\p{N}])/gu;
/** An "@" being typed just before the caret. */
const TYPING_RE = /(^|[^\p{L}\p{N}_@.])@([A-Za-z0-9._@+-]{0,253})$/u;
/** The rest of a mention word after the caret. */
const WORD_REST_RE = /^[A-Za-z0-9._@+-]*/;
/** Ids the server can read as a mention; the picker offers no others. */
const MENTIONABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/;

/** What a mention word may name, longest first: the server's mentionCandidates(). @param {string} word */
function candidates(word) {
  const out = [word];
  let w = word;
  while (/[._@+-]$/.test(w)) { w = w.slice(0, -1); out.push(w); }
  return out;
}
/** Suggestions shown at once. */
const MAX_OPTIONS = 8;

/**
 * A comment's text with the people it mentions highlighted: strings and spans, for append().
 * @param {string} text @param {Array<{id: string, name: string}>} mentions  from the API
 * @returns {Array<string|HTMLElement>}
 */
export function mentionText(text, mentions) {
  const exact = new Map((mentions ?? []).map((m) => [m.id, m]));
  if (!exact.size) return [text];
  const lower = new Map();
  for (const m of mentions) if (!lower.has(m.id.toLowerCase())) lower.set(m.id.toLowerCase(), m);
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    // the longest part of the word that names someone the server stored, exactly before ignoring case
    let hit = null;
    for (const c of candidates(m[2])) { const who = exact.get(c) ?? lower.get(c.toLowerCase()); if (who) { hit = { word: c, who }; break; } }
    if (!hit) continue;
    const at = m.index + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(el('span', { class: 'mention', title: hit.who.name }, `@${hit.word}`));
    last = at + 1 + hit.word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Suggest people while "@…" is typed in `textarea`. Returns the elements to place right after it.
 * @param {HTMLTextAreaElement} textarea  needs an id
 * @param {{me: {id: string}, loadPeople: () => Promise<Array<{id: string, name: string}>>}} opts
 * @returns {HTMLElement[]}
 */
export function mentionPicker(textarea, { me, loadPeople }) {
  const listId = `${textarea.id}-people`;
  const hintId = `${textarea.id}-mention-hint`;
  const listbox = el('ul', { id: listId, role: 'listbox', class: 'mention-list', hidden: true, 'aria-label': 'People to mention' });
  const hint = el('span', { id: hintId, class: 'visually-hidden' }, 'Type @ and a name to mention someone.');
  const status = el('span', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  textarea.setAttribute('aria-autocomplete', 'list');
  textarea.setAttribute('aria-controls', listId);
  textarea.setAttribute('aria-describedby', [textarea.getAttribute('aria-describedby'), hintId].filter(Boolean).join(' '));

  /** @type {Promise<Array<{id: string, name: string}>>|null} */ let loading = null;
  /** @type {Array<{id: string, name: string}>} */ let options = [];
  let active = -1;
  let start = -1; // where the "@" being completed sits
  let said = '';

  /** The "@…" just before the caret, or null. */
  function typing() {
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return null;
    const m = TYPING_RE.exec(textarea.value.slice(0, pos));
    return m ? { start: pos - m[2].length - 1, query: m[2].toLowerCase() } : null;
  }

  /** The people list, asked for once at a time; a failed load is asked again next time. */
  function people() {
    loading ??= loadPeople().then((list) => list.filter((p) => p.id !== me.id && MENTIONABLE_ID.test(p.id)), (err) => { loading = null; throw err; });
    return loading;
  }

  async function update() {
    if (!typing()) return close();
    let list;
    try { list = await people(); } catch { return close(); }
    // the list may have taken a while: draw what is typed now, and only where the person still is
    const t = typing();
    if (!t || document.activeElement !== textarea) return close();
    const words = (p) => p.name.toLowerCase().split(/\s+/);
    const exactFirst = (p) => (p.id.toLowerCase() === t.query ? 0 : 1);
    options = list.filter((p) => p.id.toLowerCase().startsWith(t.query) || words(p).some((w) => w.startsWith(t.query)))
      .sort((x, y) => exactFirst(x) - exactFirst(y)).slice(0, MAX_OPTIONS);
    if (!options.length) return close();
    if (start !== t.start) active = 0;
    active = Math.min(Math.max(active, 0), options.length - 1);
    start = t.start;
    draw();
  }

  function draw() {
    setChildren(listbox, options.map((p, i) => {
      const li = el('li', { id: `${listId}-${i}`, role: 'option', 'aria-selected': i === active ? 'true' : 'false', class: 'mention-option' },
        p.name, ' ', el('span', { class: 'muted' }, `@${p.id}`));
      li.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the textarea
      li.addEventListener('click', () => choose(i));
      return li;
    }));
    listbox.hidden = false;
    textarea.setAttribute('aria-activedescendant', `${listId}-${active}`);
    const line = `${options.length} ${options.length === 1 ? 'person matches' : 'people match'}. Up and down arrows to choose, Enter to mention, Escape to close.`;
    if (line !== said) status.textContent = said = line;
  }

  function close() {
    if (listbox.hidden) return;
    listbox.hidden = true;
    setChildren(listbox, []);
    textarea.removeAttribute('aria-activedescendant');
    options = [];
    start = -1;
    said = '';
    status.textContent = '';
  }

  /** Replace the whole word being typed (the caret may sit inside it) with the person's id. @param {number} i */
  function choose(i) {
    const p = options[i];
    if (!p) return;
    const pos = textarea.selectionStart;
    const end = pos + (WORD_REST_RE.exec(textarea.value.slice(pos))?.[0].length ?? 0);
    const next = textarea.value.charAt(end);
    const insert = `@${p.id}${next === '' || !/[\s,.;:!?)\]]/.test(next) ? ' ' : ''}`;
    const max = Number(textarea.getAttribute('maxlength')) || Infinity;
    if (textarea.value.length - (end - start) + insert.length > max) {
      close();
      status.textContent = 'There is no room left for that name.';
      return;
    }
    textarea.setRangeText(insert, start, end, 'end');
    close();
    status.textContent = `Mentioned ${p.name}.`;
    textarea.focus();
  }

  textarea.addEventListener('input', () => { update(); });
  textarea.addEventListener('click', () => { update(); });
  textarea.addEventListener('keyup', (ev) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) update(); });
  textarea.addEventListener('blur', close);
  textarea.addEventListener('keydown', (ev) => {
    if (listbox.hidden || ev.isComposing) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = (active + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      draw();
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      choose(active);
    } else if (ev.key === 'Tab') {
      close(); // Tab leaves the box as always; only Enter picks
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // closes the list, not whatever holds the form
      close();
    }
  });
  return [listbox, hint, status];
}
