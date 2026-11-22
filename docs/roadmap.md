# Roadmap

What is shipped, what is open, and what comes next. Linear (team `Spaces`) holds live work, with each open slice's spec in its issue body; shipped issues are closed and archived, and this file and git are the record. Decisions are in `docs/decisions.md`; ideas not yet decided are in `docs/considerations.md`.

## Shipped

1. Ship polish — the name, the box, the vocabulary
2. Worker spine, the workspace, a test database of its own
3. Provenance without vendors, deletes that don't lie
4. The Instrument port
5. Custom objects, and one review inbox
6. The note model — filed, not just mentioned
7. Documents file into spaces
8. The documents shelf
9. Views leave the browser — server-side filters and pagination
10. AI substrate — it reads a deck
11. Everything Cmd-K can find
12. AI on every object, and the graph from outside
13. Doors that are not an upload — a mailbox, a link, an API with a spec
14. Import and export
15. `packages/core` and `apps/worker`
16. A published image anyone can run (two slices open, below)
17. The plugin SDK
18. Plugins run unattended, Apollo enriches
19. Install from the app, no redeploy
20. Storage sources — connect an account, attach a file
21. A bound data room
22. Drive as the archive, Box on the same port
23. Meetings and recorders
24. Cmd-K finds, Ask answers
25. Email — viewed, shared, tracked, composed
26. Relationships, and what a newer file supersedes
27. Instrument, printed — the decided design lands
28. Spaces, research and watches
29. Enrichment is the host's
30. The canvas lands — the instrument port, with its follow-ups `port-C1` and `port-C2`
31. Edges and the AI shape — the edge, cards and folder tabs, one icon list, the prompt's system and user parts with cache markers, the note page as a record, the bone ground, the record rail, settings in group cards and the owner's review fixes (one slice open, below)
32. One backend grammar — I/O is Effect (D84), Effect Schema with SDK 2.0 (D85), two note kinds (D83), ownership counts sales
33. Feeds are built in — the poller and parser, stored logos and photos, the Feeds page with Sources and Headlines, feeds in spaces and on Today; the RSS plugin and the SDK's `feeds` role retire (D87)

Plus Zod leaves (project 37: every server-fn validator through `input()`, job payloads through one `decodeJobData`, core, db and the release scripts on Effect Schema, zod out of every `package.json` and refused by lint in every package, D85), the UI sweep (the printed sheets landing), Corrections, the list and the record as fixed panes (D106), IBM Carbon icons and brand marks in their own colours (D19), the note page on bone and its messages (D107), the note window over a record (D108), the interaction rows and windows (D109), one ink line under every head, and the record table read by a screen reader.

## Open

- `SPA-389` `ai-b` — the mandate in every judging lane, and cached tokens on the ledger. Project 31; `migration`, `hitl`: the owner confirms AI column answers may change under the mandate.
- `SPA-460` `email-1` — the Email page: Threads and Drafts in two panes, the sidebar row always there (D111). Project 35; `afk`, after SPA-429.
- `SPA-461` `email-2` — New email ⌄ in a record's Interactions toolbar, the composer as a window over the record, To filled (D111). Project 35; `afk`, after SPA-429.
- `SPA-464` `email-3` — every send passes Review, shown as the message card it will become (D111). Project 35; `afk`, after SPA-461.
- `SPA-466` `email-4` — a failed send keeps its window with Retry, Reconnect Gmail returns to the draft, `Not sent` on Drafts and Today (D111). Project 35; `afk`, `migration`, after SPA-460 and SPA-464.
- `SPA-463` `email-6` — Who can read this says when the body is already open wider, and saves (D111). Project 35; `afk`, after SPA-429.
- `SPA-465` `email-7` — a member's email signature, added once to new emails and replies (D111). Project 35; `afk`, `migration`, after SPA-461.
- `SPA-437` `heads-2` — an index page's head is 48px and never folds; a page about one thing keeps 104 (D114). `afk`.
- `SPA-438` — a Button inside a menu or dialog trigger keeps `data-slot="button"`, so the folded head's buttons are all 26px and the split create's halves line up. `afk`.
- `SPA-439` — a note's preview strips its markdown on the notes list, a record's notes and Ask. `afk`.
- `SPA-440` `meetings-1` — the Meetings page: Upcoming and Past tabs, a person chip (`Mine` by default), thread rows, a `No write-up` band with a recorder's grace hour, `Log interaction` in the head, a fixed pane (D112). Project 34; `afk`.
- `SPA-441` `meetings-2` — Prep lives only in an upcoming meeting's window: a cited brief where the write-up will go, `Ask about this`, `Save as note` (D112). Project 34; `afk`, after SPA-429.
- `SPA-442` `meetings-3` — `Write it up` opens the note window on any page; action items are read from every shared write-up and decided in the meeting window and on Today under Tasks (D112). Project 34; `afk`, after SPA-429.
- `SPA-443` `meetings-4` — calendar sync keeps only timed, ordinary, non-private events with an outside attendee off the exclude list; `Remove from Spaces…` is remembered (D112). Project 34; `migration`, `afk`, google-calendar bump.
- `SPA-444` `meetings-5` — Today's Write-ups are yours with the grace hour; the day strip's head names the next meeting and shows `Join ↗` near a call (D112). Project 34; `afk`, after SPA-440.
- `SPA-445` `meetings-6` — a record's Interactions tab opens with an `Upcoming` band; `This week` holds only the past; the `Next meeting` readout opens the meeting (D112). Project 34; `afk`.
- `SPA-446` — a multi-value field's rows: clicking a value copies it, remove is its own action with Undo, rows lead with the value's own icon. `afk`.
- `SPA-447` — Add to Team lists likely people before you type (this company's interaction participants first) and no rail picker opens empty. `afk`.
- `SPA-452` `record-tabs` — the many side of a paired relationship is a record tab with a table (Team, Associated deals, People, Companies, custom objects'); the rail keeps a three-row preview with `All n ›` (D115). `afk`.
- `SPA-453` `rail-icons` — every rail attribute label leads with its type's 16px glyph; section heads stay bare. `afk`.
- `SPA-457` `empty-states` — each kind's empty page draws its dithered noun, title and create button, no sentence; a filter that matched nothing is one icon-and-line row (D116). `afk`.
- `SPA-458` `head-quick` — a record head offers New note and New task as two icons before its verbs (A4). After SPA-450. `afk`.
- `SPA-459` `rail-set` — the rail's `n empty` row opens in place into `Set <attribute>` rows, then `New attribute…` and `Fewer`. `afk`.
- `SPA-450` `tasks-1` — one task window for new and edit; `T` opens it on every page; the row menu drops its two edit windows (D113). Project 36; `afk`.
- `SPA-451` `tasks-2` — the Tasks page: a fixed pane, a person chip (`Mine` by default), plain bands, a Done log in week bands (D113). Project 36; `afk`, after SPA-450 and SPA-440.
- `SPA-454` `tasks-3` — a record's and a space's Tasks section: everyone's open tasks, five rows then `n more ›`, Undo on a tick (D113). Project 36; `afk`, after SPA-450.
- `SPA-455` `tasks-4` — Today's tasks and the sidebar's `n due` are your own; a task opens in the window (D113). Project 36; `afk`, after SPA-450.
- `SPA-456` `tasks-5` — a task made from an action item keeps its write-up; pending items head Tasks › Open (D113). Project 36; `migration`, `afk`, after SPA-442 and SPA-451.
- `SPA-471` `deps-1` — drop `@tailwindcss/typography` (unused) and `dotenv`/`dotenv-cli` (Node 22 reads env files); the site sets in IBM Plex. `afk`.
- `SPA-472` `errors-1` — a failed query shows its area's plain line and logs the cause; every failure class carries a message; one query failure per area; unknown `/api` paths answer 404 (D117). `afk`.
- `SPA-486` `mcp-schema` — an MCP tool's JSON Schema is generated from its Effect decoder; a live MCP client check. Project 40; `afk`.
- `SPA-487` `schema-tidy` — one plain-record guard, the registry's error wording, no exports kept only for tests. Project 40; `afk`.
- `SPA-488` `auth-links` — `/join` and `/reset` require their token; a link without one says so. Project 40; `afk`.
- `SPA-188` `ship-10` — install, upgrade and rollback docs. Project 16, In Progress. `docs/install.md` and `docs/upgrade.md` exist; check what is left.
- `SPA-190` `ship-12` — one-click templates for Coolify, Railway, Render and Unraid. Project 16, In Progress; each needs a human deploy.

## Next, in order

1. **Settings** — redesign and roll out. "Fewer settings pages" in `docs/considerations.md` is decided here, against the map in D81.
2. **Ask** — redesign and roll out; the Ask set is picked as part of it.
3. **Portfolio, then Mandate** and the other capital pages.
4. **Onboarding** — the first run (D80) once the pages it leads into are settled.

## Owner calls

- **Plugin release** — the SDK is 2.0.0 on main with its notes in `packages/sdk/CHANGELOG.md`, and the eight plugins are still 0.1.0 with 1.x builds released nowhere. To release: bump each plugin that changed (`pnpm release:bump <id> minor`), push, and the Tag workflow pushes `plugin-<id>@X.Y.Z` (it needs `RELEASE_TOKEN`, and the plugin workflow needs the signing key). The push that carries the 2.0.0 bump tags `sdk@2.0.0`; no workflow listens for an sdk tag. A running install must reinstall apollo, exa, rss, granola and airtable after that release; the four bundled plugins upgrade on first boot once their version is above 0.1.0, and read as degraded on a 2.0 host until then.
- **Gmail reconnect** — older connections lack `gmail.send` and must reconnect before sending.

## Unticketed follow-ups

- Email thread, after `interactions-4`: a card reads `→ you` among To even when the reader was only cc'd or bcc'd, because arrival drops the mailbox's own address and the read puts it back first in To; a member's address that no person record holds prints as the address; the email window is 85vh tall, not the board's 680px; the meeting write-up's source reads `Via Granola` in words, not the mark; the meeting rail's Participants and the quoted-history fold were not seen on a live screen (no such rows in the dev database).
- Attachments, after `attachments-text`: the thread viewer's column holds Text and Source only (no Kind, Filed on, Versions); forgetting a connection now turns every document that came through it with no bytes to `gone`, a Drive `retain: text` row included; a teammate's upload of a file no longer merges onto a synced row that has no bytes; forwarded mail still stores its attachments; opening, downloading, `Keep a copy` and the worker's extraction fetch were tested against a stubbed Gmail only, and the `From email` band was not seen on a live screen.
- Mail sync, after `email-5`: the chip lists were not seen on a live screen (the dev database has no connected mailbox); a bad sender entry is refused on Save with a toast, not in the field; the row's label sits centred beside the chips, since the page's row was kept; at 390px Settings › Email & calendar runs to 557px with no account connected.
- Icons, after `icons-2`: the space page's parent-space row and Enrichment's move buttons still print `↑`/`↓` as text; the stored `OBJECT_ICONS` keys (`boxes`, `kanban`, …) keep their Lucide names, since renaming them needs a data migration.
- Export, after `export-1`: interactions are not exported; a record's identity cell holds its first domain or email only (Import reads one); the zip's bytes go with the nightly orphan sweep, so 24 to 48 hours after export; S3 `put` now streams when given a size, untested against real S3.
- Data layer, after `data-1`: setting an FX rate, the base currency or renaming a company does not invalidate the Portfolio keys, so Portfolio opened afterwards paints the cached figures until the loader's background read lands; Today's mark window refreshes Today through an `onSaved` callback, since Today still reads through its loader.
- Records, after `rail-menus`: the dev database's Companies attributes are not in the default order (the reset item is enabled there); the swap glyph is Carbon `Repeat`, since `ArrowsHorizontal` already means merge.
- Notes, after `note-window-2`: a confirmed leave waits for the last save, so a save the server never answers holds the navigation; closing or reloading the tab still shows only the browser's prompt. A file chip's viewer and a drop in the note window were not seen live.
- Settings, after `settings-3b`: the fold now measures the actions' right edge in the shared head, so record and page heads use it too (they still land 24px in).
- Windows, after `windows-1`: a filled row (the meeting window's Write-up, any `EmptyRow` in a window) stands its fill on the 16px line and pads its text inside, so its text sits at 28px; the meeting window's `+ Pin a record…` text stands 4px left of the linked rows' text. The confirm was not opened live.
- Phone, after `phone-1`: at 390px a list page still scrolls sideways, because the toolbar's search field runs to 481px; the shared `Tabs` bar now scrolls inside itself on record pages too; Firefox and WebKit run only the phone e2e specs, and only where they are installed (CI installs Chromium alone).
- Sign-in limit, after `sign-in-limit`: the Railway, Render and Coolify templates under `deploy/` do not set `TRUST_PROXY`, so behind their proxies every sign-in shares one count; the site's docs do not mention `TRUST_PROXY`. Better Auth's limiter is now on in every environment, so its default rules (100 requests per 10 seconds per path, 3 per 10 seconds on sign-up and change-password) apply in dev too.
- Today, after `import-today`: a batch abandoned at the preview (`planned`) does not show on Needs you, only `staged`; the row carries no glyph beside its `IMPORT` kind word (Kinds), though the issue asked for one.
- Portfolio, after `portfolio-shares`: the dev database shows the seeded Tejas Sensing holding (a sale point) only after `pnpm db:seed`; the site's landing copy still says twelve holdings, and the seed now has thirteen.
- Feeds, after the backlog run: a headline photo that failed before the retry count existed is never retried, and the Feeds page's photo-pending flag does not cover a photo that arrives by a late retry; a refetch after a feed's address changes still counts as new on Today.
- Brand marks: Granola, Apollo and Exa marks were not seen on a live screen (no such rows in the dev database); `Voyage` has no mark.
- Edges: Import's inner grids and the empty-state pages are not carded.
- Plugins, after `schema-2`: the pre-commit eslint hook runs out of memory on a 200-file commit (the per-package `turbo run lint` is the gate that passed).
- Effect Schema, after `schema-3`: `/api/v1` has no endpoint that takes record values (capture, `registry.list`, `records.list`, `records.get` only), so nothing yet composes `valueValidator` there; it returns a `Schema.Decoder<Json>` ready for the first write endpoint.
- Note page: `Edited` and `Replaced by` history rows carry no who (nothing records it); a tool-landed note shows `Landed from` and `Written` at one instant; the `+ File on…` picker prints `record` for a custom object because search returns no singular.
- The `···`/last-control alignment is proved by shared padding, not a measured box; a Playwright check at 1280px would make it mechanical.
- Watch delete path.
- Today and search links to `?modal=email`.
- `EMAIL_CATEGORIES` against the canvas categories.
- MCP interactions read through `emailListing`.
- `removeRecordedNotesProgram` assumes one note per member per meeting.
- No stored `References` chain; threading is root + parent.
- From-meetings rows carry no meeting id, title or time.
