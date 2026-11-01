/**
 * Markdown export. The export is for humans and is never rendered by
 * Taskscape, so description and notes are emitted raw; table cells and
 * headings are kept on one line with pipes escaped. Guestbook comments are
 * other people's words on the item, so they stay inside quote blocks and
 * their authors' names are escaped. A bare \r counts as a line break, as it
 * does in CommonMark.
 */

const LINE_BREAK = /\r\n?|\n/;

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
 * defining links for the notes around it.
 * @param {string} text @returns {string[]}
 */
function mdQuote(text) {
  return String(text).trimEnd().split(LINE_BREAK).map((l) => (l ? `> ${l.replace(/\[/g, '\\[')}` : '>'));
}

/** @param {Array<{author_name: string, created_at: string, body: string}>} list @returns {string[]} */
function guestbookLines(list) {
  const out = [];
  for (const c of list) out.push(`**${mdText(c.author_name)}**, ${c.created_at.slice(0, 10)}:`, '', ...mdQuote(c.body), '');
  return out;
}

/**
 * @param {object} project
 * @param {object[]} tasks  already filtered to what the caller may see
 * @param {{userName: string, date: string}} meta
 * @param {{project?: object[], tasks?: Map<string, object[]>}} [guestbook]  live comments the caller may see, oldest first
 * @returns {string}
 */
export function renderProjectExport(project, tasks, meta, guestbook = {}) {
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
    lines.push('| Title | Status | Owner | Due | Tags | Private |', '| --- | --- | --- | --- | --- | --- |');
    for (const t of tasks) {
      lines.push(`| ${mdCell(t.title)} | ${mdCell(t.status)} | ${mdCell(t.owner_name)} | ${t.due_date ?? ''} | ${mdCell(names(t.tags))} | ${yesno(t.private)} |`);
    }
    lines.push('');
    for (const t of tasks) {
      const comments = guestbook.tasks?.get(t.id) ?? [];
      if (!t.notes && !comments.length) continue;
      lines.push(`### ${mdInline(t.title)}`, '');
      if (t.notes) lines.push(t.notes.trimEnd(), '');
      if (comments.length) lines.push('Guestbook:', '', ...guestbookLines(comments));
    }
  }
  if (guestbook.project?.length) lines.push('## Guestbook', '', ...guestbookLines(guestbook.project));
  lines.push('---', `Exported from Taskscape on ${meta.date} by ${mdText(meta.userName)}.`, '');
  return lines.join('\n');
}
