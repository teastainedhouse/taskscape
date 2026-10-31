// tags.js — tag chips with attach/detach for a project or task, and a
// "new tag" form. Tags are a shared public vocabulary (names and colors
// only), so the editor says so where tags are created.

import { el, btn, option, tagChip, setChildren } from './dom.js';
import { get, post, put, del, itemPath } from './api.js';
import { attempt, say } from './page.js';

/** Cached list of all tags, refreshed after a create. */
let cache = null;

/** @returns {Promise<Array<{id: string, name: string, color: string}>>} */
export async function allTags(force) {
  if (!cache || force) cache = (await get('/api/tags')).items ?? [];
  return cache;
}

/**
 * Create (or fetch the existing) tag by name.
 * @param {string} name
 * @param {string} [color]  #rrggbb
 */
export async function createTag(name, color) {
  const body = { name };
  if (color) body.color = color;
  const tag = await post('/api/tags', body);
  await allTags(true);
  return tag;
}

/**
 * Render a tag editor for one item.
 * @param {{
 *   type: 'project'|'task', item: {id: string, version: number, tags: Array<any>},
 *   canEdit: boolean, onUpdated: (record: any) => void, compact?: boolean, config?: any
 * }} spec
 * @returns {HTMLElement}
 */
export function tagEditor(spec) {
  const host = el('span', { class: 'tag-editor' });
  render();
  return host;

  function render() {
    const { item } = spec;
    const chips = (item.tags ?? []).map((t) => tagChip(t, spec.canEdit ? detachButton(t) : null));
    const parts = [chips];
    if (spec.canEdit) parts.push(attachControl());
    setChildren(host, parts);
  }

  function detachButton(tag) {
    return btn('×', async () => {
      const rec = await attempt(() => del(`${itemPath(spec.type, spec.item.id)}/tags/${encodeURIComponent(tag.id)}`, { version: spec.item.version }), onConflict);
      if (rec) { spec.item = rec; spec.onUpdated(rec); render(); }
    }, { 'aria-label': `Remove tag ${tag.name}`, title: 'Remove tag' });
  }

  function onConflict(current) {
    spec.item = current;
    spec.onUpdated(current);
    render();
  }

  function attachControl() {
    const select = el('select', { 'aria-label': 'Add a tag' });
    select.appendChild(option('', spec.compact ? '+ tag' : 'Add a tag…'));
    const attached = new Set((spec.item.tags ?? []).map((t) => t.id));
    allTags().then((tags) => {
      for (const t of tags) if (!attached.has(t.id)) select.appendChild(option(t.id, t.name));
      if (!spec.compact) select.appendChild(option('__new__', 'New tag…'));
    });
    select.addEventListener('change', async () => {
      const v = select.value;
      if (!v) return;
      if (v === '__new__') { select.value = ''; showNewTagForm(); return; }
      await attach(v);
    });
    return select;
  }

  async function attach(tagId) {
    const rec = await attempt(() => put(`${itemPath(spec.type, spec.item.id)}/tags/${encodeURIComponent(tagId)}`, { version: spec.item.version }), onConflict);
    if (rec) { spec.item = rec; spec.onUpdated(rec); render(); }
  }

  function showNewTagForm() {
    const palette = spec.config?.tag_palette ?? [];
    const name = el('input', { type: 'text', maxlength: '40', required: true, id: `newtag-${spec.item.id}`, placeholder: 'tag name' });
    const color = el('select', { 'aria-label': 'Tag color' }, option('', 'next palette color'));
    for (const c of palette) color.appendChild(option(c, c));
    const form = el('form', { class: 'inline-form new-tag' },
      el('label', { for: name.id }, 'New tag: '), name, ' ', color, ' ',
      el('button', { type: 'submit' }, 'Create and attach'), ' ',
      btn('Cancel', () => { form.remove(); render(); }),
      el('small', { class: 'muted' }, ' Tags are shared: everyone sees tag names and colors.'));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const n = name.value.trim();
      if (!n) return;
      try {
        const tag = await createTag(n, color.value || undefined);
        say(`Tag "${tag.name}" ready.`);
        await attach(tag.id);
      } catch (err) {
        attempt(() => { throw err; });
      }
    });
    host.appendChild(form);
    name.focus();
  }
}
