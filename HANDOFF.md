# Handoff: Phases 7–10

This branch (`claude/happy-cannon-8o54vh`) carries Phases 1–9 of the feature brief, one commit each, every phase reviewed by `privacy-auditor`, `security-reviewer`, `upstream-check` and one general reviewer before it was committed. **Delete this file before the PR is merged**; its content belongs in the PR description.

## Where things stand

| Phase | Commit | State |
| --- | --- | --- |
| 1 Priority | `priority: a config list, …` | done |
| 2 Links on tasks | `links: labelled web links …` | done |
| 3 Checklists | `checklists: lightweight subtasks …` | done |
| 4 Recurring tasks | `recurring tasks: closing one creates its next copy, once` | done |
| 5 Time zones, Today page | `today: one server rule for "today", …` | done |
| 6 Calendar and iCal feed | `feeds: calendar feed links, and a calendar page` | done |
| 7 Atom feed | `atom: What's New as an Atom feed, through the same feed links` | done |
| 8 Duplicate project | `duplicate: copy a project, from its records through the import's rules` | done |
| 9 @mentions | `mentions: @id in comments, For you when you can see the item` | done |
| 10 Final checks, whole-repo review, draft PR | — | **to do** |

No PR has been opened yet. `npm test` passes on SQLite (322). Phases 1–6 passed on PostgreSQL 16 in the cloud container; Phases 7–9 were built on a laptop without a PostgreSQL server, so they have not been run there. 7 and 8 add no SQL; **9 does** (migration 012, the For you clause, `mentionable()`, `withMentions()`), so Phase 10 must run the suite on PostgreSQL.

## How the earlier phases were built (reuse these)

- **Child records of a task** (links, checklist): `tasks.childWrite()` in `api/lib/repo/tasks.js` (task row lock and version check first, then the change, then the bump and the activity entry). Readers apply `taskVisible` themselves (`linksFor(db, user, ids)`). Recipe: "Add a child record to tasks" in CLAUDE.md.
- **One "today"**: `todayFor()` in `api/lib/repo/preferences.js`; `Me.today`; `due=overdue|today|week` on `GET /api/tasks`.
- **Feed tokens**: `api/lib/repo/feeds.js` (`lookup()` returns the link's id, a read-only principal and the scope), `api/handlers/feeds.js` (`feedPrincipal()`, `feedResponse()` with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` and a sandboxing CSP, `publicBase()`), `calendar.ics` and `activity.atom` (`api/lib/atom.js`: `xmlText()` is the one XML escape).
- **Export/import**: `renderProjectExport()` writes priority, Repeats, `Links:` and `Checklist:` blocks; `parseProjectExport()` reads them; `planImport()`/`runImport()` create through `createIn()` (which takes `links` and `checklist` from internal callers only).
- **Task ids between tasks** (`recurred_from`/`recurred_to`) are returned only when visible (`visibleTaskRef()` in `visibility.js`), and activity nulls hidden task and project ids at read time (`hideInvisibleTaskIds()` in `repo/activity.js`). Mentions (Phase 9) need the same care, and For you is now also the Atom feed's `mine` scope, so a mention added to `for_me` in `activity.list()` reaches the feed too (test both).
- **Duplicate** (Phase 8): `planDuplicate()` in `api/lib/import.js` builds the parser's shape from records and hands it to `planParsed()`, the planner the import shares. Never round-trip other people's text through the Markdown export: it matches sections to tasks by title (see the Phase 8 review below).
- **The MCP server refuses `.` and `..` as ids** (URL dot segments); keep that for any new id argument.

## Environment notes (cloud container)

- PostgreSQL 16 is installed: `pg_ctlcluster 16 main start`, then `TASKSCAPE_TEST_POSTGRES_URL='postgres://user:password@localhost:5432/taskscape_test'` with `--test-concurrency=1` (an earlier reviewer set the `postgres` password to `pw` and created `taskscape_test`). `npm install` is needed for `pg`.
- Playwright and Chromium are installed. The sweeps used a small script: for each page, light and dark, 1100px and 375px, screenshot, console errors, page-level horizontal overflow, and a 60-step Tab walk checking each stop has a name and a visible focus style; plus per-feature keyboard scripts. Run the dev server on a scratch SQLite file (`TASKSCAPE_DATABASE_URL=sqlite:/tmp/x.db npm run seed`, then `PORT=3111 node scripts/dev.js`).
- When killing the dev server with `pkill -f`, use a pattern that cannot match the shell's own command line (`pgrep -f "[n]ode scripts/dev.js"`).

## The remaining phases (from the brief)

**Phase 7: Atom feed of What's New.** `GET /api/feeds/:token/activity.atom` uses the same feed tokens. "My tasks" scope gives the For you entries; "everything" gives all activity the owner can see. Build the XML with one escaping function and test it with hostile text. Stable entry ids (`urn:uuid:` plus the activity id), item links, and `updated` timestamps. The same read-time visibility as `/api/activity`. The privacy reviewer must confirm that nothing private reaches a feed token whose owner couldn't see it.

**Phase 8: duplicate project and templates.** `POST /api/projects/:id/duplicate` with an optional new name, using the Markdown export and import code. Options: reset statuses to the default; then keep due dates, shift them by N days, or clear them. Copy tasks, tags, links, unticked checklists, priorities and recurrence. Never copy comments. One transaction, with activity for everything created. A "Duplicate" button on the project page. Document in the README that a template is just an exported `.md` file you import. MCP: add a `duplicate` tool, or document why not.

**Phase 9: @mentions in comments.** Typing `@` in the comment box offers a small listbox of people from `/api/people`, keyboard-accessible, following the ARIA combobox pattern; typing a username directly also works. Store mentions in a new table, written in the same transaction as the comment. For you (`for=me` activity) includes comments that mention you. A mention never grants access: if the mentioned person can't see the item, nothing reaches them (no title, no activity, no unread count); the privacy reviewer must confirm this. Show mentions highlighted in comment text by splitting the text into spans, `textContent` only. MCP comments can mention people too.

**Phase 10: final checks and whole-repo review.** Accessibility sweep of every new page and control (both themes, light and dark, phone width, keyboard only). Run the full suite on PostgreSQL. Run `privacy-auditor`, `security-reviewer` and `upstream-check` (opus for the first two) over the whole repo, plus one general-purpose opus reviewer for correctness. Check each finding and fix the real ones in their own commit. Then open **one draft PR** with: what changed, phase by phase; decisions to check; review findings (fixed and dismissed, with reasons); what wasn't verified; suggested follow-ups.

Standing rules from the brief: every Agent call sets `model` ("opus" for reviewers and design-heavy work, "sonnet" for searching, mechanical sweeps and `upstream-check`); commit once per phase after the reviewers; `npm test` on SQLite before every commit; never push to main, merge or deploy; keep the CLAUDE.md code map and recipes current and record decisions in docs/PLAN.md; every new task field or child record goes through export/import (round-trip test), search where it makes sense, and MCP; extend the seed.

## Decisions to check (so far)

1. **Priority** sorts in config order with leftover names, then none, last in either direction; status and priority names may not contain commas or edge spaces (list filters split on commas); an empty `priorities` list turns the feature off.
2. **Links and checklist items** are trashed on removal but have **no restore route** (the activity entry keeps the text). Caps: 50 links, 100 items. URLs are stored as the URL parser writes them (backslash as `%5C`), credentials refused; labels refuse bidi and line-separator characters; a labelled link shows its host.
3. **Ticking every checklist item does not close the task.**
4. **Recurrence**: no interval ("every 2 weeks"); the next due date moves from the old due date even when closed late; one copy per task ever (reopen/close, or a trashed copy, makes none); the copy keeps the owner when someone else closes; no copy when the project is in the trash, or when a private task is handed over and closed in one write; a non-owner closing an undated task sees the day in the owner's zone (the brief asks for the owner's zone).
5. **Today/overdue** now follow the server: the person's chosen zone, else the **site default**, not the device's (timestamps still show in the device's zone). `due=today|week` do not exclude closed tasks; `overdue` does.
6. **Home page**: `today.html`; the project list moved to `projects.html`; `index.html` is gone with **no forwarding page** (the brief asked for no shims); the dev server serves `today.html` at `/`, and README tells hosts to set it as the directory index.
7. `closed_at` is not backfilled for tasks closed before migration 010.
8. "Changed by Claude since your last visit": "last visit" is per browser (localStorage), like For you; in "Assigned to you" it shows Claude acting for you (`actor=me`), in "Everything" all visible `via=mcp` entries.
9. **Calendar feed**: closed tasks are left out (not marked done); a 90-day lookback, nearest first, capped at `limits.max_page_size`; production refuses to start without an https `public_url`; read-only accounts may make feed links; `revoke_tokens` on a password change also revokes feed links. No MCP tool manages feed links.
10. The MCP `me` tool now also returns statuses, closed statuses and priorities, and the server's `today`.
11. Pre-existing: the `netscape` theme name vs house rule 9 (a browser brand); a reviewer flagged it, nothing was changed.
12. **Atom feed**: the newest 50 entries, no paging (a reader keeps what it has seen); `mine` is For you (others' changes to what you own), not your own task changes, unlike the calendar's `mine`; the profile's scope option now reads "Mine (my tasks, For you)". Entries are plain text. The feed says less than the page in two places: an unlabelled link is named by its host (task links are often shared-document URLs with a key), and moves say "another project". It always says "comment", not the owner's Guestbook preference. Both feeds now send `Content-Security-Policy: default-src 'none'; sandbox`.
13. What's New (page and feed) no longer says "it repeats, so the next one was created" when the reader cannot see the copy.
14. **Duplicate is not a Markdown round trip** (the brief said "using the Markdown export and import code"): it uses the import's planner and writer and the export's reads, but builds the plan from the records, because the text round trip leaked private notes onto public copies (Phase 8 review). The copy is the caller's; tasks keep their owners by id unless private (then the caller's); `default_private` makes a copy private with every task the caller's, as for an import. API defaults: statuses kept, dates kept; the button's form starts with "Reset statuses" ticked. Refused: a trashed project, more live tasks than `max_page_size`, more text than 4 × `body_bytes`. The response carries every created Task (the MCP tool returns only a count). There is an MCP `duplicate` tool (PLAN.md says why, unlike import).
15. **@mentions**: `@id`, resolved only among the people the author may pick on `/api/people` (so a token never resolves the directory); a directory id first (exactly, then ignoring case), anyone else exactly; a comment's stored mentions (ids, names) show to every reader of the comment, even one with no directory (the author chose to name them); trailing punctuation belongs to the sentence unless the id has it. Stored even when the person cannot see the item (refusing would tell the author something); reaches them only through For you under read-time visibility; a trashed comment's mention reaches nobody. At most 20 people per comment, later names stay text (no 400). The comment box is a textarea, so it follows the combobox pattern with textbox + `aria-autocomplete`/`aria-activedescendant` (HTML forbids `role=combobox` on a textarea); Enter picks, Tab leaves. Under `headers` a mention's stored name is the newest visible owner_name, which a client can set (owner names are client-supplied under `headers`, pre-existing).

## Review findings so far

## Phase 1 (priority)
Fixed:
- privacy-auditor: a priority removed from the config sorted first under dir=desc; now configured, then leftover, then none, either direction (test).
- security-reviewer: names with commas/edge spaces could never match a list filter; config now refuses them for priorities and statuses (test). What's New label for priority.
- general: sort=priority with `priorities: []` was a 500 (ORDER BY 0); statusOrder's empty fallback is now NULL (test). Recipe in CLAUDE.md now covers sort/filter plumbing, the export sample and tests, the import preview; docs no longer say leftovers sort "like a status"; PLAN §8 editable cells; import preview shows priority; parser test covers the column; README/API note the naming rule.
Dismissed:
- general: no filter for "no priority" / leftover names ignored by the filter — same as status filters; a `none` token could clash with a priority named "none". Follow-up.
- general: MCP list_tasks has no sort argument — pre-existing; Claude gets results it can sort itself.
- general: on a site with `priorities: []` an export carrying priorities is refused per task — consistent with unknown statuses; the error names field and line.
- upstream-check: none. Note on the "netscape" theme name is pre-existing (listed under decisions to check).

## Phase 2 (links)
Fixed:
- security (medium): MCP `link` with link_id ".." collapsed the URL to DELETE /api/tasks/:id and trashed the task. The MCP server now refuses "." / ".." (and %2e forms) as id, link_id, item_id before any request (test).
- security: notes starting with a "Links:" block became links on export+import; the export now writes every block (empty as "_None._") when the notes start with a block label, and the import reads one block only (test).
- security: DATA_NOTICE names link labels and URLs.
- security: a backslash in a URL closed the export's <...> early in other viewers; stored as %5C.
- security: labels refuse bidi overrides/isolates; the page shows the host beside a labelled link.
- security: import measured label length before trimming; now after, like the API.
- privacy: links.linksFor and insertIn were exported and skipped the visibility predicate (rule 3); both now apply taskVisible themselves (unsafeGet reads links as the task's owner).
Dismissed:
- privacy test gaps 3a–g: behaviour verified correct by the auditor's probe; the most important (public task in a private project) covered by existing project-privacy tests through tasks.list. Not all added.
- upstream-check: none.
- general (medium-high): concurrent link writes deadlocked on PostgreSQL (500): childWrite now takes the task's row lock and checks the version before touching child rows; reviewer's race went from {200:40, 409:8, 500:32} to {200:40, 409:40} on PG16.
- general: sort=priority with no priorities was a 500 on PostgreSQL (constant in ORDER BY); now an expression; full suite passes on PG16.
- general: Move/Remove could send the same version twice on a double press (one write at a time); focus after a move to the top/bottom lands on the other Move button, not the label editor.
- general: `links` is read-only in task bodies; MCP list_tasks q description; CLAUDE.md signatures, house rule 4 names links; PLAN rule 12 and API.md document link changes; dead activity-words case removed; stale comments naming callers that do not exist yet; tests for 403 on read-only accounts, the token session header, and links in the handover response; MCP test title.
Dismissed (general):
- unsafeGet reads links as the task's owner: the private-project invariant guarantees the owner can see the task; an exported unsafe links reader would break rule 3 instead. Documented in a comment.
- concurrency test in the suite: reproduced and fixed with the race script on PostgreSQL; a timing test would be flaky on SQLite (serialised by its mutex).

## Phase 3 (checklists)
Fixed:
- security: U+2028/2029 in item text turned items into notes on re-import (and fake lines in editors); refused in item text and link labels with C1 controls (test).
- security: MCP `checklist` description says to change a checklist only when the user asks.
- security: a checkbox ticked while another write was in flight showed a tick that was never saved; it is now put back with a message.
- security: dead CSS class.
- privacy (test gap): items in a private project, and items written while public then hidden (test).
Dismissed:
- security: exports from before this change could read a leading "Checklist:" list in notes as items — no installation exists yet (not live), so no such files exist.
- privacy: removed items' text stays in activity (same as links, rule 15; visible only with the task) — deliberate, documented.
- upstream-check: none.
- general: (U+2028 and the dropped tick were the same as the security findings, fixed above); the add forms send one request at a time and an empty item says so; Move up/down announce the new place (links too); the import preview counts checklist items and links; MCP q description; API.md create entry, ### rule, PATCH row, import caps; PLAN rule 12; CLAUDE.md task.html line; CSS comment; tests for a trashed task, 403 for read-only, a position past the end, a version-only PATCH.
Dismissed (general): old exports reading a leading "Checklist:" list in notes as items (not live, no such files); unit tests for checklistProgress and the activity wording (UI has no DOM tests by design; checked in the browser).

## Phase 4 (recurring)
Fixed:
- security: a due date near 9999 stored a corrupt next date ("+010000-01") and the next close was a 500; now 400 invalid_state, nothing written (test).
- security: closing in a trashed project failed (the copy's target was refused); now the close goes through with no copy and no recurred_to (test).
- security: handing a private repeating task to someone and closing it in one PATCH failed confusingly; now closed and handed over, no copy (test).
- security: the copy's owner name prefers the directory's current name.
- security: What's New words for recurred_to and recurrence.
Dismissed: none from security beyond test gaps covered above. upstream-check: none.
- privacy (high): recurred_to/recurred_from exposed ids of tasks the reader cannot see (after a privacy flip or a handover of one of the pair): reads now return them only through visibleTaskRef() in visibility.js (test, three scenarios).
- privacy (high): activity entries carried the hidden counterpart's id: hideInvisibleTaskIds() nulls it, like project ids (test).
- privacy: the copy-once check now reads the stored column, so a closer who cannot see the copy cannot create a second one (test).
- privacy: anchorDay reads the series as its owner, so the due date no longer depends on who closes.
Accepted and documented (privacy): a closer who cannot see the copy learns one exists; a non-owner closing an undated task sees the day in the owner's zone; a private predecessor still shapes the anchor day.
- general (medium): a close took the task's row lock before the project's (copy's createIn), the reverse of a project privacy flip: possible PostgreSQL deadlock; a possible copy now locks the project first, and the "project in the trash" check reads the locked row.
- general: years 0000–0099 were computed as 1900s (Date.UTC); setUTCFullYear (test). Unfiltered reads renamed unsafe* (rule 3). The cheap close conditions run before any extra query. The page's "closing it creates the next one" hint only shows on an open task in a live project. PLAN rule 17 and API.md owner name; CLAUDE.md visibility and activity lines. Tests: owner's zone when someone else closes; closed-to-closed; a task created closed or given a repeat after closing.
Dismissed (general): MCP test for the recurrence enum (schema-level, covered by the shared validator tests); a PostgreSQL concurrency test (timing-dependent).

## Phase 5 (today, Today page)
Fixed:
- security: closed_since accepted 2026-02-31 and rolled it into March; now a real day (test).
- security: the sign-in `next` allowlist named calendar.html before it existed (removed; added back with the page in Phase 6).
- security: an edit to a task closed before closed_at existed stamped it with the edit time; staying closed now keeps closed_at as it is.
Dismissed: index.html has no forwarding page (the brief asked for no compatibility shims; README says to set today.html as the directory index). upstream-check: none.
Dismissed (privacy): the owner's zone deciding an undated repeating task's next date shows a non-owner closer the owner's day — the brief asks for the owner's zone; accepted in PLAN rule 17. Added the suggested privacy regression test for the new filters.
- general: MCP `me` now reports the server's today (Me.today), so it agrees with list_tasks `due`; local computation only as a fallback.
- general: the Today page asks every section again after an inline save (a task closed from Overdue moves to Finished at once), focus returns to the value or the section heading; edit keys are per section (a task in two sections had duplicate keys); a generation counter stops a quick scope switch drawing the other scope; "last visit" is the newest entry seen in the server's clock, stored only after the section loaded; "finished" uses seven days before the server's today.
- general: profile time-zone hint; CLAUDE.md config line and "Add a status" recipe (attention_statuses).
Dismissed (general): index.html forwarding page (no shims, per the brief); http.test compares today with the real clock (only at UTC midnight; same pattern as before).

## Phase 6 (feeds, calendar)
Fixed:
- privacy (medium): a feed link made before an account existed came back to life when `users add` created that id; the footprint now counts feed links, so add refuses the id without --claim-existing (test).
- privacy/security: the password-change checkbox and API.md now say it also revokes feed links.
- security (medium): without public_url, links behind a TLS proxy came out as http:// and the token crossed the network in the clear; production now refuses to start without an https public_url (test).
- security: C1 control characters stripped from calendar text.
- general/security/privacy: atom_url was advertised before its route existed; removed from the response, the UI and the docs (Phase 7 adds it).
- general: the cap cut upcoming tasks first; the window starts 90 days back, nearest first. "Open" is now "not in a closed status", as documented (a renamed status still shows). Read-only accounts may make a feed link (it only reads). ?month= must be 01–12. public_url stored normalised. Seed: a feed link for alice (printed) and a task due next month.
Dismissed / not done (budget): general's extra test gaps (DTEND across month/year ends, last_used_at throttling, a task in a trashed project in the feed, passwd on an enabled user's feed) — listed as follow-ups. upstream-check: none.

Second review (one general pass over the Phase 6 commit, after the handoff):
Fixed:
- feed (medium): closed tasks were dropped after the row cap, so on a busy site they could push open tasks out of the calendar feed; the status rule is now in the query (`open: true`, internal to `tasks.list()`, not settable from a request) (test that fails on the old code).
- calendar page: Previous/Next pressed quickly could draw an older month's answer under the newer title; a generation counter, like the Today page.
- calendar page: years 0–99 (`?month=0050-02`) used Date.UTC (read as the 1900s) and an unpadded year the API refused; `setUTCFullYear` and a four-digit year.
- tests: DTEND across month, year and leap-day ends; a task in a trashed project stays out of the feed.
Not changed (decision to check): under the `headers` and `dev` providers there is no account to check, so a feed link keeps working after its owner leaves the identity provider until it is revoked on the profile page; MCP tokens behave the same.

## Phase 7 (Atom feed)
Fixed:
- security: a browser opening a feed renders it on the site's origin; both feeds now send `Content-Security-Policy: default-src 'none'; sandbox` (test).
- security: an unlabelled task link was named by its full URL (often a shared-document URL with a key); the feed names it by host (test). README says the feed carries checklist text, link labels and tag names.
- security: bidi embedding/override/isolate controls let a title reorder the words around it; `xmlText()` drops them (test). The regex is now written with `\u` escapes (it had been saved with literal characters).
- security: the self-link comment said the token was never echoed from the request; reworded (it is the path's token, accepted only in the `tsf_` form).
- privacy (low, pre-existing): "it repeats, so the next one was created" showed when the reader could not see the copy; now only when `recurred_to` is visible, in the feed and on the page (test).
- general: an empty feed had no `<author>`; the feed now has the site as author (test). A test's lone surrogate never reached the escape (storage makes it U+FFFD); replaced with an override character, the helper test covers surrogates. CLAUDE.md test list and `lookup()` line; API.md's `POST /api/feeds` scope wording; "control characters" in the docs (DEL is dropped too).
- privacy/general test gaps added: byte-identical 404 for revoked, unknown and malformed atom links against a missing id elsewhere; a dev-user header or cookie cannot change whose feed it is; `mine` leaves out the owner's own changes through Claude; tag entries link to What's New; a project comment links to the project; hostile link labels, checklist text and tag names; an empty feed through the route.
Dismissed:
- security: typographic quotes around titles (a title can contain any quote; the UI uses straight quotes too).
- security: `entryLink` throws on a lone surrogate in an id: ids come only from `randomUUID()` (`id` is read-only in bodies).
- security: HEAD is 405 and there is no ETag/Last-Modified: readers fall back to a full GET. Follow-up.
- security/privacy (pre-existing, decision to check from Phase 6): under `headers`/`dev` a feed link outlives the person; README now says how to revoke one in the database.
- general: no test tying `describeEntry()` to `activity-words.js` (the UI has no DOM tests by design; the reviewer compared 33 entry shapes by hand and they agree, except the two deliberate differences above). The feed title uses the name saved with the link (same as the calendar). `updated` can move back when the newest entry becomes invisible (fine for a polled feed).
- upstream-check: none.

## Phase 8 (duplicate)
Fixed:
- privacy (high) + security (high) + general (high): the first version rendered the export and re-imported it. Same-title tasks gave a private task's notes, links and checklist to a public copy; a `### <title>` line in notes moved text into another task (or injected links and checklist items into it); an export-footer or comments line in notes silently dropped every later task's notes; a `## Tasks` line in a description or notes made a project impossible to copy; more than 20 tags refused. Now planned from the records through a shared `planParsed()` (tests for each).
- privacy/security/general: owners were matched by display name (stale names, shared names, a decoy owner_name); now by id.
- general: tags were regrouped (a and b came back as "a, b"); now exact.
- security (medium): no byte budget: one duplicate of a project of maxed-out tasks took seconds in one transaction and answered with ~100 MB; now refused above 4 × `body_bytes` of text.
- general: the default name was shortened by code points but checked in UTF-16 units (400 on an emoji name); the button always sent "<name> (copy)" (400 for a 194+ character name): it now sends no name when unchanged, and the server shortens. Escape closes the form; focus returns to the button after a failed copy; the empty-name check comes first.
- docs: API.md (owners, privacy default, budget, errors), PLAN.md (why records, not text; why an MCP tool), README ("default status"), CLAUDE.md code map; MCP name description.
Dismissed:
- privacy/general: the plan reads before the write transaction (a change landing between them is not in the copy; the same as any read before a write). Documented.
- security: names and titles accept control characters (pre-existing, `validateItem`); follow-up.
- security: return only a count instead of every Task: an API contract change for little gain once the budget bounds the answer; the MCP tool already returns a count.
- general: no `maxLength`/`maximum` in the MCP schema (its validator has no such keywords; the API checks and names the field).
- upstream-check: none (it suggested a placeholder for the test password above, done).
Re-audit (privacy-auditor, after the fix): the fix holds on all four points (content stays with its task; owners by id reveal nothing; nothing hidden is read, including by the cap and the budget; the import's 72 differential responses are byte-identical to before). Its stale-wording notes are fixed, and its test gaps added (General, a disabled owner under password, hidden text and the budget).

## Phase 9 (@mentions)
Fixed:
- privacy + security + general: a trashed comment's mention kept notifying (For you entry, unread count, Atom); now only live comments (test).
- privacy + security: tokens could list sign-in usernames by posting `@guess` (mention resolution used the directory for every principal), and the 20-person 400 was a probe that left no trace; now resolution uses exactly what `/api/people` gives the caller, and past 20 the rest is text (tests).
- security (medium): an owner id differing only in case ("Alice" vs "alice") took a real person's mentions; case-insensitive matching now reaches only directory ids (test).
- security (medium-low): an export of a project with ~33,600 comments was a 500 (one IN list past SQLite's placeholder limit); mentions are read in chunks of 500 (test that fails without it).
- security (medium-low): resolving a mention scanned every visible owner inside the write transaction; now only the named ids.
- general (medium): `@bob_` mentioned bob (ids may end in `._-` under password); now the longest form that names someone wins (test). Email-style ids under `headers` could never be mentioned; `@`/`+` are id characters now (test). Non-ASCII letters end a mention correctly (`@josé` is nothing; `café@bob` is not one).
- general/security (UI): the people list could load several times and draw a stale filter; one request in flight, a failure retried, drawn only for what is typed now and only while focused. An exact id sorts first; Tab and Shift+Tab never pick; IME composition is ignored; picking replaces the whole word around the caret, adds a space only where needed, respects maxlength, and keeps undo-friendly `setRangeText`.
- docs: API.md (the id rule, resolution, tokens, cap, trash), PLAN.md, CLAUDE.md (rule 4 names `comment_mentions`; code map), MCP description (owner ids; `DATA_NOTICE` names mentioned names); whats-new.html text. A test compares the client and server patterns.
Dismissed:
- security: under `headers` the stored name can be a client-chosen owner_name (pre-existing trust of owner names under `headers`; storing the person's own actor name would read activity outside the visibility rule). Decision to check.
- general: two ids differing only in case under `dev`/`headers` (password ids are lower case): handled by exact-first matching; the highlight prefers exact.
- privacy: the read before the comment's transaction for resolution is inside it now; no change needed.
- upstream-check: none.
Re-audit (privacy-auditor, after the fixes): the hard requirement holds; trash and restore as stated; tokens and lower-case lookups reveal no hidden owner or name. Acted on: a directory person now wins over a made-up exact-case owner id (`@Alice` reaches alice); readers seeing another author's mentions documented as the author's choice; tests for restore and the password provider. Not changed: a token can tell an enabled from a disabled visible owner (the same oracle `ownerNameFor` already gives editors).

## Not verified yet

- A browser sweep of Phase 6 was done (calendar, profile, both themes, 375px, keyboard), but no screen reader was used anywhere; the checks were scripted (names, focus styles, overflow) plus screenshots.
- No real calendar app was pointed at the `.ics` feed; it was checked against RFC 5545 by tests only.
- Follow-up test gap the Phase 6 general reviewer listed: `last_used_at` throttling (DTEND, the trashed project, and `passwd` on feeds are now covered).
- The second-review fixes were not run on PostgreSQL (the `NOT IN` clause is the one `due=overdue` already uses there).
- Phase 9 was not run on PostgreSQL (it adds SQL). The picker was checked in the browser (keyboard, 375px, dark mode), not with a screen reader.
- Phase 8 was not run on PostgreSQL. The Duplicate form was checked in the browser (desktop, 375px, dark mode, Escape, a 199-character name), not with a screen reader.
- Phase 7 was not run on PostgreSQL (no PostgreSQL server on the laptop) and no real feed reader was pointed at `activity.atom`; it was parsed by the browser's XML parser (seeded data) and, by the security reviewer, by a strict expat parser over 302 generated documents. The profile page was checked at desktop and 375px widths, light mode only.
