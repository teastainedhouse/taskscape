// atom.js — the What's New feed as Atom (RFC 4287), pure: no database, no
// config. One escaping function, xmlText(), for every piece of text and every
// attribute value: it escapes & < > " ' and drops what XML 1.0 cannot carry
// (most control characters, lone surrogates, U+FFFE/FFFF) along with DEL and
// the C1 controls, as the calendar does, and the bidi embedding, override and
// isolate controls (U+202A-202E, U+2066-2069), so one title cannot reorder the
// words around it. Entries are plain text (type="text"), so a reader never
// renders anyone's words as markup. The words follow public/js/activity-words.js,
// minus project names (a feed has no list of them), and an unlabelled link is
// named by its host, not its full URL (task links are often shared-document
// URLs with a key in them, and a feed is easily pasted into a hosted reader).

/**
 * Text or an attribute value, safe anywhere in an XML 1.0 document.
 * @param {unknown} v
 */
export function xmlText(v) {
  return String(v ?? '')
    .replace(/[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u2029\u202f-\u2065\u206a-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Field names as the feed says them. */
const FIELD_WORDS = {
  title: 'title', name: 'name', status: 'status', priority: 'priority', recurrence: 'repeats', owner_id: 'owner', owner_name: 'owner',
  due_date: 'due date', private: 'privacy', description: 'description', notes: 'notes', project_id: 'project', tags: 'tags', color: 'color',
};

/** @param {unknown} v */
const show = (v) => (v == null || v === '' ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A link as the feed names it: its label, else its URL's host. @param {any} l */
function linkName(l) {
  if (l?.label) return `"${String(l.label)}"`;
  try { return `on ${new URL(String(l?.url)).host}`; } catch { return 'a link'; }
}

/**
 * One activity entry in words: what was done to which item (plain text; escaped by the caller).
 * @param {any} a  an entry from the activity repo (already filtered by visibility)
 */
export function describeEntry(a) {
  const type = a.item_type;
  const title = a.item_title ? `"${a.item_title}"` : `(${type} no longer visible)`;
  const ch = a.changes ?? {};
  if (type === 'comment') {
    // the entry names the parent, never the text
    const where = a.item_title ? `${ch.on?.type ?? 'item'} "${a.item_title}"` : `(${ch.on?.type ?? 'item'} no longer visible)`;
    return { create: `commented on ${where}`, trash: `trashed a comment on ${where}`, restore: `restored a comment on ${where}` }[a.action]
      ?? `${a.action} a comment on ${where}`;
  }
  if (a.action === 'create') return `created ${type} ${title}`;
  if (a.action === 'trash') return `moved ${type} ${title} to the trash`;
  if (a.action === 'restore') return `restored ${type} ${title}`;
  if (a.action !== 'update') return `${a.action} ${type} ${title}`;
  const parts = [];
  for (const [field, d] of Object.entries(ch)) {
    if (field === 'owner_name' && ch.owner_id) continue;
    const from = d?.from, to = d?.to;
    switch (field) {
      case 'private': parts.push(to ? 'made it private' : 'made it public'); break;
      case 'project_id': parts.push('moved it to another project'); break;
      case 'owner_id': parts.push(`reassigned it to ${show(ch.owner_name?.to ?? to)}`); break;
      case 'title': case 'name': parts.push(`renamed it to "${show(to)}"`); break;
      case 'description': case 'notes': parts.push(`edited the ${field}`); break;
      case 'link': parts.push(!from ? `added the link ${linkName(to)}` : !to ? `removed the link ${linkName(from)}` : `changed the link ${linkName(from)} to ${linkName(to)}`); break;
      case 'checklist_item': parts.push(!from ? `added the checklist item "${show(to?.text)}"` : !to ? `removed the checklist item "${show(from?.text)}"`
        : from.text !== to.text ? `renamed the checklist item "${show(from.text)}" to "${show(to.text)}"${from.done !== to.done ? (to.done ? ' and ticked it' : ' and unticked it') : ''}`
          : `${to.done ? 'ticked' : 'unticked'} "${show(to.text)}"`); break;
      case 'checklist_moved': parts.push(`moved the checklist item "${show(d?.item?.text)}" ${Number(to) < Number(from) ? 'up' : 'down'}`); break;
      case 'link_moved': parts.push(`moved the link ${linkName(d?.link)} ${Number(to) < Number(from) ? 'up' : 'down'}`); break;
      // only when the reader can see the copy (activity.list() nulls a hidden one)
      case 'recurred_to': if (to) parts.push('it repeats, so the next one was created'); break;
      default: parts.push(`${FIELD_WORDS[field] ?? field}: ${show(from)} → ${show(to)}`);
    }
  }
  return `changed ${type} ${title}: ${parts.join('; ') || 'no visible fields'}`;
}

/**
 * The page an entry is about: its task or project (a comment's parent), else What's New (tags).
 * @param {any} a @param {string} base
 */
export function entryLink(a, base) {
  const target = a.item_type === 'comment' ? a.changes?.on : { type: a.item_type, id: a.item_id };
  if (target?.id && target.type === 'task') return `${base}/task.html?id=${encodeURIComponent(target.id)}`;
  if (target?.id && target.type === 'project') return `${base}/project.html?id=${encodeURIComponent(target.id)}`;
  return `${base}/whats-new.html`;
}

/**
 * The feed.
 * @param {{title: string, author: string, id: string, self: string, base: string, updated: string}} feed  `id` a stable urn;
 *   `author` the feed's own author (the site), so a feed with no entries still has one; `self` the feed's own URL;
 *   `updated` used when there are no entries
 * @param {any[]} entries  activity entries, newest first
 * @returns {string}
 */
export function renderAtom(feed, entries) {
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title type="text">${xmlText(feed.title)}</title>`,
    `  <id>${xmlText(feed.id)}</id>`,
    `  <updated>${xmlText(entries[0]?.created_at ?? feed.updated)}</updated>`,
    `  <author><name>${xmlText(feed.author)}</name></author>`,
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
      `    <link rel="alternate" type="text/html" href="${xmlText(entryLink(a, feed.base))}"/>`,
      `    <content type="text">${xmlText(`${who}${a.via === 'mcp' ? ' (through Claude)' : ''} ${what}.`)}</content>`,
      '  </entry>');
  }
  out.push('</feed>', '');
  return out.join('\n');
}
