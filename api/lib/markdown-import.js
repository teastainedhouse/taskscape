/**
 * Parse the Markdown that GET /api/projects/:id/export.md produces
 * (docs/API.md §8) back into a project and its tasks. Pure: no database, no
 * config. The result is what the file says, with the line each task came
 * from; api/lib/import.js checks statuses and owners against the config and
 * creates the records. Comments are counted and left out: importing them
 * would fake who wrote them (an entry is signed by the caller, not by a name
 * in a file).
 *
 * The grammar is the export's: a `# name` heading, a Field/Value table, a raw
 * description block, `## Tasks` with a table (or `_No tasks._`), a `###`
 * section per task that has notes or comments, `## Comments` for the
 * project's comments, and a `---` footer. Older exports said "Guestbook"
 * where this one says "Comments"; both are accepted.
 */

/** @typedef {{url: string, label: string|null, line: number}} ParsedLink */
/** @typedef {{title: string, status: string|null, priority: string|null, owner_name: string|null, due_date: string|null, tags: string[], private: boolean|null, notes: string, links: ParsedLink[], line: number}} ParsedTask */
/**
 * @typedef {Object} ParsedExport
 * @property {{name: string, description: string, status: string|null, owner_name: string|null, private: boolean|null, tags: string[]}} project
 * @property {{name: number, status: number, owner: number, tags: number, description: number}} lines  1-based line of each project field (0 when absent)
 * @property {ParsedTask[]} tasks
 * @property {number} comments_skipped
 * @property {number} ambiguous_notes  tasks that share a title with another and had notes attached by order
 */

const LINE_BREAK = /\r\n?|\n/;
/** Longer than any field the API stores; a line past this is not an export. */
const MAX_LINE = 20_000;
const COMMENTS_HEADING = /^## (Comments|Guestbook)\s*$/;
const COMMENTS_LABEL = /^(Comments|Guestbook):\s*$/;
const COMMENT_SIGNATURE = /^\*\*.*\*\*, \d{4}-\d{2}-\d{2}:$/;
/** `- [label](<url>)` or `- <url>`, as the export writes a task's links. */
const LINK_LINE = /^- (?:\[((?:\\.|[^\\\]])*)\]\(<([^<>\s]+)>\)|<([^<>\s]+)>)\s*$/;
/** Undo the export's backslash escapes in a label. @param {string} s */
const unescapeText = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** An error naming the field and the line, never the value. */
export class ImportParseError extends Error {
  /** @param {string} field @param {string} problem @param {number} line  1-based */
  constructor(field, problem, line) {
    super(`${field}: ${problem} (line ${line})`);
    this.field = field;
    this.problem = problem;
    this.line = line;
  }
}

/**
 * Split a Markdown table row into cells, undoing the export's `\|` escape.
 * @param {string} row  starts and ends with `|`
 * @returns {string[]}
 */
export function splitCells(row) {
  const cells = [];
  let cur = '';
  const s = row.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  // a row `| a | b |` yields '', a, b, '' : drop the outer empties
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells.at(-1) === '') cells.pop();
  return cells;
}

/** @param {string} s */
const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
/** The export writes a title in a table cell and a heading; after pipes are undone both read as one line of single spaces. @param {string} s */
export const titleKey = (s) => String(s).replace(/\s+/g, ' ').trim();
/** @param {string} s */
const isSeparator = (s) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(s);
/** "yes"/"no" in any case, empty for unknown; anything else is a mistake the caller must hear about, not a silent "public". @param {string} v @param {string} field @param {number} line */
function yesNo(v, field, line) {
  const w = v.trim().toLowerCase();
  if (w === 'yes' || w === 'true') return true;
  if (w === 'no' || w === 'false' || w === '') return w === '' ? null : false;
  throw new ImportParseError(field, 'must be yes or no', line);
}
/** @param {string} v  the export joins tag names with ", " */
const tagList = (v) => v.split(',').map((t) => t.trim()).filter(Boolean);
/** @param {string} v */
const orNull = (v) => (v === '' ? null : v);

/**
 * @param {string} text
 * @returns {ParsedExport}
 * @throws {ImportParseError}
 */
export function parseProjectExport(text) {
  const lines = String(text ?? '').split(LINE_BREAK);
  const n = lines.length;
  let i = 0;
  const at = () => i + 1; // 1-based line for messages
  const long = lines.findIndex((l) => l.length > MAX_LINE);
  if (long >= 0) throw new ImportParseError('body', `a line is longer than ${MAX_LINE} characters`, long + 1);

  // # name
  while (i < n && lines[i].trim() === '') i++;
  if (i >= n || !/^# \S/.test(lines[i])) throw new ImportParseError('name', 'the file must start with a "# <project name>" heading', at());
  const name = lines[i].slice(2).trim();
  i++;

  const nameLine = at() - 1;

  // the Field | Value table
  while (i < n && lines[i].trim() === '') i++;
  const fields = new Map();
  const fieldLines = { name: nameLine, status: 0, owner: 0, tags: 0, private: 0, description: 0 };
  if (i < n && isTableRow(lines[i]) && splitCells(lines[i])[0] === 'Field') {
    i++;
    if (i < n && isSeparator(lines[i])) i++;
    while (i < n && isTableRow(lines[i])) {
      const [k, v = ''] = splitCells(lines[i]);
      fields.set(k, v);
      const key = k.toLowerCase();
      if (key in fieldLines) fieldLines[key] = at();
      i++;
    }
  }

  // description: everything up to the "## Tasks" heading. The description is raw text, so a second such
  // line (one written into a description by anyone who could edit the project) would make the file say two
  // different things; the import refuses it rather than guess, naming the line, and the person edits the file.
  const descStart = i;
  const headings = [];
  for (let j = i; j < n; j++) if (/^## Tasks\s*$/.test(lines[j])) headings.push(j);
  if (!headings.length) throw new ImportParseError('tasks', 'the file needs a "## Tasks" section', Math.max(1, lines.findLastIndex((l) => l.trim() !== '') + 1));
  if (headings.length > 1) {
    // before the first heading it can only be the description; after it, a task's notes
    const second = headings[1];
    const field = lines.slice(headings[0] + 1, second).some((l) => /^### \S/.test(l)) ? 'notes' : 'description';
    throw new ImportParseError(field, 'has a line that reads as the "## Tasks" heading; change or indent it', second + 1);
  }
  const tasksAt = headings[0];
  const descLines = trimBlank(lines.slice(descStart, tasksAt));
  fieldLines.description = descLines.length ? lines.indexOf(descLines[0], descStart) + 1 : 0;
  const description = descLines.join('\n');
  i = tasksAt + 1;

  // the task table
  /** @type {ParsedTask[]} */
  const tasks = [];
  while (i < n && lines[i].trim() === '') i++;
  if (i < n && /^_No tasks\._\s*$/.test(lines[i])) {
    i++;
  } else if (i < n && isTableRow(lines[i])) {
    const header = splitCells(lines[i]).map((h) => h.toLowerCase());
    const col = (want) => header.indexOf(want);
    if (col('title') < 0) throw new ImportParseError('tasks', 'the task table needs a Title column', at());
    i++;
    if (i < n && isSeparator(lines[i])) i++;
    while (i < n && isTableRow(lines[i])) {
      const cells = splitCells(lines[i]);
      const cell = (want) => (col(want) >= 0 ? cells[col(want)] ?? '' : '');
      const title = cell('title');
      if (!title) throw new ImportParseError('title', 'must not be empty', at());
      tasks.push({
        title, status: orNull(cell('status')), priority: orNull(cell('priority')), owner_name: orNull(cell('owner')), due_date: orNull(cell('due')),
        tags: tagList(cell('tags')), private: yesNo(cell('private'), 'private', at()), notes: '', links: [], line: at(),
      });
      i++;
    }
  }

  // ### sections (notes, then "Comments:"), ## Comments, --- footer. Notes are raw text, so a line inside
  // them is taken as structure only when it is what the export writes: a "### " heading naming a task
  // from the table that has no section yet, a "Comments:" label followed by a signature, or the footer.
  let commentsSkipped = 0;
  const titleKeys = tasks.map((t) => titleKey(t.title));
  const pending = new Map(); // title key -> how many tasks with that title still have no section
  for (const k of titleKeys) pending.set(k, (pending.get(k) ?? 0) + 1);
  const startsSection = (j) => /^### \S/.test(lines[j]) && (pending.get(titleKey(lines[j].slice(4))) ?? 0) > 0;
  const startsComments = (j) => {
    if (!COMMENTS_LABEL.test(lines[j]) && !COMMENTS_HEADING.test(lines[j])) return false;
    let k = j + 1;
    while (k < n && lines[k].trim() === '') k++;
    return k >= n || COMMENT_SIGNATURE.test(lines[k]) || isFooter(lines, k);
  };
  const endsSection = (j) => startsSection(j) || (COMMENTS_HEADING.test(lines[j]) && startsComments(j)) || isFooter(lines, j);
  /** notes per title key, in order of appearance */
  const notesFor = new Map();
  while (i < n) {
    const line = lines[i];
    if (startsSection(i)) {
      const key = titleKey(line.slice(4));
      pending.set(key, pending.get(key) - 1);
      i++;
      // structured blocks come first, each at most once and in this order, a label line followed by its items
      // ("_None._" for an empty one, written when the notes themselves start with a label line): "Links:"
      const block = (label, itemRe) => {
        let k = i;
        while (k < n && lines[k].trim() === '') k++;
        if (k >= n || !label.test(lines[k])) return null;
        let j = k + 1;
        while (j < n && lines[j].trim() === '') j++;
        if (j < n && /^_None\._\s*$/.test(lines[j])) { i = j + 1; return []; }
        if (j >= n || !itemRe.test(lines[j])) return null;
        const found = [];
        while (j < n && itemRe.test(lines[j])) { found.push({ m: lines[j].match(itemRe), line: j + 1 }); j++; }
        i = j;
        return found;
      };
      const linkList = (block(/^Links:\s*$/, LINK_LINE) ?? [])
        .map(({ m, line: at }) => ({ url: m[2] ?? m[3], label: m[1] === undefined ? null : unescapeText(m[1]), line: at }));
      const body = [];
      while (i < n && !endsSection(i)) {
        if (COMMENTS_LABEL.test(lines[i]) && startsComments(i)) { // the task's comments: count signatures, skip to the next section
          i++;
          while (i < n && !endsSection(i)) { if (COMMENT_SIGNATURE.test(lines[i])) commentsSkipped++; i++; }
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const list = notesFor.get(key) ?? [];
      list.push({ notes: trimBlank(body).join('\n'), links: linkList });
      notesFor.set(key, list);
      continue;
    }
    if (COMMENTS_HEADING.test(line) && startsComments(i)) {
      i++;
      while (i < n && !isFooter(lines, i)) { if (COMMENT_SIGNATURE.test(lines[i])) commentsSkipped++; i++; }
      continue;
    }
    if (isFooter(lines, i)) break;
    if (line.trim() !== '') throw new ImportParseError('tasks', 'unexpected text after the task table', at());
    i++;
  }

  // attach notes to tasks by title, in order among tasks that share a title (the export writes a section only
  // for a task with notes or comments, so two tasks with one title and notes on only one cannot be told apart;
  // the caller is told how many were attached by order)
  const used = new Map();
  let ambiguous = 0;
  for (const t of tasks) {
    const key = titleKey(t.title);
    const list = notesFor.get(key);
    if (!list) continue;
    const k = used.get(key) ?? 0;
    if (k < list.length) { t.notes = list[k].notes; t.links = list[k].links; used.set(key, k + 1); }
    if (pending.get(key) !== 0 || titleKeys.filter((x) => x === key).length > list.length) ambiguous++;
  }

  return {
    project: {
      name, description,
      status: orNull(fields.get('Status') ?? ''),
      owner_name: orNull(fields.get('Owner') ?? ''),
      private: yesNo(fields.get('Private') ?? '', 'private', fieldLines.private || nameLine),
      tags: tagList(fields.get('Tags') ?? ''),
    },
    lines: fieldLines,
    tasks,
    comments_skipped: commentsSkipped,
    ambiguous_notes: ambiguous,
  };
}

/** The export's footer: `---` followed by "Exported from". @param {string[]} lines @param {number} i */
function isFooter(lines, i) {
  if (!/^---\s*$/.test(lines[i])) return false;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    return /^Exported from /.test(lines[j]);
  }
  return true; // a trailing rule with nothing after it
}

/** Drop blank lines at both ends. @param {string[]} list */
function trimBlank(list) {
  let a = 0;
  let b = list.length;
  while (a < b && list[a].trim() === '') a++;
  while (b > a && list[b - 1].trim() === '') b--;
  return list.slice(a, b);
}

