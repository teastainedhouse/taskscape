// trash.js — trashed projects and tasks with Restore.

import { boot, say, attempt, sayError } from './page.js';
import { get, post, itemPath } from './api.js';
import { el, btn, clear, padlock, projectLink, taskLink, timeEl } from './dom.js';

const { me } = await boot({ title: 'Trash' });
const canEdit = !!me.can_edit;

const pBody = document.querySelector('#trash-projects tbody');
const tBody = document.querySelector('#trash-tasks tbody');

await load();

async function load() {
  let res;
  try { res = await get('/api/trash'); } catch (err) { sayError(err, 'Could not load the trash'); return; }
  clear(pBody); clear(tBody);
  for (const p of res.projects ?? []) pBody.appendChild(projectRow(p));
  for (const t of res.tasks ?? []) tBody.appendChild(taskRow(t));
  document.getElementById('trash-projects-empty').hidden = (res.projects ?? []).length > 0;
  document.getElementById('trash-tasks-empty').hidden = (res.tasks ?? []).length > 0;
}

/** @param {any} p */
function projectRow(p) {
  const tr = el('tr', { class: 'trashed' },
    el('td', null, p.private ? padlock() : null, projectLink(p.id, p.name)),
    el('td', null, p.status),
    el('td', null, p.owner_name),
    el('td', null, timeEl(p.deleted_at)));
  if (canEdit) tr.appendChild(el('td', { class: 'row-actions' }, btn('Restore', () => restore('project', p, tr), { 'aria-label': `Restore project ${p.name}` })));
  return tr;
}

/** @param {any} t */
function taskRow(t) {
  const tr = el('tr', { class: 'trashed' },
    el('td', null, t.private ? padlock() : null, taskLink(t.id, t.title)),
    el('td', null, projectLink(t.project_id, t.project_name)),
    el('td', null, t.status),
    el('td', null, t.owner_name),
    el('td', null, timeEl(t.deleted_at)));
  if (canEdit) tr.appendChild(el('td', { class: 'row-actions' }, btn('Restore', () => restore('task', t, tr), { 'aria-label': `Restore task ${t.title}` })));
  return tr;
}

/**
 * Restore with the version from the last read; on 409 the row is rebuilt
 * from the live record and the user is told to try again.
 * @param {'project'|'task'} type @param {any} item @param {HTMLTableRowElement} tr
 */
async function restore(type, item, tr) {
  const rec = await attempt(() => post(`${itemPath(type, item.id)}/restore`, { version: item.version }), (current) => {
    tr.replaceWith(type === 'project' ? projectRow(current) : taskRow(current));
  });
  if (rec) {
    say(`Restored ${type} "${type === 'project' ? rec.name : rec.title}".`);
    await load();
  }
}
