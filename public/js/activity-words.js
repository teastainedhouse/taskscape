// activity-words.js — turn an activity entry into words and a link.
// Values inside entries (titles, names, notes) are rendered as text only.

import { el, projectLink } from './dom.js';

/** Labels for the `via` field. */
const VIA = { ui: 'UI', mcp: 'Claude' };

/** Human labels for changed fields; anything else uses the field name. */
const FIELD_LABELS = {
  title: 'title', name: 'name', status: 'status', owner_id: 'owner', owner_name: 'owner',
  due_date: 'due date', private: 'privacy', description: 'description', notes: 'notes',
  project_id: 'project', tags: 'tags', color: 'color',
};

/** @param {any} v */
const show = (v) => (v == null || v === '' ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v));

/**
 * Describe an entry.
 * @param {any} a  activity entry from /api/activity
 * @param {{projectNames?: Map<string, string>}} [ctx]  known project names, for moves
 * @returns {{via: string, what: string, link: HTMLElement|null}}
 */
export function describeActivity(a, ctx = {}) {
  const via = VIA[a.via] ?? String(a.via ?? '');
  const type = a.item_type;
  const title = a.item_title ?? '';
  const quoted = title ? `"${title}"` : `(${type} no longer visible)`;
  const projectName = (id) => ctx.projectNames?.get(id) ?? null;

  let what;
  switch (a.action) {
    case 'create':
      what = `created ${type} ${quoted}`;
      if (type === 'task' && a.changes?.project_id?.to) {
        const pn = projectName(a.changes.project_id.to);
        if (pn) what += ` in ${pn}`;
      }
      break;
    case 'trash': what = `moved ${type} ${quoted} to the trash`; break;
    case 'restore': what = `restored ${type} ${quoted}`; break;
    case 'update': {
      const phrases = [];
      const ch = a.changes ?? {};
      for (const [field, d] of Object.entries(ch)) {
        if (field === 'owner_name' && ch.owner_id) continue;
        const from = d?.from, to = d?.to;
        switch (field) {
          case 'private': phrases.push(to ? 'made it private' : 'made it public'); break;
          case 'project_id': {
            const toName = projectName(to), fromName = projectName(from);
            phrases.push(`moved it${fromName ? ` from ${fromName}` : ''} to ${toName ?? 'another project'}`);
            break;
          }
          case 'owner_id': phrases.push(`reassigned it to ${show(ch.owner_name?.to ?? to)}`); break;
          case 'title': case 'name': phrases.push(`renamed it to "${show(to)}"`); break;
          case 'description': case 'notes': phrases.push(`edited the ${field}`); break;
          case 'tags': phrases.push(`tags: ${show(from)} → ${show(to)}`); break;
          default: phrases.push(`${FIELD_LABELS[field] ?? field}: ${show(from)} → ${show(to)}`);
        }
      }
      what = `changed ${type} ${quoted}: ${phrases.join('; ') || 'no visible fields'}`;
      break;
    }
    default: what = `${a.action} ${type} ${quoted}`;
  }

  let link = null;
  if (type === 'project' && a.item_id) link = projectLink(a.item_id, 'Open project');
  else if (type === 'task' && a.project_id) link = projectLink(a.project_id, 'Open task', `task-${a.item_id}`);
  return { via, what, link };
}

/** A span styled by via. @param {string} via */
export function viaBadge(via) {
  return el('span', { class: via === 'mcp' ? 'via-mcp' : 'via-ui' }, VIA[via] ?? String(via ?? ''));
}
