// Dev seed data. Goes through the repo layer with real principals, so the
// activity log is populated the way real use would populate it.
// Usage: npm run seed            (refuses to touch a non-empty database)
//        npm run seed -- --reset (SQLite: recreate the file; PostgreSQL: empty the tables)
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { loadConfig } from '../api/lib/config.js';
import { openDb } from '../api/lib/db/index.js';
import { ensureCatchAll } from '../api/lib/repo/projects.js';
import * as projects from '../api/lib/repo/projects.js';
import * as tasks from '../api/lib/repo/tasks.js';
import * as tags from '../api/lib/repo/tags.js';
import { daysFromNow } from '../api/lib/time.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }

const url = process.env.TASKSCAPE_DATABASE_URL || 'sqlite:./data/dev.db';
const reset = process.argv.includes('--reset');
const config = loadConfig();
const MIGRATIONS = path.resolve('migrations');

let db = await openDb(url);
await db.migrate(MIGRATIONS);

const { rows: [{ n }] } = await db.query("SELECT COUNT(*) AS n FROM projects WHERE id <> ?", [config.catch_all_project.id]);
if (Number(n) > 0) {
  if (!reset) {
    console.error('The database already has data. Pass --reset to replace it.');
    process.exit(1);
  }
  if (url.startsWith('sqlite:') && !url.includes(':memory:')) {
    await db.close();
    const file = url.replace(/^sqlite:/, '');
    for (const suffix of ['', '-wal', '-shm']) await unlink(file + suffix).catch(() => {});
    db = await openDb(url);
    await db.migrate(MIGRATIONS);
  } else {
    for (const table of ['activity', 'task_tags', 'project_tags', 'tasks', 'mcp_tokens', 'projects', 'tags']) {
      await db.query(`DELETE FROM ${table}`);
    }
  }
}
await ensureCatchAll(db, config);

const users = Object.fromEntries(config.auth.dev?.users?.map((u) => [u.id, u]) ?? []);
const ui = (id) => ({ ...(users[id] ?? { id, name: id }), via: 'ui', auth: 'dev' });
const mcp = (id, session) => ({ ...(users[id] ?? { id, name: id }), via: 'mcp', auth: 'token', session_id: session });
let clock = Date.now() - 14 * 86_400_000;
const tick = () => new Date((clock += 37 * 60_000)).toISOString(); // every write 37 minutes apart

const tag = {};
for (const name of ['web', 'ops', 'bug', 'q4']) tag[name] = (await tags.create(db, ui('alice'), { name }, config, tick())).tag;

const alice = ui('alice'); const bob = ui('bob'); const carol = ui('carol');
const P = {};
P.web = await projects.create(db, alice, { id: 'website-refresh', name: 'Website refresh', status: 'Active',
  description: 'Bring the company site into 1997.', tag_ids: [tag.web.id, tag.q4.id] }, config, tick());
P.office = await projects.create(db, bob, { id: 'office-move', name: 'Office move', status: 'Planned',
  description: 'New floor, same chairs.', tag_ids: [tag.ops.id] }, config, tick());
P.reorg = await projects.create(db, carol, { id: 'reorg-notes', name: 'Reorg notes', status: 'Active',
  description: 'Working notes. Will go private once drafted.' }, config, tick());
P.party = await projects.create(db, alice, { id: 'holiday-party-1997', name: 'Holiday party 1997', status: 'Planned' }, config, tick());

const T = {};
T.gifs = await tasks.create(db, alice, { id: 'fix-broken-gifs', project_id: P.web.id, title: 'Fix broken GIFs', due_date: daysFromNow(-1), tag_ids: [tag.bug.id],
  notes: 'The dancing baby is a broken image on the home page.' }, config, tick());
T.copy = await tasks.create(db, bob, { id: 'write-homepage-copy', project_id: P.web.id, title: 'Write homepage copy', status: 'To do', due_date: daysFromNow(7) }, config, tick());
T.midi = await tasks.create(db, carol, { id: 'choose-midi-track', project_id: P.web.id, title: 'Choose MIDI background track', status: 'Done', due_date: daysFromNow(-3) }, config, tick());
T.checklist = await tasks.create(db, alice, { id: 'alice-launch-checklist', project_id: P.web.id, title: "Alice's launch checklist", private: true,
  notes: 'Only I can see this. Do not forget the <blink> tag.' }, config, tick());
T.chairs = await tasks.create(db, bob, { id: 'count-chairs', project_id: P.office.id, title: 'Count chairs', status: 'Blocked', due_date: daysFromNow(3), tag_ids: [tag.ops.id] }, config, tick());
T.lease = await tasks.create(db, bob, { id: 'negotiate-lease', project_id: P.office.id, title: 'Negotiate lease', private: true, notes: 'Numbers are not for sharing yet.' }, config, tick());
T.orgchart = await tasks.create(db, carol, { id: 'draft-org-chart', project_id: P.reorg.id, title: 'Draft org chart', status: 'Doing', due_date: daysFromNow(10) }, config, tick());
T.comp = await tasks.create(db, alice, { id: 'review-comp-bands', project_id: P.reorg.id, title: 'Review comp bands', due_date: daysFromNow(2) }, config, tick());

// carol makes Reorg notes private: alice's task moves to the catch-all and alice sees why in What's New
const flipped = await projects.update(db, carol, P.reorg.id, { version: P.reorg.version, private: true }, config, tick());

// a few more edits so the feed shows every via and action
await tasks.update(db, bob, T.copy.id, { version: T.copy.version, status: 'Doing' }, config, tick());
await tasks.update(db, mcp('carol', 'seed-session-0001'), T.orgchart.id, { version: T.orgchart.version, notes: 'Boxes first, names later.' }, config, tick());
const trashed = await tasks.trash(db, alice, T.midi.id, T.midi.version, tick());
await tasks.restore(db, alice, T.midi.id, trashed.version, tick());

for (const [id, hits] of [[P.web.id, 1337], [P.office.id, 42], [P.reorg.id, 7], [P.party.id, 0], [config.catch_all_project.id, 3]]) {
  await db.query('UPDATE projects SET hit_count = ? WHERE id = ?', [hits, id]);
}

console.log(`seeded ${url}`);
console.log(`  projects: ${Object.keys(P).length + 1} (incl. ${config.catch_all_project.name}), tasks: ${Object.keys(T).length}, tags: ${Object.keys(tag).length}`);
console.log(`  "${P.reorg.name}" went private; moved ${flipped.moved_tasks} task(s) to ${config.catch_all_project.name}`);
console.log(`  dev users: ${Object.keys(users).join(', ')}`);
await db.close();
