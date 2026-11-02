# Taskscape API v0.1

The HTTP contract the UI and the MCP server both use. It is frozen at the end of Phase 1; see the Changes section at the bottom. Design rationale lives in [PLAN.md](PLAN.md).


## 1. Conventions

- Base path `/api`, same origin as the UI. No CORS headers in v0.1.
- Every response is JSON (`application/json; charset=utf-8`) except `export.md`. The API never returns HTML, including on errors. Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Request bodies are JSON, max 256 KB; invalid JSON → 400 `validation_failed`. The one exception is `POST /api/projects/import`, whose body is `text/markdown` (415 for anything else).
- Every route needs an authenticated principal except `GET /api/health`, `GET`/`POST /api/login`, and `POST /api/logout`. No principal → 401.
- Principals come from a Bearer token (MCP) or from the configured provider: `headers` (identity headers set by the host's sign-in layer), `dev` (local switchable users), or `password` (a session cookie set by `POST /api/login`; section 6 "Password sign-in"). A Bearer token wins over the cookie.
- Every browser principal (`via: "ui"`: provider `password`, `dev`, or `headers`) gets two extra checks on every write (any method but GET, HEAD, OPTIONS), and so do `POST /api/login` and `POST /api/logout` themselves: a `Sec-Fetch-Site` header other than `same-origin` or `none` → 403 `forbidden`; a `Content-Type` other than `application/json`, or a body without one → 415 `unsupported_media_type`. A write with no body and no `Content-Type` passes. Bearer-token requests are exempt.
- All writes require edit permission → else 403 `forbidden`.
- `version` is an integer starting at 1. Every write that touches a record (`PATCH`, `DELETE`, restore, tag attach/detach) requires `version` in the body and increments it by 1, updating `updated_at`. Missing `version` → 400. A request that would change nothing (attaching a tag that is already attached, detaching one that is not, a `PATCH` whose fields equal the stored values) still requires and checks `version` (409 when stale) but is not a write: it returns `200` with the current record, its `version` and `updated_at` unchanged, and writes no activity entry.
- Timestamps are ISO-8601 UTC strings. `due_date` is `YYYY-MM-DD` or `null`. Booleans are JSON `true`/`false`.
- Error messages never echo ids, names, titles, or submitted values; validation details name the field only.
- Auth kinds: **any** = UI session or token; **human** = UI session only (token principals get 403); **none** = unauthenticated allowed.

## 2. Error envelope

```json
{ "error": { "code": "validation_failed", "message": "Some fields are invalid.",
             "details": { "fields": { "status": "must be one of the configured task statuses" } } } }
```

| HTTP | code | When |
| --- | --- | --- |
| 400 | `validation_failed` | bad JSON, missing/invalid field, missing `version`, missing `X-Taskscape-Session` on a token write, read-only field sent |
| 400 | `invalid_state` | edit, tag, or hit a trashed item; create a task in a trashed project; restore a task whose project is trashed; restore a live item; trash a trashed item; create a private item owned by someone else; putting someone else's task into a private project (create for another owner, reassign to another owner, move, or restore); making the catch-all project private, reassigning it, or trashing it |
| 401 | `unauthorized` | no principal; unknown/revoked token; unknown dev user; missing, expired, or ended session cookie; failed `POST /api/login` (one body for every reason). `WWW-Authenticate: Bearer realm="taskscape"` |
| 403 | `forbidden` | non-owner flipping `private`; non-editor writing; token principal on a human-only route; cross-site write from a browser principal or to login/logout |
| 404 | `not_found` | unknown route, unknown id, or an item the caller may not see. Body is always `{"error":{"code":"not_found","message":"Not found."}}` |
| 405 | `method_not_allowed` | known path, wrong method; `Allow` header set |
| 409 | `conflict` | stale `version` (section 3) |
| 413 | `payload_too_large` | body over 256 KB |
| 415 | `unsupported_media_type` | a browser-principal write, login, or logout whose body is not `application/json`; an import whose body is not `text/markdown` or not UTF-8 |
| 429 | `too_many_requests` | too many failed password checks for one username (sign-in) or one account (password change); `Retry-After` in whole seconds |
| 503 | `unavailable` | too many password checks waiting in this process; `Retry-After` in whole seconds. The attempt does not count toward the 429 limit |
| 500 | `internal` | unexpected; generic message, details in the server log |

## 3. Conflict body (409)

```json
{ "error": { "code": "conflict", "message": "This record changed since you loaded it. Reload and retry with the current version." },
  "current": { "...the full record as GET returns it, with its current version..." } }
```

`current` is re-read through the visibility predicate after the failed compare-and-set. If the record is no longer visible to the caller, the response is 404, not 409.

## 4. Record shapes

**Project**
```json
{ "id": "6f1c…", "name": "Website refresh", "description": "", "status": "Active",
  "owner_id": "alice", "owner_name": "Alice Lin", "private": false, "version": 3, "hit_count": 1337,
  "created_at": "2026-10-31T07:00:00.000Z", "updated_at": "2026-10-31T08:00:00.000Z", "deleted_at": null,
  "tags": [ { "id": "t1", "name": "web", "color": "#000080" } ] }
```
`hit_count` is read-only; sending it in POST/PATCH → 400 with `details.fields.hit_count = "read-only"`.

**Task**
```json
{ "id": "9a2e…", "project_id": "6f1c…", "project_name": "Website refresh",
  "title": "Fix broken GIFs", "status": "To do", "owner_id": "alice", "owner_name": "Alice Lin",
  "private": false, "due_date": "2026-10-30", "notes": "", "version": 1,
  "created_at": "…", "updated_at": "…", "deleted_at": null,
  "tags": [ { "id": "t3", "name": "bug", "color": "#ff0000" } ] }
```

**Tag** `{ "id", "name", "color", "created_at" }` (no usage counts).

**Comment** (a guestbook entry on a project or a task)
```json
{ "id": "…", "item_type": "task", "item_id": "9a2e…", "author_id": "bob", "author_name": "Bob Ortiz",
  "body": "Love the GIFs!", "version": 1, "created_at": "…", "updated_at": "…", "deleted_at": null }
```
`item_type` and `item_id` name the parent. `body` is plain text, stored trimmed with every line break as `\n` (`\r\n` and a bare `\r` are converted), 1–2000 characters. There is no edit: `updated_at` and `version` move only on trash and restore.

**Activity entry**
```json
{ "id": "…", "created_at": "…", "actor_id": "bob", "actor_name": "Bob Ortiz", "via": "mcp", "session_id": "3c1d…",
  "item_type": "task", "item_id": "9a2e…", "item_title": "Fix broken GIFs", "project_id": "6f1c…",
  "action": "update", "changes": { "status": { "from": "To do", "to": "Doing" } } }
```

**Token** `{ "id", "label", "token_prefix", "created_at", "last_used_at", "revoked_at" }`.

**Session** (a sign-in under the password provider) `{ "id", "created_at", "last_seen_at", "expires_at", "current": true }`. Never the cookie value or its hash. `last_seen_at` moves at most once a minute. There is no user-agent or address column: the table keeps only what the sign-in needs.

**Me** `{ "id", "name", "email", "auth": "headers" | "dev" | "password" | "token", "can_edit": true, "preferences": Preferences }`.

**Preferences** (personal, under any provider) `{ "theme": "toolbar", "comments_label": "Comments" | "Guestbook", "shortcuts": true, "time_zone": "UTC", "chosen": { "theme": false, "comments_label": false, "shortcuts": false, "time_zone": false } }`: the site defaults from the config overlaid with what the person chose, and `chosen` saying which keys they chose. The browser follows a chosen `time_zone` everywhere, and the device's zone otherwise; the MCP `me` tool follows the effective value (the site default when none was chosen). `theme` is one of `/api/config` `themes`; `time_zone` is an IANA name; `shortcuts` says whether single-key keyboard shortcuts are on. Like the auth tables, preferences have no `version` and write no activity: last write wins.

## 5. List query parameters (projects and tasks)

| Param | Values | Notes |
| --- | --- | --- |
| `project` | project id | tasks only |
| `status` | comma-separated names | unknown names ignored |
| `owner` | owner id, or `me` | |
| `tag` | tag name(s), comma = any of | names, not ids |
| `q` | substring | case-insensitive on name/title and description/notes; `%` `_` `\` literal |
| `due_before`, `due_after` | `YYYY-MM-DD` | tasks only, inclusive; `due_before` excludes null due dates |
| `include_trashed` | `false` (default), `true`, `only` | tasks of a trashed project are excluded by default and under `only` (they carry no `deleted_at` of their own); `true` includes everything |
| `sort` | projects: `updated_at` (default), `created_at`, `name`, `status`, `owner_name`; tasks: `updated_at` (default), `created_at`, `title`, `status`, `owner_name`, `due_date` | `status` sorts in config order; `due_date` nulls last |
| `dir` | `asc`, `desc` | default `desc`, except `asc` for `name`, `title`, `due_date` |
| `limit`, `offset` | `limit`: default `limits.page_size` (500), max `limits.max_page_size` (1000); `offset`: 0 to 2^53 − 1 | no total count |

List response: `{ "items": [...], "limit": 500, "offset": 0 }`.

## 6. Routes

| Method | Path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | none | — | `200 {"ok":true}` | |
| GET | `/api/login` | none | — | `200 {"provider":"password","site_title":"Taskscape","theme":"toolbar"}` for every provider; nothing else | |
| POST | `/api/login` | none | `{username, password}` | `200 Me` + `Set-Cookie` (below) | 400 (field names only; control characters in `username` are refused), 401 `"Wrong username or password."`, 403 cross-site, 404 provider is not `password`, 415, 429, 503 |
| POST | `/api/logout` | none | — | `204` + clearing `Set-Cookie`; ends the session the cookie names, if any | 403 cross-site, 404 provider is not `password`, 415 |
| GET | `/api/me/sessions` | human | — | `200 {"items":[Session]}`: the caller's live sign-ins, most recently seen first, `current: true` on the one making the request | 403 (token), 404 provider is not `password` or caller is not a password session |
| DELETE | `/api/me/sessions` | human, no editor check | — | `200 {"ended": n}`: ends every other live session of the caller, keeps this one | 403 (token or cross-site), 404 as above, 415 |
| DELETE | `/api/me/sessions/:id` | human, no editor check | — | `204`; ending the current session also clears the cookie | 403 (token or cross-site), 404 provider is not `password`, caller is not a password session, unknown, expired, or someone else's session (one body for all), 415 |
| POST | `/api/me/password` | human, no editor check | `{current_password, new_password, revoke_tokens?}` (`revoke_tokens` boolean, default `false`) | `204`; ends the caller's other sessions, keeps this one; with `revoke_tokens: true` also revokes every MCP token the caller holds | 400 (`new_password` 10–200 characters; `current_password: "is incorrect"`; `revoke_tokens` not a boolean), 403 (token), 404 provider is not `password` or caller is not a password session, 429, 503 |
| GET | `/api/me` | any | — | `200 Me` (preferences included) | 401 |
| GET | `/api/me/preferences` | any | — | `200 Preferences` | 401 |
| PATCH | `/api/me/preferences` | human, no editor check | `{theme?, comments_label?, shortcuts?, time_zone?}`; each optional; `null` means back to the site default | `200 Preferences` | 400 (field names only: `theme` must be a configured theme, `comments_label` `Comments` or `Guestbook`, `shortcuts` a boolean, `time_zone` an IANA name Intl knows; an unknown key is reported as `body`), 403 (token or cross-site) |
| GET | `/api/config` | any | — | `200` public config (section 7) | 401 |
| GET | `/api/people` | any | — | `200 {"items":[{"id","name"}]}` by name: owners of items visible to the caller, the caller, and, for an editor in the browser (not a token or a read-only account), the server's directory (every configured dev user under `dev`; every enabled `users` row under `password`, whose ids are sign-in usernames; nothing under `headers`). A directory name wins over an item's `owner_name` snapshot; `system` is never listed | 401 |
| GET | `/api/projects` | any | query section 5 | `200 {items:[Project]}` | 400 |
| POST | `/api/projects` | any | `{name, description?, status?, owner_id?, owner_name?, private?, tag_ids?}` | `201 Project` | 400, 403 |
| GET | `/api/projects/:id` | any | — | `200 Project` (trashed ones too, with `deleted_at` set) | 404 |
| PATCH | `/api/projects/:id` | any | `{version, name?, description?, status?, owner_id?, owner_name?, private?}` | `200 Project`; when `private` went true the body also has `moved_tasks: n` | 400, 403, 404, 409 |
| DELETE | `/api/projects/:id` | any | `{version}` | `200 Project` (with `deleted_at`) | 400 invalid_state, 404, 409 |
| POST | `/api/projects/:id/restore` | any | `{version}` | `200 Project` | 400 invalid_state, 404, 409 |
| PUT | `/api/projects/:id/tags/:tagId` | any | `{version}` | `200 Project` (idempotent attach) | 404, 409 |
| DELETE | `/api/projects/:id/tags/:tagId` | any | `{version}` | `200 Project` (idempotent detach) | 404, 409 |
| POST | `/api/projects/import` | any | `text/markdown`: a file in the export format (section 8), within the body limit; query `dry_run=true` plans only, `private=true` makes everything private to the caller | `201 {"project": Project, "tasks": [Task], "comments_skipped": n, "notes": [string]}`; with `dry_run`, `200 {"dry_run": true, "project", "tasks", "comments_skipped", "notes"}` where project and tasks are the planned records (no ids; each task has its `line`) | 400 (field names with the line, never the value: `name`, `tasks`, `title`, `status`, `due_date`, `private`, `tags`, `notes`, …; `dry_run`/`private` must be true or false), 403, 413, 415 (a body that is not `text/markdown`, from any principal) |
| GET | `/api/projects/:id/export.md` | any | — | `200 text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="<ascii-slug>.md"`; tasks ordered by due date, undated last | 404 |
| POST | `/api/projects/:id/hit` | human | — | `200 {"project_id":"…","hit_count":1338}` | 400 invalid_state (trashed), 403 (token), 404 |
| GET | `/api/tasks` | any | query section 5 | `200 {items:[Task]}` | 400 |
| POST | `/api/tasks` | any | `{project_id?, title, status?, owner_id?, owner_name?, private?, due_date?, notes?, tag_ids?}` (`project_id` absent or `null` = the catch-all project) | `201 Task` | 400 (incl. invalid_state), 403, 404 (project not visible) |
| GET | `/api/tasks/:id` | any | — | `200 Task` (trashed ones too) | 404 |
| PATCH | `/api/tasks/:id` | any | `{version, title?, status?, owner_id?, owner_name?, private?, due_date?, notes?, project_id?}` | `200 Task` | 400, 403, 404, 409 |
| DELETE | `/api/tasks/:id` | any | `{version}` | `200 Task` | 400, 404, 409 |
| POST | `/api/tasks/:id/restore` | any | `{version}` | `200 Task` | 400 invalid_state, 404, 409 |
| PUT | `/api/tasks/:id/tags/:tagId` | any | `{version}` | `200 Task` | 404, 409 |
| DELETE | `/api/tasks/:id/tags/:tagId` | any | `{version}` | `200 Task` | 404, 409 |
| GET | `/api/tags` | any | — | `200 {items:[Tag]}` by name | |
| POST | `/api/tags` | any | `{name, color?}` | `201 Tag`, or `200 Tag` if the normalized name exists | 400 (name 1–40 chars, color `#rrggbb`, default next palette color) |
| GET | `/api/projects/:id/comments` | any | — | `200 {"items":[Comment]}` oldest first: live comments, plus the caller's own trashed ones | 404 |
| POST | `/api/projects/:id/comments` | any | `{body}` | `201 Comment` | 400 (`body` 1–2000 characters; invalid_state when the project is in the trash), 403, 404 |
| GET | `/api/tasks/:id/comments` | any | — | as for projects | 404 |
| POST | `/api/tasks/:id/comments` | any | `{body}` | `201 Comment` | 400 (as for projects; invalid_state when the task or its project is in the trash), 403, 404 |
| DELETE | `/api/comments/:id` | any, no editor check | `{version}` | `200 Comment` (with `deleted_at`) | 400 invalid_state, 403 (not the author), 404, 409 |
| POST | `/api/comments/:id/restore` | any | `{version}` | `200 Comment` | 400 invalid_state (not trashed, or the parent is in the trash), 403 (not the author), 404, 409 |
| GET | `/api/trash` | any | — | `200 {"projects":[Project],"tasks":[Task]}` by `deleted_at` desc; tasks only those with their own `deleted_at` | |
| GET | `/api/activity` | any | `limit` (50, max 200), `before` (cursor), `item_type` (`project`, `task`, `tag`, `comment`), `item_id`, `project`, `actor`, `via`, `for` (`me`) | `200 {"items":[Activity],"next_cursor":"…"\|null}` | 400 |
| GET | `/api/search` | any | `q` (min 2 chars), `limit` (20, max 100) | `200 {"projects":[Project],"tasks":[Task]}` | 400 |
| GET | `/api/tokens` | human | — | `200 {items:[Token]}` own tokens, revoked included | 403 |
| POST | `/api/tokens` | human | `{label}` | `201 {"token": Token, "plaintext": "tsk_…"}`; plaintext never shown again | 400, 403 |
| DELETE | `/api/tokens/:id` | human | — | `200 Token` with `revoked_at` | 404 (not yours = not found) |

**Create defaults:** `status` = `default_status.<type>`; owner = caller; `private` = `privacy.default_private`.

**Owner names** (create and `PATCH`): `owner_id: "system"` is refused (`owner_id: "is reserved"`). If `owner_id` is the caller, `owner_name` is overwritten from the principal. If `owner_id` is someone the server's directory knows (an enabled `users` row under `password`; a configured dev user under `dev`), `owner_name` is optional and overwritten with the directory's name. Under `password` any other `owner_id` (unknown, disabled, or a look-alike) is 400 `owner_id: "must be someone who can sign in"`, so send `owner_id` only to change it. Under `dev` for an unlisted id, and always under `headers`, `owner_name` is required with `owner_id` and stored as sent. `owner_name` without `owner_id` is still 400.

**Privacy rules on write, in order:** (1) load the target through the visibility predicate, else 404; (2) `private` changing and caller is not the owner → 403; (3) compare-and-set on `version`, else 409 (or 404 if no longer visible); (4) reassigning a private item is possible only for the owner, which step 1 guarantees. Creating an item that is private and owned by someone else is `400 invalid_state`, and so is a `PATCH` that turns `private` on while giving the item to someone else (make it private first, then hand it over). Reassigning a private item to someone else succeeds and returns the record once; every later read by the previous owner is 404. Reassigning a private project to someone else also moves tasks not owned by the new owner to the catch-all, like a privacy flip, and the response carries `moved_tasks`; since nobody else could see those tasks, each one that was not private becomes private (the move entry carries `"private": {"from": false, "to": true}` too), so handing over a project never shows its tasks to anyone new.

**Task in a private project:** visible only if the task and its project are both visible to the caller. Project privacy wins regardless of the task's own flag, for get, list, create (`project_id` must be visible), move, activity, search, export, trash, and tags.

**A private project only contains its owner's tasks.** Setting `private: true` on a project moves, in the same transaction, every task in it (live or trashed) owned by someone else to the catch-all project: `project_id` becomes the catch-all id, the task's `version` increments, and an activity entry `update {"project_id": {"from": "<project id>", "to": "<catch-all id>"}}` is written by the flipping user so the task's owner sees it in What's New. Nothing else on those tasks changes (except when a project that was already private changes owner: see the privacy rules above); that move is the only edit a project owner makes to another person's task through this route. The response includes `moved_tasks` (integer): the number of moved tasks the caller could see; tasks that were private to someone else also move but are not counted, so the count never reveals them. Afterwards the API refuses with `400 invalid_state` any write that would put someone else's task into a private project: creating a task there with another `owner_id`, reassigning a task in it to another owner, moving another person's task into it, or restoring a trashed task there whose owner differs. The message names the count only, never titles or people.

**The catch-all project** is an ordinary project row with a fixed id (`config.catch_all_project_id`, default `general`), created by `npm run migrate` if missing, owned by the system principal (`owner_id: "system"`), and exposed as `catch_all_project_id` in `/api/config`. It is always public and always present: `PATCH` with `private: true` or a new `owner_id`, and `DELETE`, return `400 invalid_state`. Its name, description, status, and tags are editable like any project. `POST /api/tasks` without `project_id` files the task there.

**Import from Markdown.** `POST /api/projects/import` reads exactly what `GET /api/projects/:id/export.md` writes (section 8; an older export that says "Guestbook" is read too) and creates the project and its tasks in one transaction, each with its own `create` activity entry by the caller, so a failure halfway creates nothing. Tags are matched or created by name. An owner name in the file maps to a person only when exactly one person the caller may pick (`GET /api/people`) has exactly that name; otherwise the item goes to the caller, and a note says how many did. Statuses must be configured ones; a bad one is `400` naming the field and the line. An item the file marks `Private: yes` stays private (and so belongs to the caller; a private project makes every task in it the caller's and private too); an item marked public follows `privacy.default_private`, or `?private=true` makes everything private to the caller. Nothing an export marked private is ever made public by importing it. Limits: `limits.max_page_size` tasks per file, 20 tags on one item, 50 new tag names per import, 20,000 characters per line; a file with two `## Tasks` lines (a description can contain one) is refused naming the line, since the import will not guess which is the real one. A `charset` other than UTF-8 is 415. Tokens may import over HTTP like any write; the missing MCP tool is about Claude seeing each item it creates, not about what a token may do. Tag names are a shared vocabulary, so a note says how many new ones a private import would still create for everyone to see. Owner names are matched against the caller's own `GET /api/people`, so a token, which gets no directory, matches fewer names than its owner in the browser. Comments are never imported, because a comment is signed by whoever writes it and a file cannot sign for anyone; the response says how many were left out. Hits, created and updated dates come from the import, not the file. No MCP tool: Claude already creates projects and tasks one by one with `create`, and a file-shaped bulk write adds nothing but a way to create many things at once without the user seeing each.

**Hit counter semantics:** only the UI project page calls `/hit`, once per page load after the project has loaded. `GET` never increments. Token principals get 403, so MCP reads never count. On a private project a non-owner gets the standard 404 and the count does not move. Not version-checked, not logged, does not touch `updated_at` or `version`. Privacy flips do not reset the count.

**Activity for me:** `for=me` keeps only entries written by someone other than the caller about a project or task the caller owns now, or about a comment on one (`owner_id` at read time, not when the entry was written; tag entries never match). Visibility is the same read-time rule as the rest of the feed, so an item that goes private to someone else drops out along with its history. It combines with the other filters and the cursor. Any other value of `for` is 400.

**Comments.** A comment has no privacy of its own: it is visible exactly when its parent is, through every route, so a non-owner reaching a comment on a private item, or a comment's guestbook route on one, gets the same 404 as a missing id. A project that goes private takes its guestbook with it, including from the people who wrote in it, who then get 404 trashing their own comments too; a task moved to the catch-all by that flip keeps its comments. Reassigning a private item hands its guestbook to the new owner, the previous owner's comments included. Anyone who may edit can sign a visible, live parent, up to 500 live comments per parent (then `400 invalid_state` "This item has as many comments as it can hold.", for restores too); signing is not an edit of the parent (its `version` and `updated_at` stay). Only the author can trash or restore a comment, each a compare-and-set on the comment's `version` with an activity entry; trashing needs no edit rights (an author who lost them can still take their words back), restoring does; nobody edits one and nothing hard-deletes one. A trashed comment shows only to its author, in the parent's guestbook, until restored; `GET /api/trash` does not list comments. Trashing the parent does not trash its comments, but closes the guestbook: no new comments, and no restores until the parent is back (the 400 message names what is in the trash, the task or its project). A trashed comment's activity entries remain. `GET /api/search` does not look in comments. The export lists live comments under their task and in a `## Comments` section (section 8).

**Comment activity entries** have `item_type: "comment"`, `item_id` the comment id, `action` `create`, `trash`, or `restore`, and `changes: {"on": {"type": "project"|"task", "id": "…"}}` naming the parent. `item_title` is the parent's title and `project_id` the parent's project (the project itself for a project comment). An entry never carries the comment's text. The `project` filter includes comments on the project and on its tasks.

**Activity cursor:** opaque base64 of `created_at|id`; the query is `created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC`.

**Password sign-in** (provider `password`). Users live in the `users` table and are managed with `npm run users` (no API route creates, lists, or disables them). `POST /api/login` lowercases and trims `username`, which is the user id; `password` is 1–200 characters there (new passwords: 10–200, counted in characters, not bytes). An unknown user, a wrong password, and a disabled account get the same 401 body, and an unknown or disabled user still costs one password hash, so neither the body nor the timing tells which names exist. The cookie is `<auth.password.cookie_name>=<value>;` (default name `__Host-taskscape_session`) Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=<session_days × 86400>`; the value is 32 random bytes (base64url) and only its SHA-256 is stored. A session is valid until a fixed `expires_at` (`session_days` after sign-in; use does not extend it), while the user is not disabled, and until logout, a password change elsewhere, or `npm run users -- passwd|disable`. `passwd` and `disable` also revoke the user's MCP tokens. Under this provider a Bearer token is valid only while a `users` row exists for its `user_id` and is not disabled. Failed sign-ins are counted per lowercased username, existing or not: 5 within 15 minutes lock that name for 15 minutes (429, even for the right password); a success clears the count. Failed current-password checks on `/api/me/password` have their own count per account, so failed sign-ins cannot block a signed-in user's change. When the count table is full of names with recent failures, new names get 429 too rather than evicting anyone. At most 2 password hashes run at once, with up to 16 waiting; beyond that the answer is 503. Counts and the hash limit are in memory, per process. `/api/me/password` answers a wrong current password with 400, not 401, so a 401 from it always means the session ended.

**Token auth:** `Authorization: Bearer tsk_…` is authoritative when present (invalid → 401, never falls back to headers). Token writes must send `X-Taskscape-Session` (→ 400 otherwise); it is recorded on the activity entry with `via: "mcp"`.

## 7. `GET /api/config` (public subset)

```json
{ "site_title": "Taskscape",
  "statuses": { "project": ["Planned","Active","On hold","Done"], "task": ["To do","Doing","Blocked","Done"] },
  "closed_statuses": { "project": ["Done"], "task": ["Done"] },
  "default_status": { "project": "Planned", "task": "To do" },
  "tag_palette": ["#000080","#008000","#800000","#808000","#800080","#008080","#ff0000","#0000ff"],
  "task_fields": ["title","status","owner","due_date","tags","private"],
  "default_views": { "tasks": { "sort": "due_date", "dir": "asc" } },
  "privacy": { "default_private": false },
  "permissions": { "edit": "everyone" },
  "webring": [],
  "limits": { "page_size": 500, "max_page_size": 1000, "body_bytes": 262144 },
  "catch_all_project_id": "general",
  "theme": "toolbar",
  "themes": ["toolbar", "netscape"],
  "preference_defaults": { "comments_label": "Comments", "shortcuts": true, "time_zone": "UTC" },
  "auth": { "provider": "dev", "dev_users": [ { "id": "alice", "name": "Alice Lin" } ] } }
```

`theme` is the site's default look and `themes` the ones a person may pick on their profile page; each is `public/css/theme-<name>.css`, checked at startup. `preference_defaults` are what `Preferences` fall back to.

`auth.provider` is `"dev"`, `"headers"`, or `"password"`. `auth.dev_users` appears only with the dev provider. Header names, anything under `auth.headers`, and `auth.password` settings are never exposed. A signed-out page cannot read `/api/config`; it uses `GET /api/login` for the provider and site title.

## 8. Markdown export format

```
# <name>

| Field | Value |
| --- | --- |
| Status | Active |
| Owner | Alice Lin |
| Private | no |
| Hits | 1337 |
| Tags | web, q4 |
| Created | 2026-10-31 |
| Updated | 2026-10-31 |

<description, raw block>

## Tasks

| Title | Status | Owner | Due | Tags | Private |
| --- | --- | --- | --- | --- | --- |
| Fix broken GIFs | To do | Alice Lin | 2026-10-30 | bug | no |

### Fix broken GIFs

<notes, raw block>

Comments:

**Bob Ortiz**, 2026-10-31:

> Love the GIFs!

## Comments

**Carol Nkemelu**, 2026-10-31:

> Signed!
> Second line.

---
Exported from Taskscape on 2026-10-31 by Alice Lin.
```

Table cells escape `|` as `\|` and collapse newlines to spaces; headings collapse newlines. Description and notes are raw blocks: the export is for humans and is never rendered by Taskscape. A bare `\r` counts as a line break everywhere, as in CommonMark. Comments are quote blocks (every line prefixed `> `, so none can start a heading; every `[` escaped, so none can define a link; and every `<` and `&` escaped, so raw HTML and autolinks show as text), with the author's name, like the footer's, escaped as Markdown text; oldest first, live ones only, even for their author; a task gets a `###` section when it has notes or comments, and `## Comments` appears only when the project has comments. Only tasks visible to the caller are included; the footer does not mention omissions.

## 9. Changes

Frozen at the end of Phase 1. Any later change gets a dated entry here and a matching update to the MCP tools, the UI, and CLAUDE.md.

- 2026-10-31: frozen as implemented in Phase 1 (API version 0.1).
- 2026-10-31 (privacy review): `moved_tasks` counts only tasks visible to the caller; in activity entries, a `project_id` value inside `changes` is `null` when that project is not visible to the caller (its current project on the entry itself is always visible, since the task is).
- 2026-10-31 (review fixes, no route changes): `owner_name` is accepted only together with `owner_id` (400 otherwise); an `Authorization` header that is present but not a Bearer token is 401; a body over the limit is cut off while streaming (413) even without `Content-Length`; `DELETE /api/tokens/:id` works for a user who has lost edit rights; a token's edit rights follow the groups snapshotted at issue time; malformed percent-escapes in a path are 404.
- 2026-10-31: clarifications only, no behaviour change: validation runs before the version check, so a stale `version` sent together with an invalid field returns 400, not 409; `moved_tasks` is present (possibly 0) whenever a PATCH turned `private` on or changed the owner of a private project, and never otherwise; the 409 `current` body never carries `moved_tasks`; the catch-all project's `owner_name` is "Taskscape"; the `{items, limit, offset}` list envelope applies to projects and tasks, while tags, people, trash, search, and tokens use the shapes shown in their rows; from the MCP tools `include_trashed` is a boolean, so `only` is reachable from the UI and raw HTTP only.
- 2026-11-01: built-in password sign-in. New provider value `password` (`Me.auth` and `/api/config` `auth.provider`); new routes `GET /api/login` (all providers, unauthenticated), `POST /api/login`, `POST /api/logout`, `POST /api/me/password`; new error codes 415 `unsupported_media_type` and 429 `too_many_requests`; cookie sessions and login/logout refuse cross-site (`Sec-Fetch-Site`) and non-JSON writes. Migration `002_password_auth.sql` adds `users` and `sessions`. Nothing changes for the `dev` and `headers` providers or for Bearer tokens. No MCP tool: every new route is unauthenticated or human-only.
- 2026-11-01 (security review): the cross-site write checks (`Sec-Fetch-Site`, JSON-only bodies) apply to every browser principal (`dev` and `headers` too), not only password sessions; Bearer tokens stay exempt. Under the `password` provider a token needs a live `users` row. `POST /api/me/password` takes optional `revoke_tokens`, and its failed checks count separately from sign-in. New 503 `unavailable` when too many password checks are waiting. The default session cookie name is `__Host-taskscape_session`.
- 2026-11-01 (one theme): `theme` is gone from `/api/config` and `GET /api/login`, and from `taskscape.config.json`; the UI has a single look (`css/theme-toolbar.css`), linked directly by every page.
- 2026-11-01 (review fixes): a request that changes nothing is not a write (section 1): tag attach of an attached tag, detach of an absent one, and a `PATCH` matching the stored values check `version` but no longer increment it or write an activity entry. When the owner's stored name differs from their current one, a `PATCH` by the owner refreshes it and that counts as a change. The MCP `tag` tool takes each step's version from the returned record, so an unchanged step threads correctly.
- 2026-11-01 (review fixes): `GET /api/people` also lists the server's directory: every enabled `users` row under `password` (configured dev users were already listed under `dev`); `system` is never listed. When `owner_id` names someone in the directory, the server uses the directory's name and `owner_name` becomes optional; under `password` an `owner_id` outside the directory (other than the caller's own) is 400; under `headers` `owner_name` is still required. `owner_id: "system"` is refused under every provider. MCP `create`/`update` describe `owner_name` accordingly; the UI keeps sending it.
- 2026-11-01 (review fixes): an `offset` above 2^53 − 1 is a 400 `validation_failed` on `offset`; it was a 500. The MCP list tools take no `offset`, so they are unchanged.
- 2026-11-01 (review fixes): `GET /api/config` also returns `limits.max_page_size`, so the UI can ask for the largest page (the overdue count, the task table's "Move to project" list) without guessing. (2026-11-02: and `limits.body_bytes`, so the import page can refuse a file that is too big before uploading it.)
- 2026-11-01 (review fixes): `GET /api/activity` takes `for=me`: entries by others about the projects and tasks the caller owns now, under the same visibility. The MCP server has no activity tool, so nothing changes there: the feed carries other people's free text and names, and the eight tools stay as they are.
- 2026-11-01 (review fixes): guestbook comments. New Comment shape and routes `GET`/`POST /api/projects/:id/comments`, `GET`/`POST /api/tasks/:id/comments`, `DELETE /api/comments/:id`, and `POST /api/comments/:id/restore`; visibility follows the parent; only the author trashes or restores; no edit and no hard delete. Activity gains `item_type: "comment"` (entries name the parent in `changes.on`, never the text), which `item_type`, `project`, and `for=me` filter on. The export lists live comments. Migrations `003_comments.sql` and `004_activity_comment_type` (one file per dialect) add the table and widen the activity `item_type` check. MCP: `get` returns a `comments` array, a new `comment` tool signs a guestbook, and `delete` and `restore` take `type: "comment"` for one's own comment, one id per call.
- 2026-11-01 (security review): the export treats a bare `\r` as a line break in table cells and headings (a title containing one could start a new line), and escapes Markdown punctuation in the footer's user name. Comment bodies are stored with `\n` line breaks.
- 2026-11-01 (branch review): reassigning a private project makes the moved tasks private (they were hidden by the project; the move entry records it); a `PATCH` that makes an item private while handing it to someone else is `400 invalid_state`, as create already was; `GET /api/people` gives the directory only to editors in the browser; a guestbook holds at most 500 live comments; `DELETE /api/comments/:id` needs no edit rights; the export escapes `<` and `&` in comments. MCP `get` returns at most the newest 50 comments, with `comments_omitted`.
- 2026-11-02 (profile page): active sign-ins. New Session shape and routes `GET /api/me/sessions`, `DELETE /api/me/sessions` (end every other session), `DELETE /api/me/sessions/:id`; all human-only and only for a password session, 404 otherwise like `/api/me/password`; someone else's session id is the generic 404; the cookie value and its hash are never returned. No MCP tool: a token is not a session and must never be able to end one, the same reason tokens cannot mint tokens.
- 2026-11-02 (task page, no API change): the UI's task links point at `task.html?id=`; the old `project.html#task-<id>` anchors are gone.
- 2026-11-02 (preferences and themes): new Preferences shape, carried in `Me`, with routes `GET /api/me/preferences` (any principal) and `PATCH /api/me/preferences` (human-only, no editor check; `null` resets a field to the site default). Migration `005_preferences.sql` adds the `preferences` table, keyed by principal id under every provider, outside the versioning rule like the auth tables. `GET /api/config` gains `theme`, `themes`, and `preference_defaults`; `GET /api/login` gains `theme` (the site default, for the sign-in page). The export says `Comments:` and `## Comments` where it said `Guestbook:` and `## Guestbook`, and the full-thread message reads "This item has as many comments as it can hold."; the shapes and routes for comments are unchanged. MCP: a new `me` tool returns the token's user with their `time_zone` and `today` in it (the tool, rather than a note in every result, so date context costs one small call and never pads a list); the server instructions and tool descriptions say "comments", not "guestbook". No MCP tool writes preferences: they are personal settings for the browser, and a token setting someone's theme has no use.
- 2026-11-02 (import): `POST /api/projects/import` takes a `text/markdown` export and creates the project and its tasks in one transaction; `?dry_run=true` plans without writing; `?private=true` makes everything private to the caller; comments are counted and never imported; owners map only on an exact, unique name. Browser principals may send `text/markdown` to this one route (a form cannot send that type); every other write stays JSON-only. No MCP tool.
- 2026-11-02 (whole-repo review): `Preferences` gains `chosen`, saying which keys the person set (the browser uses the device's time zone until one is chosen); a stored `time_zone` keeps the name as picked, case fixed; `POST /api/projects/import` is 415 for any body that is not `text/markdown`, from any principal, and reads `Private` in any case (any other non-empty value is a 400 on `private`); the export of a trashed project keeps the tasks that went into the trash with it (not those trashed on their own); creating the same tag from two transactions at once no longer fails on PostgreSQL (the second reads the first's tag).
