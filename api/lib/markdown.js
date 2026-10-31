/**
 * Markdown export. The export is for humans and is never rendered by
 * Taskscape, so description and notes are emitted raw; table cells and
 * headings are kept on one line with pipes escaped.
 */

/** @param {unknown} v @returns {string} one-line table cell */
export function mdCell(v) {
  return String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** @param {unknown} v @returns {string} one-line heading text */
export function mdInline(v) {
  return String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** @param {string} s @returns {string} ASCII slug for a filename */
export function slug(s) {
  const out = String(s).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'project';
}

/**
 * @param {object} project
 * @param {object[]} tasks  already filtered to what the caller may see
 * @param {{userName: string, date: string}} meta
 * @returns {string}
 */
export function renderProjectExport(project, tasks, meta) {
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
      if (!t.notes) continue;
      lines.push(`### ${mdInline(t.title)}`, '', t.notes.trimEnd(), '');
    }
  }
  lines.push('---', `Exported from Taskscape on ${meta.date} by ${mdInline(meta.userName)}.`, '');
  return lines.join('\n');
}
