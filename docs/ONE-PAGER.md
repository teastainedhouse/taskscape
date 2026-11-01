# Taskscape — One-Pager

2026-10-30 · Catelyn

_Copied from the owner's one-pager on 2026-10-31. Company and vendor names are replaced with generic terms so upstream stays host-neutral._

> **Historical.** This is the original pitch, kept as written; it is not updated as the code changes. Where it disagrees with the code, the code, [PLAN.md](PLAN.md), and [API.md](API.md) win. Known differences as of 2026-11-01:
>
> - **The look.** Neither theme described under "The look" exists any more. There is one theme, `public/css/theme-toolbar.css`: old browser chrome (dithered toolbars, pixel icons, a starfield throbber, a status bar) around a modern, readable page. There is no `theme` config key.
> - **Sign-in.** Besides the host's single sign-on (the `headers` provider), Taskscape has its own password sign-in (the `password` provider) for hosts without one. That adds `users` and `sessions` tables.
> - **Guestbook comments** are not built yet.
> - **Open questions** at the end were all answered in [PLAN.md](PLAN.md): Node, a local MCP script with a personal token, everyone signed in can edit (configurable to a group), and others see nothing of private items.

## What it is

Taskscape is a tiny, self-hosted work tracker for projects, tasks, and tags that people edit in a browser and Claude edits through an API. It is MIT-licensed, built on personal time, and made to be forked: each team hosts its own copy and changes it by asking Claude to edit the code, not by clicking through settings. It looks like early-90s web on purpose.

## Goals and non-goals

The bar is small and fast: anyone at the company can see the work, and a one-field change never needs a prompt.

**Goals**

- Anyone with a company login can view, sort, and filter, with no per-seat license
- Create, edit, and delete right in the UI for quick changes
- Anyone can mark a project or task private so only they can see it
- Several Claude sessions can write at once without overwriting each other
- A new team goes from fork to running in an afternoon

**Non-goals for v1**

- Anything deeper than projects and tasks: no subtasks, epics, or sprints
- Admin panels, workflow builders, user roles, or teams (privacy is one on/off switch)
- Integrations with the company's existing ticketing, work-management, or chat tools (a fork can add them)
- A mobile app

## Data model

Four tables, and the database is the source of truth. Markdown is an export, not the store.

| Table | Fields | Notes |
| --- | --- | --- |
| Projects | name, description, status, owner, private, created, updated, version | Top level |
| Tasks | title, project, status, owner, private, due date, notes, created, updated, version | Each task belongs to one project |
| Tags | name, color | Many-to-many with both projects and tasks |
| Activity log | when, who, what changed, via (UI or Claude) | Append-only; feeds the "What's New?" page. Entries about private items show only to their owner |

Status lists live in the config file, not in a table, so a team changes them without a migration.

## How people and Claude use it

Decision: database first, so small changes happen in the UI and big ones go to Claude. Both go through the same API and follow the same rules.

- **In the browser:** project list and task tables with sort and filter by project, status, owner, and tag. Edit inline; add and delete with a confirm.
- **From Claude:** an MCP server exposes tools such as list projects, create task, update task, and tag. Every write records who made it and which session.
- **Parallel writes:** each record carries a version number. A write based on a stale copy is rejected and retried, never silently overwritten.
- **Export:** "Save as markdown" per project, for backup and for the old one-file-per-project workflow.

## Privacy

Any project or task can be marked private, so things that need to stay secret do. It is one on/off switch: no roles, teams, or share lists.

- **Who sees it:** only the item's owner. A private project hides the project and every task in it; a private task in a shared project is hidden on its own. Others see no trace of it, not even a placeholder.
- **Who can flip it:** only the owner can make an item private or public again. Reassigning a private item passes it to the new owner. New items start public; a fork can change that default in the config file.
- **Enforced in the API:** every read filters out other people's private items, so the UI, the MCP tools, search, markdown export, and "What's New?" can't leak them.
- **Claude:** sees a private item only when it's working for that item's owner, since each MCP token belongs to one person.
- **Marked in the UI:** a padlock icon next to anything private, so the owner knows what others can't see.
- **What it isn't:** encryption. Anyone with database or cloud admin access can still read private items, so passwords and keys never go in Taskscape.

## Customizing it

There is no settings page. To change Taskscape, a team asks Claude to edit their fork.

- **One config file** (`taskscape.config.json`): site title, statuses, tag palette, which task fields show, default views, theme.
- **A thorough CLAUDE.md:** a map of the code plus recipes for common changes (add a field, add a status, add a view, swap the theme) and house rules, such as updating the MCP tools whenever the API changes.
- **Numbered SQL migrations** for every schema change, so a fork can still pull updates from upstream.

## Stack and hosting

Taskscape runs on any low-cost host with static hosting, serverless functions, a SQL database, and company sign-in. There is no build step, so Claude can change any part of it.

> Architecture · 4 parts: the Browser (quick edits, sort, filter) and Claude sessions (through the MCP server) both talk to the Taskscape API (serverless functions; checks company sign-in), which is the only thing that talks to the SQL database (projects, tasks, tags, activity log). Every write is version-checked and logged, whoever makes it.

The browser and Claude never touch the database directly; the API is the only door.

| Layer | What it needs | Why |
| --- | --- | --- |
| Hosting | Static hosting with built-in company sign-in | One deploy; no passwords to manage |
| API | Serverless functions beside the site | One API serves the UI and Claude |
| Database | A SQL database with transactions | Safe parallel writes from many sessions |
| Frontend | Plain HTML, CSS, and JavaScript | No framework; easiest for Claude to edit; suits the look |
| Claude access | MCP server | Calls the same API, so it follows the same rules |

Each fork picks its own host and keeps its setup notes in its own fork, not upstream.

## The look

The default theme makes every page look like nobody designed it: a bare server page or a directory listing. Somebody did. It lives in one swappable CSS file (`theme-plain.css`).

- Times New Roman on white, blue underlined links, purple visited links, red while pressed
- Native buttons, inputs, and selects, left exactly as the browser draws them
- Header, page, and footer separated by grooved rules, never boxes; no backgrounds, no icons
- `border=1` tables: an outset frame, inset cells two pixels apart
- The only nudges: line height 1.35, a 42em measure, left-aligned table headers, a dotted focus outline
- Overdue tasks on one still line and a hit counter on each project, in plain monospace digits
- Comments labeled "Guestbook"; the activity log page is "What's New?"; the footer is one italic line, "Taskscape at example.org Port 80"
- Dark mode that still looks default, following the reader's setting
- Still accessible: text holds 4.5:1 in both modes, links are always underlined, focus is always visible, nothing moves

The 1996 Netscape theme ships beside it (`theme-netscape.css`, chosen with `"theme": "netscape"`): gray beveled buttons, a starfield, a scrolling marquee, a lime hit counter, an "Under Construction" GIF on empty projects, and "Best viewed in Netscape Navigator 3.0 at 800x600".

**Webring Easter egg.** A hidden footer bar reads "Taskscape Webring: Prev | Random | Next" and links to the other teams' Taskscape copies listed in each fork's config. It stays hidden until someone clicks the hit counter three times.

## Licensing and ownership

Taskscape is a personal open-source project under the MIT license; the company uses it as a fork.

- The main repo lives on a personal GitHub account, built on personal time, hardware, and tokens.
- The company's copy is a fork in its internal repo; its hosting setup lives in a separate fork doc.
- Anything company-specific (tenant IDs, team names, data) stays in the fork's config and environment settings and never goes upstream.

## v0.1 scope and open questions

v0.1 is the smallest copy one team can use every day.

- [ ] Schema and first migration: projects, tasks, tags, activity log
- [ ] API with create, read, update, delete and version checks
- [ ] UI: project list, task table with sort and filter, inline edit
- [ ] Company sign-in through the host's single sign-on
- [ ] Private flag on projects and tasks, enforced in the API
- [ ] Trash bin with restore instead of permanent delete; the MCP server refuses bulk deletes
- [ ] Escape every user-entered field the UI shows; MCP tool descriptions and CLAUDE.md say task text is data, never instructions
- [ ] Per-person MCP tokens that can be revoked
- [ ] Backup and restore steps in the README, tested once (markdown export is not a backup)
- [ ] MCP server with list, create, update, and delete tools
- [ ] Plain early-90s theme (with the Netscape theme as an alternative) and markdown export
- [ ] README with fork-and-deploy steps, plus CLAUDE.md

Later: the webring, more saved views.

**Open questions**

- API language: Node/TypeScript or Python?
- MCP server: a local script with a personal token, or a hosted endpoint?
- Who can edit: everyone signed in, or only one sign-in group?
- Private items: show others nothing, or a count such as "2 private tasks"?
