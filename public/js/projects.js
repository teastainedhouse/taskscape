// projects.js — the project list (index.html): sort, filter, search,
// new project, overdue line and marquee, What's New preview. Trashing a
// project happens on its own page.

import { boot, say, sayError } from './page.js';
import { get, post, api } from './api.js';
import { el, btn, option, clear, setChildren, padlock, projectLink, taskLink, tagChip, timeEl } from './dom.js';
import { refreshOverdue } from './overdue.js';
import { allTags } from './tags.js';
import { createPager } from './pager.js';
import { describeActivity } from './activity-words.js';
import { commentWords } from './guestbook.js';

/**
 * Columns of the project table. Add a column here ("add a field" recipe):
 * `sort` is one of the API's sort fields or null; `cell` builds the cell.
 */
const COLUMNS = [
  { key: 'name', label: 'Name', sort: 'name', cell: (p) => [p.private ? padlock() : null, projectLink(p.id, p.name)] },
  { key: 'status', label: 'Status', sort: 'status', cell: (p) => p.status },
  { key: 'owner', label: 'Owner', sort: 'owner_name', cell: (p) => p.owner_name },
  { key: 'tags', label: 'Tags', sort: null, cell: (p) => (p.tags ?? []).map((t) => tagChip(t)) },
  { key: 'updated', label: 'Updated', sort: 'updated_at', cell: (p) => timeEl(p.updated_at) },
];

const state = {
  sort: 'updated_at',
  dir: 'desc',
  status: '',
  owner: '',
  tag: '',
  projects: /** @type {any[]} */ ([]),
};

const { config, me } = await boot({ title: 'Projects' });

const table = document.getElementById('projects');
const thead = table.querySelector('thead');
const tbody = table.querySelector('tbody');
const projectPager = createPager({
  path: '/api/projects',
  button: document.getElementById('projects-more'),
  query: () => ({ sort: state.sort, dir: state.dir, status: state.status, owner: state.owner, tag: state.tag }),
  onPage: (items, first) => {
    if (first) state.projects = items; else state.projects.push(...items);
    renderRows();
    // Focus goes to the first new row, or to the last row when the last page came back empty.
    const target = first ? null : (items[0] ?? state.projects.at(-1));
    return target ? document.getElementById(`project-${target.id}`)?.querySelector('a') : null;
  },
  onError: (err) => sayError(err, 'Could not load projects'),
});

buildFilters();
buildHeader();
setupNewProject();
setupImport();
setupSearch();
await loadProjects();
loadOverdue();
loadPreview();

/** Status / owner / tag filters, data-driven from config and the API. */
async function buildFilters() {
  const host = document.getElementById('filters');
  const status = el('select', { id: 'f-status' }, option('', 'Any status'), config.statuses.project.map((s) => option(s)));
  const owner = el('select', { id: 'f-owner' }, option('', 'Anyone'), option('me', 'Me'));
  const tag = el('select', { id: 'f-tag' }, option('', 'Any tag'));
  setChildren(host, [
    el('div', { class: 'field' }, el('label', { for: 'f-status' }, 'Status'), status),
    el('div', { class: 'field' }, el('label', { for: 'f-owner' }, 'Owner'), owner),
    el('div', { class: 'field' }, el('label', { for: 'f-tag' }, 'Tag'), tag),
    el('div', { class: 'field' }, btn('Clear filters', () => { status.value = owner.value = tag.value = ''; apply(); })),
  ]);
  const apply = () => { state.status = status.value; state.owner = owner.value; state.tag = tag.value; loadProjects(); };
  for (const s of [status, owner, tag]) s.addEventListener('change', apply);
  try {
    const [people, tags] = await Promise.all([get('/api/people'), allTags()]);
    for (const p of people.items ?? []) if (p.id !== me.id) owner.appendChild(option(p.id, p.name));
    for (const t of tags) tag.appendChild(option(t.name));
  } catch (err) { sayError(err, 'Could not load filters'); }
}

/** Header row with sort buttons. */
function buildHeader() {
  const tr = el('tr');
  for (const c of COLUMNS) {
    const th = el('th', { scope: 'col' });
    if (c.sort) {
      const active = state.sort === c.sort;
      th.setAttribute('aria-sort', active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const b = btn(`${c.label}${active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}`, () => {
        if (state.sort === c.sort) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = c.sort; state.dir = ['name'].includes(c.sort) ? 'asc' : 'desc'; }
        buildHeader();
        loadProjects();
      }, { class: 'sort', 'aria-label': `Sort by ${c.label}` });
      th.appendChild(b);
    } else th.textContent = c.label;
    tr.appendChild(th);
  }
  setChildren(thead, [tr]);
}

/** Fetch the first page with the current sort and filters; "Load more" fetches the rest. */
async function loadProjects() {
  await projectPager.reload();
}

function renderRows() {
  clear(tbody);
  for (const p of state.projects) tbody.appendChild(row(p));
  document.getElementById('projects-empty').hidden = state.projects.length > 0;
}

/** One table row. @param {any} p */
function row(p) {
  const tr = el('tr', { id: `project-${p.id}` });
  for (const c of COLUMNS) tr.appendChild(el('td', { class: `col-${c.key}` }, c.cell(p)));
  return tr;
}

/** The "New project" form. */
function setupNewProject() {
  const form = document.getElementById('new-project');
  const status = document.getElementById('np-status');
  for (const s of config.statuses.project) status.appendChild(option(s, s, s === config.default_status.project));
  document.getElementById('np-private').checked = !!config.privacy?.default_private;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      name: document.getElementById('np-name').value.trim(),
      description: document.getElementById('np-description').value,
      status: status.value,
      private: document.getElementById('np-private').checked,
    };
    if (!body.name) return;
    try {
      const p = await post('/api/projects', body);
      form.reset();
      status.value = config.default_status.project;
      say(`Project "${p.name}" created.`);
      await loadProjects();
      document.getElementById(`project-${p.id}`)?.querySelector('a')?.focus();
    } catch (err) { sayError(err, 'Could not create the project'); }
  });
}

/**
 * Import from Markdown: a dry run first (nothing written), then one confirm
 * that creates the project and its tasks in one request, and opens the project.
 */
function setupImport() {
  const form = document.getElementById('import-form');
  const file = document.getElementById('import-file');
  const text = document.getElementById('import-text');
  const makePrivate = document.getElementById('import-private');
  const preview = document.getElementById('import-preview');
  const submit = form.querySelector('button[type="submit"]');

  /** Files over the API's body limit are refused here rather than uploaded and refused there. */
  const MAX_FILE_BYTES = Number(config.limits?.body_bytes) || 262144;
  /** The Markdown to send: the chosen file (which wins over pasted text, and says so), else the pasted text. */
  const markdown = async () => {
    const f = file.files?.[0];
    if (!f) return text.value;
    if (f.size > MAX_FILE_BYTES) throw new Error(`That file is too large to import; the limit is ${Math.floor(MAX_FILE_BYTES / 1024)} KB.`);
    if (text.value.trim()) say('Using the chosen file; the pasted text is ignored.');
    return f.text();
  };
  const send = (dryRun, md, priv) => api('POST', '/api/projects/import', { text: md, contentType: 'text/markdown; charset=utf-8',
    query: { dry_run: dryRun ? 'true' : undefined, private: priv ? 'true' : undefined } });
  // a preview describes one file and one setting: changing either throws it away
  for (const input of [file, text, makePrivate]) input.addEventListener('input', () => setChildren(preview, []));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      const md = await markdown();
      if (!md.trim()) { say('Choose a file or paste some Markdown first.', { error: true }); text.focus(); return; }
      const priv = makePrivate.checked;
      const plan = await send(true, md, priv);
      showPlan(plan, md, priv);
    } catch (err) { setChildren(preview, []); sayError(err, 'Could not read that Markdown'); } finally { submit.disabled = false; }
  });

  /** @param {any} plan  the dry-run answer @param {string} md @param {boolean} priv  the setting the plan was made with */
  function showPlan(plan, md, priv) {
    const n = plan.tasks.length;
    const confirmBtn = btn(`Import "${plan.project.name}" and ${n} task${n === 1 ? '' : 's'}`, async () => {
      confirmBtn.disabled = true;
      try {
        const made = await send(false, md, priv);
        say(`Imported "${made.project.name}" with ${made.tasks.length} task${made.tasks.length === 1 ? '' : 's'}. Opening it.`);
        location.href = `project.html?id=${encodeURIComponent(made.project.id)}`;
      } catch (err) { sayError(err, 'Could not import'); confirmBtn.disabled = false; }
    });
    const rows = plan.tasks.map((t) => el('li', null, t.private ? padlock() : null, t.title, ` — ${t.status}, ${t.owner_name}`, t.due_date ? `, due ${t.due_date}` : null,
      t.tags.length ? `, tags: ${t.tags.join(', ')}` : null, t.notes ? `, notes (${t.notes.length} characters)` : null, t.private ? ', private to you' : null));
    setChildren(preview, [
      el('h3', { tabindex: '-1', id: 'import-plan-h' }, 'What would be created'),
      el('p', null, plan.project.private ? padlock() : null, el('b', null, plan.project.name), ` — ${plan.project.status}, ${plan.project.owner_name}, ${plan.project.private ? 'private to you' : 'public'}`,
        plan.project.tags.length ? `, tags: ${plan.project.tags.join(', ')}` : null, plan.project.description ? `, description (${plan.project.description.length} characters)` : null),
      n ? el('ol', { class: 'import-tasks' }, rows) : el('p', { class: 'muted' }, 'No tasks.'),
      plan.notes.length ? el('ul', { class: 'import-notes' }, plan.notes.map((x) => el('li', null, x))) : null,
      el('p', null, confirmBtn, ' ', btn('Cancel', () => { setChildren(preview, []); text.focus(); })),
    ]);
    document.getElementById('import-plan-h').focus();
  }
}

/** Search box over /api/search (2+ characters). */
function setupSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-q');
  const results = document.getElementById('search-results');
  let timer = null;
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { clear(results); return; }
    try {
      const res = await get('/api/search', { q });
      renderSearch(res, q);
    } catch (err) { sayError(err, 'Search failed'); }
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); run(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  document.getElementById('search-clear').addEventListener('click', () => { input.value = ''; clear(results); input.focus(); });

  function renderSearch(res, q) {
    const projects = res.projects ?? [], tasks = res.tasks ?? [];
    if (!projects.length && !tasks.length) { setChildren(results, [el('p', null, `Nothing found for "${q}".`)]); return; }
    const out = [];
    if (projects.length) {
      out.push(el('h3', null, `Projects (${projects.length})`));
      out.push(el('ul', null, projects.map((p) => el('li', null, p.private ? padlock() : null, projectLink(p.id, p.name), ` — ${p.status}, ${p.owner_name}`))));
    }
    if (tasks.length) {
      out.push(el('h3', null, `Tasks (${tasks.length})`));
      out.push(el('ul', null, tasks.map((t) => el('li', null, t.private ? padlock() : null, taskLink(t.id, t.title),
        ` — ${t.status}, ${t.owner_name}, in `, projectLink(t.project_id, t.project_name)))));
    }
    setChildren(results, out);
  }
}

/** Overdue tasks across all visible projects: the static line, and the marquee. */
async function loadOverdue() {
  try {
    await refreshOverdue(config, {}, { showProject: true });
  } catch (err) { sayError(err, 'Could not check for overdue tasks'); }
}

/** Five latest activity entries. */
async function loadPreview() {
  const ul = document.getElementById('activity-preview');
  try {
    const res = await get('/api/activity', { limit: 5 });
    const items = res.items ?? [];
    if (!items.length) { setChildren(ul, [el('li', null, 'Nothing yet.')]); return; }
    const names = new Map(state.projects.map((p) => [p.id, p.name]));
    setChildren(ul, items.map((a) => {
      const d = describeActivity(a, { projectNames: names, words: commentWords(me.preferences.comments_label) });
      return el('li', null, timeEl(a.created_at), ' — ', el('b', null, a.actor_name), ` (${d.via}) `, d.what, d.link ? [' — ', d.link] : null);
    }));
  } catch (err) { setChildren(ul, [el('li', null, 'Could not load activity.')]); }
}
