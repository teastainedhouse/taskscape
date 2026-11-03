/**
 * Markdown export. The export is for humans and is never rendered by
 * Taskscape, so description and notes are emitted raw; table cells and
 * headings are kept on one line with pipes escaped. Comments are
 * other people's words on the item, so they stay inside quote blocks and
 * their authors' names are escaped. A bare \r counts as a line break, as it
 * does in CommonMark.
 */

const LINE_BREAK = /\r\n?|\n/;
/** The label lines of a task section's structured blocks (the import reads them before the notes). */
export const BLOCK_LABEL = /^(Links|Checklist):\s*$/;

/** @param {unknown} v @returns {string} one-line table cell */
export function mdCell(v) {
  return String(v ?? '').replace(/\r\n?|\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** @param {unknown} v @returns {string} one-line heading text */
export function mdInline(v) {
  return String(v ?? '').replace(/\s*(?:\r\n?|\n)\s*/g, ' ').trim();
}

/** @param {unknown} v @returns {string} one line with Markdown punctuation escaped, so a name cannot add emphasis or a link */
export function mdText(v) {
  return mdInline(v).replace(/[\\`*_[\]()<>#!|~]/g, '\\$&');
}

/** @param {string} s @returns {string} ASCII slug for a filename */
export function slug(s) {
  const out = String(s).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'project';
}

/**
 * The text as a quote block, so no line can start a heading. Every "[" is
 * escaped: a link reference definition inside a quote (or a quote nested in
 * it) would apply to the whole document, and a comment has no business
 * defining links for the notes around it. "<" and "&" are escaped too, so a
 * viewer that renders HTML shows a comment's tags and autolinks as text.
 * @param {string} text @returns {string[]}
 */
function mdQuote(text) {
  return String(text).trimEnd().split(LINE_BREAK).map((l) => (l ? `> ${l.replace(/[[<&]/g, '\\$&')}` : '>'));
}

/**
 * A task's links as list items: `- [label](<url>)`, or `- <url>` without a label. The URL is stored as the URL
 * parser writes it, so it holds no space, "<" or ">" and fits the angle brackets; the label is escaped as text.
 * @param {Array<{url: string, label: string|null}>} list @returns {string[]}
 */
function linkLines(list) {
  return list.map((l) => (l.label ? `- [${mdText(l.label)}](<${l.url}>)` : `- <${l.url}>`));
}

/** A task's checklist as task-list items, `- [ ] text` or `- [x] text`, the text escaped as Markdown text. @param {Array<{text: string, done: boolean}>} list */
function checklistLines(list) {
  return list.map((c) => `- [${c.done ? 'x' : ' '}] ${mdText(c.text)}`);
}

/** @param {Array<{author_name: string, created_at: string, body: string}>} list @returns {string[]} */
function commentLines(list) {
  const out = [];
  for (const c of list) out.push(`**${mdText(c.author_name)}**, ${c.created_at.slice(0, 10)}:`, '', ...mdQuote(c.body), '');
  return out;
}

/**
 * @param {object} project
 * @param {object[]} tasks  already filtered to what the caller may see
 * @param {{userName: string, date: string}} meta
 * @param {{project?: object[], tasks?: Map<string, object[]>}} [comments]  live comments the caller may see, oldest first
 * @returns {string}
 */
export function renderProjectExport(project, tasks, meta, comments = {}) {
  const yesno = (b) => (b ? 'yes' : 'no');
  const names = (tags) => tags.map((t) => t.name).join(', ');
  const lines = [
    `# ${mdInline(project.name)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${mdCell(project.status)} |`,
    `| Owner | ${mdCell(project.owner_name)} |`,
    `| Private | ${yesno(project.private)} |`,
    `| Hits | ${project.hit_count} |`,
    `| Tags | ${mdCell(names(project.tags))} |`,
    `| Created | ${project.created_at.slice(0, 10)} |`,
    `| Updated | ${project.updated_at.slice(0, 10)} |`,
    '',
  ];
  if (project.description) lines.push(project.description.trimEnd(), '');
  lines.push('## Tasks', '');
  if (tasks.length === 0) {
    lines.push('_No tasks._', '');
  } else {
    lines.push('| Title | Status | Priority | Owner | Due | Repeats | Tags | Private |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const t of tasks) {
      // a task that already made its next copy has handed its series on: Repeats only on the one still carrying it, so
      // an import of this file starts one series, not one per closed predecessor
      lines.push(`| ${mdCell(t.title)} | ${mdCell(t.status)} | ${mdCell(t.priority)} | ${mdCell(t.owner_name)} | ${t.due_date ?? ''} | ${mdCell(t.recurred_to ? null : t.recurrence)} | ${mdCell(names(t.tags))} | ${yesno(t.private)} |`);
    }
    lines.push('');
    for (const t of tasks) {
      const list = comments.tasks?.get(t.id) ?? [];
      const links = t.links ?? [];
      const items = t.checklist ?? [];
      if (!t.notes && !list.length && !links.length && !items.length) continue;
      lines.push(`### ${mdInline(t.title)}`, '');
      // structured blocks first, then the raw notes, so notes can never end a block. Notes that themselves start with
      // a block's label line get every block written, empty ones as "_None._", so the import reads them as notes.
      const firstNotesLine = (t.notes ?? '').split(LINE_BREAK).find((l) => l.trim() !== '') ?? '';
      const all = BLOCK_LABEL.test(firstNotesLine);
      if (links.length || all) lines.push('Links:', '', ...(links.length ? linkLines(links) : ['_None._']), '');
      if (items.length || all) lines.push('Checklist:', '', ...(items.length ? checklistLines(items) : ['_None._']), '');
      if (t.notes) lines.push(t.notes.trimEnd(), '');
      if (list.length) lines.push('Comments:', '', ...commentLines(list));
    }
  }
  if (comments.project?.length) lines.push('## Comments', '', ...commentLines(comments.project));
  lines.push('---', `Exported from Taskscape on ${meta.date} by ${mdText(meta.userName)}.`, '');
  return lines.join('\n');
}
