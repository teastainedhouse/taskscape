# Taskscape

Taskscape is a tiny, self-hosted work tracker for projects, tasks, and tags. People edit it in a browser; Claude edits it through an MCP server. Both go through one HTTP API, which is the only thing that talks to the database. Every write is version-checked, so several people and several Claude sessions can work at once without overwriting each other, and every write lands in an activity log ("What's New?"). Anyone can mark a project or task private; only its owner sees it afterwards.

It is MIT-licensed, built on personal time, and made to be forked: each team hosts its own copy and changes it by asking Claude to edit the code, not by clicking through settings. There is no build step and no framework. It looks like an old web browser on purpose: dithered grey toolbars with pixel-art icons, a starfield throbber and a status bar frame a modern, readable page with a hit counter. It follows the reader's dark mode. The look lives in one CSS file (`public/css/theme-toolbar.css`).

- Decisions and the reasons behind them: [docs/PLAN.md](docs/PLAN.md)
- API contract: [docs/API.md](docs/API.md)
- Working on the code (code map, house rules, recipes): [CLAUDE.md](CLAUDE.md)
- The original pitch, kept as history: [docs/ONE-PAGER.md](docs/ONE-PAGER.md)

## Requirements

- Node.js 22.13 or newer. The API, dev server, seed script, backup script, and tests use only Node builtins (`node:http`, `node:sqlite`, `node:test`).
- `npm install` is needed only for two things: PostgreSQL (the `pg` package) and the MCP server (`@modelcontextprotocol/sdk`). Local development on SQLite runs without it.
- For production: a host with static file hosting, a serverless function (or any Node process) for `/api/*`, a PostgreSQL database, and either a sign-in layer that puts the user's identity in request headers or the built-in password sign-in over HTTPS (see [Identity](#identity)).

## Run it locally

```sh
git clone <your fork> taskscape
cd taskscape
npm run migrate      # creates data/dev.db, applies migrations, creates the "General" project
npm run seed         # three dev users, five projects, eight tasks, four tags, guestbook comments, some history
npm run dev          # http://localhost:3000, restarts on file changes
```

Open <http://localhost:3000>. You are signed in as `alice` (the default dev user). To work as someone else, pick a user from the DEV MODE banner at the top of the page, or send the header yourself:

```sh
curl -H 'x-dev-user: carol' http://localhost:3000/api/projects
```

The dev provider accepts the header `X-Dev-User` or the cookie `taskscape_dev_user`; the value must be one of `auth.dev.users` in the config file (`alice`, `bob`, `carol` as shipped). Anything else is a 401.

Useful variations:

- `npm start` runs the same server without the file watcher.
- `PORT=3103 npm run dev` picks another port. The server binds `127.0.0.1`; `HOST=0.0.0.0` listens on every interface.
- `npm run seed -- --reset` throws the current data away and reseeds. Without `--reset` the seed refuses to touch a database that already has data.
- A `.env` file in the repo root is read by every script. Copy `.env.example` to start.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TASKSCAPE_DATABASE_URL` | `sqlite:./data/dev.db` | `sqlite:<path>` or `postgres://user:password@host:5432/dbname` |
| `TASKSCAPE_AUTH_PROVIDER` | from the config file (`dev`) | `dev`, `headers`, or `password`; overrides `auth.provider` |
| `TASKSCAPE_ENV` | `development` | `production` refuses to start with the `dev` provider |
| `TASKSCAPE_CONFIG` | `./taskscape.config.json` | path to the config file |
| `PORT` | `3000` | dev server port |
| `HOST` | `127.0.0.1` | dev server bind address; behind a reverse proxy keep it on loopback so the proxy is the only way in |
| `TASKSCAPE_URL`, `TASKSCAPE_TOKEN` | — | MCP server only; see [MCP setup](#mcp-setup) |

## The config file

`taskscape.config.json` is the one place a team changes behaviour without touching code. Secrets never go in it; it is committed. The browser receives a public subset through `GET /api/config` (never the header names under `auth`).

| Key | What it does |
| --- | --- |
| `site_title` | Shown in page titles and headers |
| `statuses` | Allowed status names for `project` and `task`, in display and sort order |
| `closed_statuses` | Which statuses count as done (a task in one is never overdue) |
| `default_status` | Status a new project or task gets when none is sent |
| `tag_palette` | `#rrggbb` colors handed to new tags in turn |
| `task_fields` | Which task columns the task table shows, in order |
| `default_views` | Named sort and filter presets; `tasks` is the one the task table opens with |
| `privacy` | `default_private`: whether new items start private (shipped: `false`) |
| `permissions` | `edit`: `everyone`, or `group` with `groups` listing the SSO groups that may write |
| `webring` | `[{ "name", "url" }]` of other teams' Taskscape copies; hidden until someone clicks the hit counter three times |
| `limits` | `page_size` (default list size, 500), `max_page_size` (1000), `body_bytes` (256 KB) |
| `catch_all_project` | `id`, `name`, `description` of the project that receives tasks with no project (shipped id: `general`) |
| `auth` | `provider` (`dev`, `headers`, or `password`), `headers` (which request headers carry identity), `dev` (the local user list and `default_user`), `password` (`session_days`, 1–365, default 30; `cookie_name`, default `__Host-taskscape_session`) |

The config is validated at startup; a bad value stops the process with a message naming the key.

### The catch-all project

`npm run migrate` creates one project with the fixed id from `catch_all_project.id` (`general`, named "General"). It is owned by the system, always public, and cannot be made private, reassigned, or trashed; its name, description, status, and tags are editable like any project. A task created without a `project_id` is filed there. When a project goes private, every task in it owned by someone other than the project owner moves there, with an activity entry so the task's owner can see what happened.

## Fork and deploy

Taskscape is host-neutral on purpose. Upstream has no host adapter, no vendor names, and no company data. Each fork adds its own adapter under `host/<its-host>/`, which is gitignored upstream, and keeps its setup notes in the fork. Nothing company-specific goes upstream.

1. **Fork the repository** and clone your fork.

2. **Edit `taskscape.config.json`.** At least: `site_title`, and set `auth.provider` to `headers` (or `password`, if the host has no sign-in layer; see [Identity](#identity)). Check the header names under `auth.headers` against what your sign-in layer injects (see [Identity](#identity)). Adjust statuses, palette, and `permissions` if you want.

3. **Choose a database.** Production uses PostgreSQL. Create an empty database and note its URL. Run `npm install` so the `pg` package is present. (SQLite works for a single-process host with a persistent disk, but it is meant for development.)

4. **Run migrations** as a deploy step, every deploy, before the new code takes traffic:

   ```sh
   TASKSCAPE_DATABASE_URL='postgres://…' npm run migrate
   ```

   It applies unapplied files from `migrations/` in order, each in its own transaction, under an advisory lock so two deployers cannot race, and creates the catch-all project if missing. Migrations never run at request time.

5. **Wire the host.** Three pieces:

   - **Static files:** serve `public/` as-is at the site root. `/` is `public/index.html`.
   - **The API:** route `/api/*` to one function that calls `app.fetch(request)`. The adapter is a thin file under `host/<your-host>/`; the shape depends on what your host hands you:

     *Fetch-style host* (receives a Web `Request`, returns a `Response`):

     ```js
     // host/<your-host>/api.js
     import { loadConfig } from '../../api/lib/config.js';
     import { openDb } from '../../api/lib/db/index.js';
     import { createApp } from '../../api/index.js';

     const config = loadConfig();                       // or loadConfig('/absolute/path/taskscape.config.json')
     const db = await openDb(process.env.TASKSCAPE_DATABASE_URL);
     const app = createApp({ config, db });

     export default { fetch: (request) => app.fetch(request) };
     ```

     *Node-callback host* (receives `IncomingMessage`, `ServerResponse`):

     ```js
     import { toWebRequest, writeResponse } from '../../api/lib/node-bridge.js';
     // build `app` as above
     export default async function handler(req, res) {
       await writeResponse(res, await app.fetch(toWebRequest(req, { protocol: 'https' })));
     }
     ```

     *Custom-event host* (receives its own event object): build a `new Request(url, { method, headers, body })` from the event, call `app.fetch(request)`, and copy `response.status`, `response.headers`, and `await response.text()` back into the host's reply shape.

     Build `app` once per process, not per request. `loadConfig()` resolves the config path against the working directory; if your host's working directory is not the repo root, set `TASKSCAPE_CONFIG` to an absolute path.

   - **Sign-in:** put the site behind your host's single sign-on so every request to `/api/*` arrives with the user's identity in headers. The API never redirects to a login page; the host does that for page loads, and the UI shows "Session expired, reload" on a 401. With the `password` provider instead, serve the site over HTTPS only, create users with `npm run users` (below), and the pages send signed-out visitors to `login.html`.

6. **Set the environment** on the host:

   ```
   TASKSCAPE_DATABASE_URL=postgres://…
   TASKSCAPE_AUTH_PROVIDER=headers
   TASKSCAPE_ENV=production
   ```

   `TASKSCAPE_ENV=production` makes the process refuse to start with the `dev` provider, so a misconfigured deploy fails loudly instead of letting anyone pick a user.

7. **Verify.** `GET /api/health` needs no sign-in and returns `{"ok":true}`. `GET /api/me`, opened in a signed-in browser, returns your id and name with `"auth": "headers"` and `"can_edit": true`. If it returns 401, the headers are not reaching the function; if the id is wrong, `auth.headers` names the wrong header.

### Identity

Identity comes from one of three providers, picked by `auth.provider` (or `TASKSCAPE_AUTH_PROVIDER`), plus MCP tokens on top. `headers` trusts a sign-in layer in front of the site; `password` is Taskscape's own sign-in, for a host without one; `dev` is for local work.

**`headers` provider.** Reads the user from headers injected by the host's sign-in layer. The header names are configurable under `auth.headers`; the shipped defaults follow the common reverse-proxy convention:

| Field | Shipped header name |
| --- | --- |
| `id` | `x-forwarded-user` |
| `name` | `x-forwarded-preferred-username` |
| `email` | `x-forwarded-email` |
| `groups` | `x-forwarded-groups` (comma-separated) |

Some hosts send one header with a base64-encoded JSON document instead. Set `auth.headers.principal` to that header's name and the `*_path` keys to dot paths inside the document (`id_path`, `name_path`, `email_path`, `groups_path`). If the document keeps claims as an array of `{type, value}` pairs, `claims_path` plus `claim_type_key` / `claim_value_key` flatten them so `claims.email` style paths work. When `principal` is set, the plain header names are ignored and only the document is read, so a header a client can add never overrides the host's signed identity. No id means 401.

**No directory under `headers`.** Taskscape only sees people when they make a request, so the owner picker lists people who own something you can see, plus you. A new coworker shows up there once they have created something, or once someone assigns them work through the API with their id and display name (`owner_name` is required and stored as sent).

**The `headers` provider is safe ONLY behind a sign-in layer that strips client-supplied copies of those headers. If a browser can reach the API directly and set `x-forwarded-user` itself, anyone can be anyone. Confirm with your host that these headers are overwritten, not merged, before going live.**

**`dev` provider.** Local only. The user comes from the `X-Dev-User` header, else the `taskscape_dev_user` cookie, else `auth.dev.default_user`, and must be in `auth.dev.users`. Refused when `TASKSCAPE_ENV=production`.

**`password` provider.** Built-in username and password sign-in, for a host with no sign-in layer of its own. Users live in the database (`users` table, added by `npm run migrate`), managed from the shell on the server:

```sh
npm run users -- add dana --name "Dana Fox" --email dana@example.test --groups editors
npm run users -- passwd dana     # new password; signs that user out everywhere and revokes their MCP tokens
npm run users -- disable dana    # no sign-in; ends sessions and revokes MCP tokens (works for an id with no users row too)
npm run users -- enable dana
npm run users -- list               # id, name, email, groups, disabled, live sessions; never hashes
```

The user id is what becomes `owner_id` on projects and tasks. Ids are lowercase letters, digits, `.`, `_`, `-`; `system` is reserved (it owns the catch-all project). Every enabled user appears in the owner picker from the moment they are added, and items assigned to them carry the name from `users`, not one the assigner typed. Work can only be assigned to enabled users: an id without a live users row is refused, so add people (or `--claim-existing` their old ids) before assigning to them.

**Switching an existing site to `password`.** Existing projects, tasks, activity, and MCP tokens carry the ids people had under the old provider. `users add` refuses an id that already appears as an owner, an activity actor, or a token holder, and prints what it found (counts only). When the new account really is that person, add `--claim-existing`: the account then owns those items and that history, and their unrevoked MCP tokens work again (under `password` a token works only while a live users row exists for its id). Do this for each person before switching `auth.provider`, using the same ids as before; `npm run users -- list` checks the result. An id that should not come back can be swept with `disable` even without a users row.

Passwords are 10 to 200 characters and are typed at a hidden prompt, twice; for scripted setup, pipe one line on stdin (`printf '%s\n' "$PW" | npm run users -- add …`). They are never taken from the command line. Groups feed `permissions` exactly as SSO groups do.

People sign in on `login.html`; the API answers with a session cookie (`__Host-taskscape_session`; `HttpOnly`, `Secure`, `SameSite=Strict`) that lasts `auth.password.session_days` from sign-in and is not extended by use. Passwords are stored as scrypt hashes and session cookies as SHA-256 hashes. Five failed attempts for one username within 15 minutes lock that name for 15 minutes, whether or not the user exists; password changes keep their own count. At most two password hashes run at once, with a short queue, and the rest get 503 "busy". **Both the lockout and the hash limit are in memory and per process:** a restart clears the counts, and with several processes or instances each keeps its own, so put a rate limit in the proxy too if the site faces the internet. The lockout also means anyone who knows a username can keep that account locked by failing on purpose; usernames are not secret (editors see them in the owner picker), so the proxy's rate limit is the real defence. Signed-in people change their own password on their profile page, which also lists their active sign-ins and lets them end the others; that signs out their other sessions, and a checkbox also revokes their MCP tokens. Requirements:

- **HTTPS only.** The cookie is `Secure`, so a browser drops it over plain `http://` on anything but `localhost`. Behind a reverse proxy, terminate TLS there and keep `HOST` on loopback.
- **Serve the pages and `/api/*` from one origin.** Cross-site writes are refused (`Sec-Fetch-Site`, JSON-only bodies), and `same-site` counts as cross-site. The same checks apply to every browser session under `dev` and `headers` as well.
- The default cookie name has the `__Host-` prefix, so browsers refuse it unless it is `Secure`, `Path=/`, and has no `Domain`, which Taskscape guarantees. Change it with `auth.password.cookie_name` if needed.

**Tokens.** `Authorization: Bearer tsk_…` identifies an MCP session. A token is authoritative when present: an unknown or revoked one is 401 and never falls back to headers or the session cookie. Token holders cannot mint or list tokens and cannot bump hit counters.

## Backup and restore

The database is the only store. **Markdown export is not a backup**: "Save as markdown" omits other people's private items, ids, versions, tokens, and the activity log, and nothing can import it.

### SQLite

Back up (safe while the server is running; it uses the online backup API):

```sh
npm run backup
```

This writes `backups/taskscape-<timestamp>.db` and prints the path. To choose the destination: `npm run backup -- /some/path/taskscape.db`. `backups/` is gitignored. Copy the file somewhere off the machine.

Restore. These steps assume the default `TASKSCAPE_DATABASE_URL=sqlite:./data/dev.db`; if yours differs, use that path wherever `data/dev.db` appears.

1. Stop the server. If it was started with `npm run dev` or `npm start`, press `Ctrl+C` in that terminal and wait for the prompt to come back. Do not continue while the server is running.
2. Pick the backup file to restore, for example `backups/taskscape-2026-10-31T12-45-49.db`.
3. Copy the backup over the database file:

   ```sh
   cp backups/taskscape-2026-10-31T12-45-49.db data/dev.db
   ```

4. Delete the write-ahead files beside it, if they exist. They belong to the old database and must not be replayed onto the restored one:

   ```sh
   rm -f data/dev.db-wal data/dev.db-shm
   ```

5. Start the server again:

   ```sh
   npm run dev
   ```

6. Check: open <http://localhost:3000> (or `curl -H 'x-dev-user: alice' http://localhost:3000/api/projects`) and confirm the data is as it was at backup time. A change made after the backup is gone; that is the expected result.

### PostgreSQL

`npm run backup` does not copy a PostgreSQL database. With a `postgres://` URL it prints the two commands to run instead, which are:

Back up:

```sh
mkdir -p backups
pg_dump --format=custom --no-owner "$TASKSCAPE_DATABASE_URL" > backups/taskscape-<timestamp>.dump
```

Restore:

1. Take the API offline (disable the function or route `/api/*` to nothing) so no writes land during the restore.
2. Run:

   ```sh
   pg_restore --clean --if-exists --no-owner --dbname "$TASKSCAPE_DATABASE_URL" backups/taskscape-<timestamp>.dump
   ```

3. Run `npm run migrate` (a no-op if the dump is current; it also recreates the catch-all project if the dump predates it).
4. Bring the API back and check `GET /api/projects` as a signed-in user.

Test a restore once, before you need it.

## MCP setup

Claude talks to Taskscape through a local MCP server, `mcp/server.js`, which calls the same HTTP API as the browser, with a personal token. It follows the same privacy rules: a session sees a private item only when the token belongs to that item's owner.

1. Sign in to Taskscape in the browser and open your **Profile** (`profile.html`, the avatar at the top right); the MCP tokens section is there. Give the token a label and create it. The plaintext (`tsk_…`) is shown once; copy it now. The same thing from the command line, while signed in: `POST /api/tokens` with `{"label": "…"}`. Tokens can be revoked on the same page, which ends every session using them. Only people with edit permission can mint one.

2. Put the token in your shell environment, not in a file in the repository:

   ```sh
   export TASKSCAPE_TOKEN='tsk_…'
   ```

3. Run `npm install` once so `@modelcontextprotocol/sdk` is present.

4. Register the server with your client. For a Claude Code client, a `.mcp.json` in the project root:

   ```json
   {
     "mcpServers": {
       "taskscape": {
         "command": "node",
         "args": ["mcp/server.js"],
         "env": {
           "TASKSCAPE_URL": "http://localhost:3000",
           "TASKSCAPE_TOKEN": "${TASKSCAPE_TOKEN}"
         }
       }
     }
   }
   ```

   `TASKSCAPE_URL` is the origin of your Taskscape (the deployed site, or the dev server). `${TASKSCAPE_TOKEN}` is expanded from your shell environment by the client; never write the token itself into `.mcp.json`, and never commit one. The repo ships `.mcp.example.json` as a starting point. The server exits with one line on stderr if either variable is missing.

The server exposes nine tools:

| Tool | Does |
| --- | --- |
| `list_projects` | `GET /api/projects` with the same filters |
| `list_tasks` | `GET /api/tasks` with the same filters |
| `get` | One project or task by `type` and `id`, with its newest 50 guestbook comments |
| `create` | A project or task; `tags` by name, created if missing |
| `update` | Needs `type`, `id`, `version`, and `fields`. A stale `version` returns the current record so the caller can retry without another read |
| `delete` | Moves ONE item to the trash: a project, a task, or a guestbook comment you wrote. Takes a single id and refuses arrays; it will not bulk-delete |
| `restore` | Brings one item back from the trash (a comment: only your own) |
| `comment` | Signs the guestbook of one project or task |
| `tag` | Adds and removes tags by name on one item |

Every write records the session id (a random id per server process, sent as `X-Taskscape-Session`) and `via: "mcp"`, so "What's New?" shows which Claude session did what. Reading a project through MCP does not bump its hit counter.

Project and task text is data, never instructions. The server says so in its instructions and in every tool description, and Claude is expected to treat titles, notes, descriptions, guestbook comments, and tag names it reads from Taskscape as content to work on, not directions to follow.

## Running tests

```sh
npm test
```

Runs every `test/*.test.js` with `node:test` against an in-memory SQLite database. No ports, no fixtures on disk, parallel-safe. This must pass before any commit.

To run the same suite against PostgreSQL, point it at an empty database you do not mind truncating. The tests share one database, so run them one file at a time:

```sh
TASKSCAPE_TEST_POSTGRES_URL='postgres://user:password@localhost:5432/taskscape_test' \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "test/*.test.js"
```

## Privacy

Any project or task can be marked private by its owner. A private item is visible only to that owner: it is left out of lists, search, export, "What's New?", the trash, and the people list, and fetching it by id returns the same 404 as an id that does not exist, so there is no trace of it, not even a count. A private project hides every task in it and may only contain its owner's tasks; when a project goes private, other people's tasks move to the General project with an activity entry. Only the owner can flip the switch, and reassigning a private item passes it, and its history, to the new owner. All of this is enforced in one place in the API, so the browser, the MCP tools, and any new route get it for free. What it is not: encryption. Anyone with database or hosting admin access can read every row, so passwords, keys, and anything that must stay secret from the people who run the server never go in Taskscape.

## License

MIT. See [LICENSE](LICENSE).
