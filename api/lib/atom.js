// atom.js — the What's New feed as Atom (RFC 4287), pure: no database, no
// config. One escaping function, xmlText(), for every piece of text and every
// attribute value: it escapes & < > " ' and drops the characters XML 1.0 does
// not allow at all (most control characters, lone surrogates, U+FFFE/FFFF),
// which no escape can carry. Entries are plain text (type="text"), so a
// reader never renders anyone's words as markup.

/**
 * Text or an attribute value, safe anywhere in an XML 1.0 document.
 * @param {unknown} v
 */
export function xmlText(v) {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Field names as the feed says them. */
const FIELD_WORDS = {
  title: 'title', name: 'name', status: 'status', priority: 'priority', owner_id: 'owner', due_date: 'due date', private: 'privacy',
  description: 'description', notes: 'notes', project_id: 'project', tags: 'tags', recurrence: 'repeats',
};

/** @param {unknown} v */
const show = (v) => (v == null || v === '' ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * One activity entry in words, for the feed: who did what to which item (plain text; escaped by the caller).
 * @param {any} a  an entry from the activity repo (already filtered by visibility)
 */
export function describeEntry(a) {
  const type = a.item_type;
  const title = a.item_title ? `"${a.item_title}"` : `(${type} no longer visible)`;
  const ch = a.changes ?? {};
  if (type === 'comment') {
    const on = ch.on?.type ?? 'item';
    return { create: `commented on ${on} ${title}`, trash: `took back a comment on ${on} ${title}`, restore: `restored a comment on ${on} ${title}` }[a.action]
      ?? `${a.action} a comment on ${on} ${title}`;
  }
  if (a.action === 'create') return `created ${type} ${title}`;
  if (a.action === 'trash') return `moved ${type} ${title} to the trash`;
  if (a.action === 'restore') return `restored ${type} ${title}`;
  if (a.action !== 'update') return `${a.action} ${type} ${title}`;
  const parts = [];
  for (const [field, d] of Object.entries(ch)) {
    if (field === 'owner_name' && ch.owner_id) continue;
    if (field === 'private') parts.push(d?.to ? 'made it private' : 'made it public');
    else if (field === 'owner_id') parts.push(`reassigned it to ${show(ch.owner_name?.to ?? d?.to)}`);
    else if (field === 'title' || field === 'name') parts.push(`renamed it to "${show(d?.to)}"`);
    else if (field === 'description' || field === 'notes') parts.push(`edited the ${field}`);
    else if (field === 'project_id') parts.push('moved it to another project');
    else if (field === 'link') parts.push(!d?.from ? 'added a link' : !d?.to ? 'removed a link' : 'changed a link');
    else if (field === 'checklist_item') parts.push(!d?.from ? `added the checklist item "${show(d?.to?.text)}"` : !d?.to ? `removed the checklist item "${show(d?.from?.text)}"` : `${d.to.done && !d.from.done ? 'ticked' : !d.to.done && d.from.done ? 'unticked' : 'changed'} "${show(d.to.text)}"`);
    else if (field === 'link_moved' || field === 'checklist_moved') parts.push('reordered');
    else if (field === 'recurred_to') parts.push('it repeats, so the next one was created');
    else parts.push(`${FIELD_WORDS[field] ?? field}: ${show(d?.from)} → ${show(d?.to)}`);
  }
  return `changed ${type} ${title}${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

/**
 * The feed.
 * @param {{title: string, id: string, self: string, base: string, updated: string}} feed  `id` a stable urn; `self` the feed's own URL
 * @param {any[]} entries  activity entries, newest first
 * @returns {string}
 */
export function renderAtom(feed, entries) {
  const link = (a) => {
    const target = a.item_type === 'comment' ? a.changes?.on : { type: a.item_type, id: a.item_id };
    if (target?.type === 'task') return `${feed.base}/task.html?id=${encodeURIComponent(target.id)}`;
    if (target?.type === 'project') return `${feed.base}/project.html?id=${encodeURIComponent(target.id)}`;
    return `${feed.base}/whats-new.html`;
  };
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title type="text">${xmlText(feed.title)}</title>`,
    `  <id>${xmlText(feed.id)}</id>`,
    `  <updated>${xmlText(entries[0]?.created_at ?? feed.updated)}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlText(feed.self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlText(`${feed.base}/whats-new.html`)}"/>`,
    '  <generator>Taskscape</generator>'];
  for (const a of entries) {
    const who = a.actor_name || 'Someone';
    const what = describeEntry(a);
    out.push('  <entry>',
      `    <id>urn:uuid:${xmlText(a.id)}</id>`,
      `    <title type="text">${xmlText(`${who} ${what}`)}</title>`,
      `    <updated>${xmlText(a.created_at)}</updated>`,
      `    <author><name>${xmlText(who)}</name></author>`,
      `    <link rel="alternate" type="text/html" href="${xmlText(link(a))}"/>`,
      `    <content type="text">${xmlText(`${who}${a.via === 'mcp' ? ' (through Claude)' : ''} ${what}.`)}</content>`,
      '  </entry>');
  }
  out.push('</feed>', '');
  return out.join('\n');
}
