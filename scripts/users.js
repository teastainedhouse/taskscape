// Manage users for the built-in password provider (auth.provider = "password").
// Usage: npm run users -- add <id> --name "<name>" [--email <e>] [--groups a,b] [--claim-existing]
//        npm run users -- passwd <id>     new password; ends that user's sessions and revokes their MCP tokens and feed links
//        npm run users -- disable <id>    no sign-in; ends sessions, revokes MCP tokens and feed links (also for an id with no users row)
//        npm run users -- enable <id>
//        npm run users -- list
// Passwords are read from the terminal without echo (asked twice), or as one line
// from stdin when stdin is not a terminal. Never from the command line.
import { createInterface } from 'node:readline';
import { openDb } from '../api/lib/db/index.js';
import { ApiError } from '../api/lib/errors.js';
import { hashPassword, passwordProblem } from '../api/lib/auth/passwords.js';
import { validateNewUser, USER_ID_RE } from '../api/lib/validate.js';
import * as users from '../api/lib/repo/users.js';
import { nowIso } from '../api/lib/time.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }

const USAGE = `usage: npm run users -- <command>
  add <id> --name "<name>" [--email <email>] [--groups a,b] [--claim-existing]
  passwd <id>
  disable <id>
  enable <id>
  list`;

/** @param {string} msg */
function die(msg) {
  console.error(msg);
  process.exit(1);
}

const BOOLEAN_FLAGS = ['claim-existing'];

/** @param {string[]} args @returns {{positional: string[], flags: Record<string,string|true>}} */
function parseArgs(args) {
  const positional = [];
  /** @type {Record<string,string|true>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    if (BOOLEAN_FLAGS.includes(a.slice(2))) { flags[a.slice(2)] = true; continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) die(`${a} needs a value\n${USAGE}`);
    flags[a.slice(2)] = args[++i];
  }
  return { positional, flags };
}

/** One line typed at the terminal, not echoed. */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The first line of a piped stdin. */
function readLine() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once('line', (line) => { done = true; rl.close(); resolve(line); });
    rl.once('close', () => { if (!done) resolve(''); });
  });
}

/** @returns {Promise<string>} a password that meets the rules */
async function askPassword() {
  if (!process.stdin.isTTY) {
    const p = await readLine();
    const problem = passwordProblem(p);
    if (problem) die(`password ${problem}`);
    return p;
  }
  for (;;) {
    const p = await readHidden('New password: ');
    const problem = passwordProblem(p);
    if (problem) { console.error(`password ${problem}; try again`); continue; }
    if ((await readHidden('Repeat it: ')) !== p) { console.error('the two entries differ; try again'); continue; }
    return p;
  }
}

/** @param {string|undefined} id */
function requireId(id) {
  if (!id || !USER_ID_RE.test(id)) die(`give a user id (a-z 0-9 . _ -, up to 64)\n${USAGE}`);
  return id;
}

const { positional: [command, id, ...extra], flags } = parseArgs(process.argv.slice(2));
if (!command) die(USAGE);
if (extra.length) die(`unexpected arguments\n${USAGE}`);
const known = { add: ['name', 'email', 'groups', 'claim-existing'] }[command] ?? [];
for (const f of Object.keys(flags)) if (!known.includes(f)) die(`unknown option --${f}\n${USAGE}`);

const url = process.env.TASKSCAPE_DATABASE_URL || 'sqlite:./data/dev.db';
const db = await openDb(url);
try {
  const now = nowIso();
  switch (command) {
    case 'add': {
      requireId(id);
      const groups = typeof flags.groups === 'string' ? flags.groups.split(',') : [];
      const u = validateNewUser({ id, name: flags.name, email: flags.email, groups });
      const claim = flags['claim-existing'] === true;
      if (await users.get(db, u.id)) die('a user with that id already exists');
      const footprint = await users.existingFootprint(db, u.id);
      const describe = (f) => `${f.projects} project(s), ${f.tasks} task(s), ${f.activity} activity entr(ies), ${f.tokens} MCP token(s) (${f.live_tokens} not revoked), ${f.feeds} feed link(s) (${f.live_feeds} not revoked), ${f.preferences} preference row(s)`;
      const inUse = footprint.projects + footprint.tasks + footprint.activity + footprint.tokens + footprint.preferences + footprint.feeds > 0;
      if (inUse && !claim) {
        die(`that id is already in use: ${describe(footprint)}.\nIf this account is that person, run again with --claim-existing.`);
      }
      const result = await users.create(db, u, await hashPassword(await askPassword()), now, { claimExisting: claim });
      if (result.status === 'exists') die('a user with that id already exists');
      if (result.status === 'in_use') die(`that id is already in use: ${describe(result.claimed)}; run again with --claim-existing`);
      console.log(`added ${result.user.id}`);
      if (claim) {
        console.log(`claimed ${describe(result.claimed)}`);
        if (result.claimed.live_tokens) console.log('those MCP tokens work again for this account; revoke them on the profile page or with `passwd` if unsure');
      }
      break;
    }
    case 'passwd': {
      requireId(id);
      if (!(await users.get(db, id))) die('no such user');
      const swept = await users.setPassword(db, id, await hashPassword(await askPassword()), now, { revokeTokens: true });
      if (!swept) die('no such user');
      console.log(`password changed for ${id}; ended ${swept.sessions} session(s), revoked ${swept.tokens} MCP token(s) and ${swept.feeds} feed link(s)`);
      break;
    }
    case 'disable': {
      const swept = await users.disable(db, requireId(id), now);
      const what = swept.found ? `disabled ${id}` : `no users row for ${id}; nothing to disable, swept anyway`;
      console.log(`${what}; ended ${swept.sessions} session(s), revoked ${swept.tokens} MCP token(s) and ${swept.feeds} feed link(s)`);
      break;
    }
    case 'enable': {
      if (!(await users.enable(db, requireId(id), now))) die('no such user');
      console.log(`enabled ${id}`);
      break;
    }
    case 'list': {
      if (id) die(USAGE);
      const rows = (await users.list(db, now)).map((u) => ({
        id: u.id, name: u.name, email: u.email ?? '', groups: u.groups.join(','),
        disabled: u.disabled_at ? u.disabled_at.slice(0, 10) : '', sessions: String(u.sessions),
      }));
      if (!rows.length) { console.log('no users yet; add one with: npm run users -- add <id> --name "<name>"'); break; }
      const cols = Object.keys(rows[0]);
      const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => r[c].length))]));
      const line = (r) => cols.map((c) => r[c].padEnd(width[c])).join('  ').trimEnd();
      console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
      for (const r of rows) console.log(line(r));
      break;
    }
    default:
      die(USAGE);
  }
} catch (err) {
  if (err instanceof ApiError && err.details?.fields) die(Object.entries(err.details.fields).map(([k, v]) => `${k} ${v}`).join('\n'));
  if (/no such table|does not exist/i.test(String(err?.message))) die('the users table is missing; run `npm run migrate` first');
  throw err;
} finally {
  await db.close();
}
