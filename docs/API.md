# Taskscape API v0.1

The HTTP contract the UI and the MCP server both use. It is frozen at the end of Phase 1; see the Changes section at the bottom. Design rationale lives in [PLAN.md](PLAN.md).


## 1. Conventions

- Base path `/api`, same origin as the UI. No CORS headers in v0.1.
- Every response is JSON (`application/json; charset=utf-8`) except `export.md`. The API never returns HTML, including on errors. Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Request bodies are JSON, max 256 KB; invalid JSON → 400 `validation_failed`.
- Every route needs an authenticated principal except `GET /api/health`. No principal → 401.
- All writes require edit permission → else 403 `forbidden`.
- `version` is an integer starting at 1. Every write that touches a record (`PATCH`, `DELETE`, restore, tag attach/detach) requires `version` in the body and increments it by 1, updating `updated_at`. Missing `version` → 400.
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
| 401 | `unauthorized` | no principal; unknown/revoked token; unknown dev user. `WWW-Authenticate: Bearer realm="taskscape"` |
| 403 | `forbidden` | non-owner flipping `private`; non-editor writing; token principal on a human-only route |
| 404 | `not_found` | unknown route, unknown id, or an item the caller may not see. Body is always `{"error":{"code":"not_found","message":"Not found."}}` |
| 405 | `method_not_allowed` | known path, wrong method; `Allow` header set |
| 409 | `conflict` | stale `version` (section 3) |
| 413 | `payload_too_large` | body over 256 KB |
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

**Activity entry**
```json
{ "id": "…", "created_at": "…", "actor_id": "bob", "actor_name": "Bob Ortiz", "via": "mcp", "session_id": "3c1d…",
  "item_type": "task", "item_id": "9a2e…", "item_title": "Fix broken GIFs", "project_id": "6f1c…",
  "action": "update", "changes": { "status": { "from": "To do", "to": "Doing" } } }
```

**Token** `{ "id", "label", "token_prefix", "created_at", "last_used_at", "revoked_at" }`.

**Me** `{ "id", "name", "email", "auth": "headers" | "dev" | "token", "can_edit": true }`.

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
| `limit`, `offset` | default `limits.page_size` (500), max 1000 | no total count |

List response: `{ "items": [...], "limit": 500, "offset": 0 }`.

## 6. Routes

| Method | Path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | none | — | `200 {"ok":true}` | |
| GET | `/api/me` | any | — | `200 Me` | 401 |
| GET | `/api/config` | any | — | `200` public config (section 7) | 401 |
| GET | `/api/people` | any | — | `200 {"items":[{"id","name"}]}` derived from items visible to the caller | 401 |
| GET | `/api/projects` | any | query section 5 | `200 {items:[Project]}` | 400 |
| POST | `/api/projects` | any | `{name, description?, status?, owner_id?, owner_name?, private?, tag_ids?}` | `201 Project` | 400, 403 |
| GET | `/api/projects/:id` | any | — | `200 Project` (trashed ones too, with `deleted_at` set) | 404 |
| PATCH | `/api/projects/:id` | any | `{version, name?, description?, status?, owner_id?, owner_name?, private?}` | `200 Project`; when `private` went true the body also has `moved_tasks: n` | 400, 403, 404, 409 |
| DELETE | `/api/projects/:id` | any | `{version}` | `200 Project` (with `deleted_at`) | 400 invalid_state, 404, 409 |
| POST | `/api/projects/:id/restore` | any | `{version}` | `200 Project` | 400 invalid_state, 404, 409 |
| PUT | `/api/projects/:id/tags/:tagId` | any | `{version}` | `200 Project` (idempotent attach) | 404, 409 |
| DELETE | `/api/projects/:id/tags/:tagId` | any | `{version}` | `200 Project` (idempotent detach) | 404, 409 |
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
| GET | `/api/trash` | any | — | `200 {"projects":[Project],"tasks":[Task]}` by `deleted_at` desc; tasks only those with their own `deleted_at` | |
| GET | `/api/activity` | any | `limit` (50, max 200), `before` (cursor), `item_type`, `item_id`, `project`, `actor`, `via` | `200 {"items":[Activity],"next_cursor":"…"\|null}` | 400 |
| GET | `/api/search` | any | `q` (min 2 chars), `limit` (20, max 100) | `200 {"projects":[Project],"tasks":[Task]}` | 400 |
| GET | `/api/tokens` | human | — | `200 {items:[Token]}` own tokens, revoked included | 403 |
| POST | `/api/tokens` | human | `{label}` | `201 {"token": Token, "plaintext": "tsk_…"}`; plaintext never shown again | 400, 403 |
| DELETE | `/api/tokens/:id` | human | — | `200 Token` with `revoked_at` | 404 (not yours = not found) |

**Create defaults:** `status` = `default_status.<type>`; owner = caller; `private` = `privacy.default_private`. If `owner_id` is the caller, `owner_name` is overwritten from the principal; otherwise `owner_name` is required with `owner_id`.

**Privacy rules on write, in order:** (1) load the target through the visibility predicate, else 404; (2) `private` changing and caller is not the owner → 403; (3) compare-and-set on `version`, else 409 (or 404 if no longer visible); (4) reassigning a private item is possible only for the owner, which step 1 guarantees. Creating an item that is private and owned by someone else is `400 invalid_state`. Reassigning a private item to someone else succeeds and returns the record once; every later read by the previous owner is 404. Reassigning a private project to someone else also moves tasks not owned by the new owner to the catch-all, like a privacy flip, and the response carries `moved_tasks`.

**Task in a private project:** visible only if the task and its project are both visible to the caller. Project privacy wins regardless of the task's own flag, for get, list, create (`project_id` must be visible), move, activity, search, export, trash, and tags.

**A private project only contains its owner's tasks.** Setting `private: true` on a project moves, in the same transaction, every task in it (live or trashed) owned by someone else to the catch-all project: `project_id` becomes the catch-all id, the task's `version` increments, and an activity entry `update {"project_id": {"from": "<project id>", "to": "<catch-all id>"}}` is written by the flipping user so the task's owner sees it in What's New. Nothing else on those tasks changes; that move is the only edit a project owner makes to another person's task through this route. The response includes `moved_tasks` (integer). Afterwards the API refuses with `400 invalid_state` any write that would put someone else's task into a private project: creating a task there with another `owner_id`, reassigning a task in it to another owner, moving another person's task into it, or restoring a trashed task there whose owner differs. The message names the count only, never titles or people.

**The catch-all project** is an ordinary project row with a fixed id (`config.catch_all_project_id`, default `general`), created by `npm run migrate` if missing, owned by the system principal (`owner_id: "system"`), and exposed as `catch_all_project_id` in `/api/config`. It is always public and always present: `PATCH` with `private: true` or a new `owner_id`, and `DELETE`, return `400 invalid_state`. Its name, description, status, and tags are editable like any project. `POST /api/tasks` without `project_id` files the task there.

**Hit counter semantics:** only the UI project page calls `/hit`, once per page load after the project has loaded. `GET` never increments. Token principals get 403, so MCP reads never count. On a private project a non-owner gets the standard 404 and the count does not move. Not version-checked, not logged, does not touch `updated_at` or `version`. Privacy flips do not reset the count.

**Activity cursor:** opaque base64 of `created_at|id`; the query is `created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC`.

**Token auth:** `Authorization: Bearer tsk_…` is authoritative when present (invalid → 401, never falls back to headers). Token writes must send `X-Taskscape-Session` (→ 400 otherwise); it is recorded on the activity entry with `via: "mcp"`.

## 7. `GET /api/config` (public subset)

```json
{ "site_title": "Taskscape", "theme": "netscape",
  "statuses": { "project": ["Planned","Active","On hold","Done"], "task": ["To do","Doing","Blocked","Done"] },
  "closed_statuses": { "project": ["Done"], "task": ["Done"] },
  "default_status": { "project": "Planned", "task": "To do" },
  "tag_palette": ["#000080","#008000","#800000","#808000","#800080","#008080","#ff0000","#0000ff"],
  "task_fields": ["title","status","owner","due_date","tags","private"],
  "default_views": { "tasks": { "sort": "due_date", "dir": "asc" } },
  "privacy": { "default_private": false },
  "permissions": { "edit": "everyone" },
  "webring": [],
  "limits": { "page_size": 500 },
  "catch_all_project_id": "general",
  "auth": { "provider": "dev", "dev_users": [ { "id": "alice", "name": "Alice Lin" } ] } }
```

`auth.dev_users` appears only with the dev provider. Header names and anything under `auth.headers` are never exposed.

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

---
Exported from Taskscape on 2026-10-31 by Alice Lin.
```

Table cells escape `|` as `\|` and collapse newlines to spaces; headings collapse newlines. Description and notes are raw blocks: the export is for humans and is never rendered by Taskscape. Only tasks visible to the caller are included; the footer does not mention omissions.

## 9. Changes

Frozen at the end of Phase 1. Any later change gets a dated entry here and a matching update to the MCP tools, the UI, and CLAUDE.md.

- 2026-10-31: frozen as implemented in Phase 1 (API version 0.1).
- 2026-10-31: clarifications only, no behaviour change: validation runs before the version check, so a stale `version` sent together with an invalid field returns 400, not 409; `moved_tasks` is present (possibly 0) whenever a PATCH turned `private` on or changed the owner of a private project, and never otherwise; the 409 `current` body never carries `moved_tasks`; the catch-all project's `owner_name` is "Taskscape"; the `{items, limit, offset}` list envelope applies to projects and tasks, while tags, people, trash, search, and tokens use the shapes shown in their rows; from the MCP tools `include_trashed` is a boolean, so `only` is reachable from the UI and raw HTTP only.
