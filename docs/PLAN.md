# Taskscape — Decisions

What Taskscape decided and why. This file holds decisions only; other facts live in one place each:

| For | Read |
| --- | --- |
| The original pitch (historical, not kept current) | [ONE-PAGER.md](ONE-PAGER.md) |
| The HTTP contract | [API.md](API.md) |
| Where the code is, house rules, recipes | [CLAUDE.md](../CLAUDE.md) (the only code map) |
| Running, deploying, identity setup, backup, MCP setup | [README.md](../README.md) |
| The schema | `migrations/*.sql` |
| The MCP tools | `mcp/tools.js` (README has the summary table) |
| How v0.1 was built, phase by phase | `git log` |

When a decision changes, edit it here in place and add a dated line to [Changes](#changes) at the end.


## 1. Stack and shape

| Question | Decision |
| --- | --- |
| API language | Node 22, plain JS (ESM, JSDoc types, no compile step) |
| Runtime dependencies | Exactly `pg` (loaded only for `postgres://` URLs) and `@modelcontextprotocol/sdk` (MCP server only). Tests use `node:test`; SQLite is `node:sqlite` |
| Databases | PostgreSQL in production; SQLite for local work and tests. One dialect-neutral migration serves both unless a `NNN_name.sqlite.sql` / `.postgres.sql` override exists |
| One door | The browser and the MCP server both call the HTTP API; only `api/lib/repo/*.js` runs SQL |
| MCP server | A local stdio script in `mcp/`, authenticated with a personal token |
| Who can edit | Everyone signed in; `permissions.edit` in the config narrows it to groups |
| Hosting | Host-neutral: `createApp()` takes a Web `Request`; each fork adds a thin adapter under `host/<its-host>/` (gitignored upstream). README shows the three adapter shapes |
| Look | One theme, `public/css/theme-toolbar.css` (see §8) |

**Data representation** (identical on both databases): ids are app-generated UUIDs in `TEXT` (the catch-all and seed use fixed readable ids); timestamps are ISO-8601 UTC `TEXT`; `due_date` is `YYYY-MM-DD` text; booleans are `INTEGER` 0/1 with a `CHECK`. No `SERIAL`, `BOOLEAN`, `TIMESTAMPTZ`, `AUTOINCREMENT`, or `RETURNING`: writes update, then select inside the transaction.

**Statuses live in the config, not a table**, so a team changes them without a migration. Rows keep whatever string they were written with.


## 2. Data rules (where the one-pager was silent)

1. **A private project only ever contains its owner's tasks, and every task belongs to exactly one project.** A catch-all project ("General", fixed id `config.catch_all_project.id`, created by `npm run migrate`, owned by the system principal) receives orphans. It is always public and cannot be made private, reassigned, or trashed; its name, description, status, and tags are editable. Making a project private (or reassigning a private project) moves every task in it owned by someone else, live or trashed, to the catch-all in the same transaction: `project_id` changes, `version` increments, an activity entry `update {"project_id": {from, to}}` is written by the flipping user, and nothing else on the task changes. The response carries `moved_tasks`, counting only tasks the caller could see. Every other door that could break the invariant refuses with 400: creating a task for someone else in a private project, reassigning a task inside one, moving someone else's task into one, and restoring a trashed task whose owner differs. A task created without a project goes to the catch-all. There is no undo: the moves are in the activity log, the moved tasks stay editable by their owners, and making the project public again lets anyone move them back by hand.
2. **Tags are a public, shared vocabulary.** Names and colors are visible to everyone, with no usage counts, so a tag attached only to private items reveals nothing. The tag editor says so.
3. **Trashing a project does not stamp its tasks.** They disappear with the project and come back on restore. A task trashed on its own stays trashed after its project is restored.
4. **"Delete" means trash everywhere.** No hard delete, not even in the API. `ON DELETE CASCADE` on the tag join tables exists only for a future hard-delete migration.
5. **Tasks can move between projects** (`PATCH project_id`); the target must be visible to the caller and not trashed.
6. **Reassigning:** any editor can reassign a public item; only the owner can reassign a private one (only the owner can see it). After reassigning a private item, the previous owner gets 404 on it.
7. **Owners are ids plus a name snapshot.** Rows carry `owner_id` and `owner_name`; the name refreshes whenever the owner writes to their own item. **When the server knows the new owner, it names them:** under `password` the `users` table (§4) and under `dev` the configured users are a directory, so assigning to an id found there stores the directory's name and ignores the client's, and nobody can label an item "owned by bob" under a name of their choosing. Under `password` an item can only be given to an enabled user (a disabled or unknown id is refused alike), so a look-alike id cannot carry a borrowed name and a write cannot tell a disabled account from a made-up one; under `dev`, which is local, an unlisted id still takes the client's name. `system` is reserved under every provider. Under `headers` there is no directory (identity arrives on every request), so the client's `owner_name` is still required and trusted. Items store the snapshot under every provider.
8. **Overdue is computed in the browser:** `due_date` before today's local date and status not in `closed_statuses`. The API offers only `due_before` / `due_after`.
9. **A project's `version` does not change when its tasks change**, so task edits never make project edits conflict.
10. **The hit counter has no deduplication**, like a 1996 counter, and stores no viewer identity. It is a `hit_count` column, not a views table: a table would record who looked at what, the one thing a privacy-respecting counter must not store. It is bumped only by the UI's project page, with a visible read first. A fork that wants deduplication adds `project_views(project_id, viewer_hash, day)` and increments the column only on a new row.
11. **Tag attach and detach bump the item's `version`** and require `version` in the body, like any other write to the item. **A request that would change no stored value is not a write:** attaching a tag that is already attached, detaching one that is not, or a PATCH whose fields all equal the stored ones. The version is still checked under the row lock (409 with `current` when stale), but it is not bumped, `updated_at` stays, no activity entry is written, and the current record comes back. A bump without an entry would break rule 13, and an entry with empty `changes` says nothing. The owner's name-snapshot refresh (rule 7) is a stored change: alone it is a logged `owner_name` update; next to other changes it stays out of the entry.
12. **Activity `changes`:** `create` lists every settable field as `{"to"}` (tags as names); `update` lists only changed fields as `{"from","to"}` (reassignment as `owner_id` + `owner_name`, privacy as `private`, tags as name arrays); `trash` and `restore` are `{}`. Titles are not stored on the entry; reads join the current name, so renamed or trashed items still read well.
13. **What is versioned and logged:** projects, tasks, and their tag links. Deliberately outside that rule: the hit counter, and the auth tables (`mcp_tokens`, `users`, `sessions`), which have no `version` and write no activity entries.


## 3. Privacy

**One place:** `api/lib/repo/visibility.js`. Every repo read takes `user` first and applies these; handlers contain no SQL, so forgetting the predicate is structurally hard and testable without HTTP. Helpers that skip the predicate are named `unsafe*`, never exported, and called only inside a transaction after a visible read.

```js
projectVisible(alias, user) // (alias.private = 0 OR alias.owner_id = ?)
taskVisible(t, p, user)     // task predicate AND its project's predicate
live(alias)                 // alias.deleted_at IS NULL
trashState(alias, mode)     // include_trashed: false | true | only
```

Every task query joins `projects p` so both predicates apply. Default trash predicate: projects `live('p')`; tasks `live('t') AND live('p')`.

| Read path | Mechanism |
| --- | --- |
| get project / get task | `repo.*.get(user, id)` returns `null` for missing and invisible alike; the handler throws the same `notFound()` |
| lists, search, trash, export | the same `list(user, filters)` functions; filters stack on the predicate, never replace it |
| tags on items | loaded for the already-filtered id set; the global tag list carries no counts |
| activity | `EXISTS` subqueries against the item's current state (below) |
| people | distinct owners of items visible to the caller, plus the caller, plus the directory (configured dev users under `dev`, enabled `users` rows under `password`, none under `headers`). The directory adds names, never anything about items; a name known only from a private item is never listed |
| hit counter | `recordHit(user, id)` does a visible read inside the increment transaction |
| writes | visible read first inside the transaction; the 409 `current` is re-read visibly and becomes 404 if no longer visible |

**404, not 403.** Others see nothing of a private item: no placeholder, no count. A non-owner reaching one gets a body byte-identical to a nonexistent id's. 403 is used only when the caller can already see the item (a non-owner flipping `private`, a non-editor writing, a token principal on a human-only route). Error messages never echo ids, names, titles, or submitted values.

**Activity is filtered at read time against the item's current state:**

```sql
WHERE a.item_type = 'tag'
   OR (a.item_type = 'project' AND EXISTS (SELECT 1 FROM projects p
        WHERE p.id = a.item_id AND (p.private = 0 OR p.owner_id = ?)))
   OR (a.item_type = 'task' AND EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id = a.item_id AND (t.private = 0 OR t.owner_id = ?) AND (p.private = 0 OR p.owner_id = ?)))
```

Consequences: flipping private hides all past entries from others, including the flip itself; flipping public reveals the full history (the UI toggle says so); reassigning a private item passes its history to the new owner; a project going private hides its tasks' entries; trash state does not affect activity visibility. Snapshotting owner and privacy on each entry was rejected because old public entries would keep leaking an item after it went private.

**Not encryption.** Anyone with database or hosting admin access reads every row; README says so.


## 4. Identity

`getUser(request, ctx)` in `api/lib/auth/index.js` returns a `Principal` (typedef there) or `null`:

1. **Bearer token** (`Authorization: Bearer tsk_…`) is authoritative when present: SHA-256 the value and look it up among unrevoked `mcp_tokens`; unknown or revoked is 401 and never falls through to the provider or a cookie. Success yields `via: 'mcp'` with `session_id` from `X-Taskscape-Session`; a token write without that header is 400. Token principals get 403 on `/api/tokens/*` and on the hit counter, so a leaked token cannot mint tokens. Under `password`, a token works only while a live `users` row exists for its user. A token's edit rights follow the groups snapshotted when it was issued.
2. **The configured provider** (`auth.provider`, overridable by `TASKSCAPE_AUTH_PROVIDER`):
   - `headers`: identity from headers a sign-in layer injects, or from one base64-JSON principal header read with dot paths. Safe only behind a layer that overwrites client-supplied copies; README says so in bold.
   - `password` (added 2026-11-01): Taskscape's own sign-in for hosts without one. Users are managed from the shell (`npm run users`), never through the web; sessions are cookie-backed rows. Decisions: scrypt hashes with a bounded number running at once; an in-memory, per-process lockout per username (and a separate one for password changes); `__Host-` cookie, not extended by use; changing a password signs out other sessions and can revoke tokens; adding a user whose id already owns items needs `--claim-existing`, so a new account cannot silently inherit someone else's history.
   - `dev`: the user from `X-Dev-User`, else the `taskscape_dev_user` cookie, else `auth.dev.default_user`; must be a configured dev user. Refused when `TASKSCAPE_ENV=production`; the UI shows a red DEV MODE banner.
3. `null` is 401. The API never redirects; under `headers` the host's sign-on handles page loads, and under `password` the pages send signed-out visitors to `login.html`.

**Cross-site writes** from any browser principal are refused (`Sec-Fetch-Site`, JSON-only bodies); Bearer tokens are exempt.

`can_edit`: `permissions.edit = "everyone"` is true; `"group"` needs an overlap between the user's groups and `permissions.groups`. Minting a token requires `can_edit`.


## 5. Database adapter

- **Placeholders:** repo SQL uses `?`; `placeholders.js` rewrites to `$1..$n` for PostgreSQL, skipping string literals and comments.
- **Compare-and-set:** `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`; zero rows changed means 409 with the current record. The activity entry is written in the same transaction.
- **Transactions:** SQLite uses `BEGIN IMMEDIATE` behind a per-process mutex; PostgreSQL checks out a pool client and passes a client-bound `Db`. Nested transactions throw. Where a write must see a concurrent privacy flip, it takes the project's row lock first with a no-op `UPDATE`.
- **Migrations:** numeric order, one transaction per file, recorded in `schema_migrations`. Two files sharing a number, a misnamed `.sql`, or an applied file renamed all throw. Run by `npm run migrate` as a deploy step, never at request time; PostgreSQL holds an advisory lock around the run.
- **Configuration:** `TASKSCAPE_DATABASE_URL` picks the adapter by scheme. Secrets live in the environment, never in `taskscape.config.json`.


## 6. MCP server

- **Transport:** stdio. `mcp/tools.js` is transport-free (plain JSON Schema plus handlers), so a fork can switch to an HTTP transport by changing `server.js` only.
- **Session:** a random id per server process, sent as `X-Taskscape-Session`; the API records it with `via = 'mcp'` on every write, so What's New shows which Claude session did what.
- **Data, not instructions:** the server instructions and every tool description say that titles, descriptions, notes, tag names, and owner names are user data, never directions. Results are JSON text, not prose.
- **One item per delete:** the `delete` tool takes a single id, refuses arrays, and tells Claude to confirm each item with the user.
- **Errors never throw:** a 409 comes back as `isError` text naming both versions with the current record embedded, so Claude can retry without another read. A 404 says the item may be private to someone else.
- **No tool for** the hit counter (reading through MCP is not a visit) or for the human-only routes (tokens, sign-in, password changes).


## 7. Testing

- `node:test`, no framework. `test/helpers.js` builds an in-memory SQLite app (or uses `TASKSCAPE_TEST_POSTGRES_URL`) and calls `app.fetch` directly: no ports, parallel-safe.
- One test file per concern (the file names say which). Privacy tests compare 404 bodies byte for byte against a random id's.
- `ui-escaping.test.js` greps `public/` and fails on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, inline `on*=`, or `javascript:`.
- Not covered by tests: rendering, the marquee, the inline edit flow. Check those by hand against the seed data (§9).


## 8. UI

- Plain HTML, CSS, and ES modules served as-is; DOM built only with the `textContent` helpers in `public/js/dom.js`.
- `base.css` holds layout, focus rings, and the `prefers-reduced-motion` kill switch; `theme-toolbar.css` holds the look, linked directly by every page. Nostalgia stays in the chrome and pixel details; the content area stays readable, with visible focus and the reader's dark mode.
- **Hit counter** (`js/odometer.js`, loaded with `import()` so a content blocker costs only the counter): a `role="img"` span with an `aria-label`, one `.digit` per zero-padded digit (six minimum). `project.html` calls `POST /hit` once after the project loads; if that fails the page still shows the record's `hit_count`. Three clicks within two seconds reveal the webring bar (from `config.webring`; hidden when empty). On private projects a `title` says only the owner's visits are counted.
- **Overdue is said in still text.** Wherever the toolbar marquee appears (home, project), a static line in the page names the count and links each overdue task (the first ten, then "and N more"). The count asks the API for open statuses only, at the largest page size, and says "N+" when that page comes back full. The marquee repeats it as decoration only: plain text, `aria-hidden`, stopped under `prefers-reduced-motion`, and stoppable by anyone with a toolbar Stop button (remembered per browser in `localStorage`, wrapped in try/catch). A screenshot, a screen reader, a keyboard user, or a reduced-motion reader never depends on it.
- **My tasks** (`mine.html`) is the one view across projects: `GET /api/tasks?owner=me`, no API of its own. Closed statuses are hidden by asking for the open ones (`status=` every status not in `closed_statuses.task`), so a row whose status was renamed out of the config shows only with "Show closed tasks". Overdue tasks come first under a static count. "Owner: Me" on the home page still filters projects, not tasks.
- **The task table reads first.** Rows are plain text with wrapping titles; tag chips and Notes stay live, since each saves on its own. A row's Edit button turns it into one form across the row (a labelled control per editable column, wrapping to fit, plus "Move to project"), so the table fits 800px without scrolling sideways and stacks one block per task at phone width. Save sends one `PATCH` with only the fields that changed and the version the row was read at, and nothing at all when nothing changed; An open Notes row saves with the form, and a late write to the row (a tag) leaves an open form alone, so nobody's typing is thrown away; the form's Save then meets the new version as a 409. Enter saves, Escape cancels (not while a save is in flight), and focus returns to the row's Edit button. A 409 goes through `attempt()` and shows the latest record, so the edit is retyped against it. The owner-only rules stay: only the owner sees the Private checkbox, and a private task's owner select appears only for its owner; making a task public still asks first. Moving or trashing a row removes only that row (another row's open form survives) and focuses the next row.
- **For you** (What's New, "Show: For you", or `whats-new.html?for=me`) is `GET /api/activity?for=me`: other people's changes to the projects and tasks I own now, under the feed's read-time visibility. Ownership is read at query time, so handing an item over hands over its history, and an item that goes private to someone else drops out. The toolbar's What's New entry shows how many of those are newer than "last seen" (at most "20+"), and showing the For you view with Via: Anyone marks them seen (a Via filter may hide the newest one, so it does not). **"Last seen" lives in the browser**, in `localStorage` per user (`taskscape_for_you_seen:<user id>`), every access in try/catch: a server-side read marker would be a new table with writes outside the versioning rule and the activity log, for a badge. The cost is accepted: it does not follow anyone across browsers or devices, and clearing site data shows the recent entries as new again. Storage that refuses writes keeps the marker in memory for that page only.
- **Load more** on the project list, the task table, and My tasks (`js/pager.js`): the list routes return no total, so there is more exactly when a page comes back full (`items.length === limit`); a last page that happens to be full costs one empty request. Each list captures its query when it starts over, so later pages keep the sort and filters, and a response for a query that has since changed is dropped. Trashing a row, or editing one in the task table (which can move it out of the loaded range), shifts the next offset back by one; a row that comes back a second time is dropped by id, so stepping back too far only repeats a request's worth of rows, never skips one. An empty last page puts focus on the last row. The button stays enabled while it loads (`aria-disabled`), so focus never falls to the page. The overdue line has its own query, so it holds however many pages are loaded.
- Padlock on private rows; confirm dialogs on trash, revoke, and privacy flips (flipping private names how many tasks move to General; flipping public warns that history becomes visible). General hides its privacy toggle and trash button.

History of the look: the 1996 Netscape theme came first, then a plain "nobody designed this" theme was the default from 2026-10-31; both were removed on 2026-11-01 along with the `theme` config key.


## 9. Manual check before a release

- `npm test` green on SQLite (and on PostgreSQL when a database is at hand).
- `npm run migrate && npm run seed -- --reset && npm run dev`, then: as alice, three projects plus General and no trace of Reorg notes; as carol, Reorg notes and its task; as alice, Review comp bands under General with a What's New entry saying carol moved it; `GET /api/projects/<reorg id>` as bob returns the generic 404.
- Two MCP sessions both `get` a task and both `update` it with the same version: the second gets the conflict text with the current record and succeeds on retry.
- The counter on Website refresh increments on reload; `GET /api/projects` leaves it unchanged.
- Back up, edit a task, restore per README, and confirm the edit is gone.
- Run the three agents in `.claude/agents/` (privacy-auditor, security-reviewer, upstream-check).


## Changes

- 2026-10-31: agreed at the end of Phase 0 (stack, privacy, catch-all project, data rules 1–11).
- 2026-11-01: `password` provider with `users` and `sessions` tables (§4); one theme (§8).
- 2026-11-01: cut down to decisions. The folder layout, schema copy, seed table, MCP tool table, test table, and build order were removed; they duplicated CLAUDE.md, `migrations/`, `scripts/seed.js`, README, `test/`, and `git log`, and had started to disagree with them. Rule 7 now covers the password provider's users table, rule 13 names what is outside the versioning rule, and the people row no longer claims activity actors are included.
- 2026-11-01: rule 11: a request that changes nothing (tag already attached or absent, a PATCH that matches) checks the version but bumps nothing and logs nothing.
- 2026-11-01: rule 7 and the people row: the password `users` table and the dev users are a directory for owner names and the people picker; `headers` keeps trusting the client's `owner_name`.
- 2026-11-01: §8: My tasks page.
- 2026-11-01: §8: overdue is a static line; the marquee is decoration.
- 2026-11-01: §8: Load more on the project list, task table, and My tasks.
- 2026-11-01: §8: the task table reads first, with a per-row Edit form.
- 2026-11-01: §8: For you, with an unread badge; last seen is kept per browser in localStorage.
