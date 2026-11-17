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

Plus the UI sweep (the printed sheets landing), Corrections, the list and the record as fixed panes (D106), IBM Carbon icons and brand marks in their own colours (D19), the note page on bone and its messages (D107), the note window over a record (D108), the interaction rows and windows (D109), one ink line under every head, and the record table read by a screen reader.

## Open

- `SPA-389` `ai-b` — the mandate in every judging lane, and cached tokens on the ledger. Project 31; `migration`, `hitl`: the owner confirms AI column answers may change under the mandate.
- `SPA-429` `interactions-4` — email threads as message cards with one sender line, reply as the last card, the meeting window in two columns (D109). `afk`.
- `SPA-430` `attachments-text` — email attachments keep their text and stay in Gmail until someone keeps them; raw MIME without attachment bodies; a folded `From email` band on the Files tab (D110). `afk`.
- `SPA-460` `email-1` — the Email page: Threads and Drafts in two panes, the sidebar row always there (D111). Project 35; `afk`, after SPA-429.
- `SPA-461` `email-2` — New email ⌄ in a record's Interactions toolbar, the composer as a window over the record, To filled (D111). Project 35; `afk`, after SPA-429.
- `SPA-464` `email-3` — every send passes Review, shown as the message card it will become (D111). Project 35; `afk`, after SPA-461.
- `SPA-466` `email-4` — a failed send keeps its window with Retry, Reconnect Gmail returns to the draft, `Not sent` on Drafts and Today (D111). Project 35; `afk`, `migration`, after SPA-460 and SPA-464.
- `SPA-462` `email-5` — sync skips threads with nobody outside the workspace; the exclude lists become chips (D111). Project 35; `afk`.
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
- `SPA-188` `ship-10` — install, upgrade and rollback docs. Project 16, In Progress. `docs/install.md` and `docs/upgrade.md` exist; check what is left.
- `SPA-190` `ship-12` — one-click templates for Coolify, Railway, Render and Unraid. Project 16, In Progress; each needs a human deploy.

## Next, in order

1. **The Ask set**, which the owner has not picked from yet.
2. **Zod leaves** (approved, not ticketed) — finish D85 as a sweep. Zod is imported by 169 files: web 88 (`lib/server` 30, routes 16, `lib/ai` 11), worker 47 (`jobs` 32, `plugins` 11), core 31 (`ai` 11), and one each in `packages/db`, the sdk's fence test and `scripts/release`. Four slices: the web server-fn validators onto `input()` (about 210 of 270 are still zod); the worker's job payloads; core, where `ai/schema.ts` failed four characterisation rows on a first port and `jsonValueZod` goes with its last caller; then `zod` out of the five `package.json` files and the lint ban widened from the SDK and plugin zones to every package. Each conversion is pinned by a characterisation table recorded against zod first.
3. **Hybrid data layer** — route loaders own navigation, auth and route context; TanStack Query owns page data, freshness and mutations (`ensureQueryData` in the loader, `useSuspenseQuery` in the component, `invalidateQueries` by key after a write). Decided, not ticketed.
4. **Small decided slices** (not ticketed): the sign-in rate rule, 5 per 60 seconds per IP, in `apps/web/src/lib/auth.ts`; workspace export (D42); a staged import on Today's Needs-you (D43).
5. **One design doc** — `DESIGN.md`, `docs/design-contract.md` and `docs/product-map.md` merge into one, checked against the Paper library.

## Owner calls

- **Plugin release** — the SDK is 2.0.0 on main with its notes in `packages/sdk/CHANGELOG.md`, and the eight plugins are still 0.1.0 with 1.x builds released nowhere. To release: bump each plugin that changed (`pnpm release:bump <id> minor`), push, and the Tag workflow pushes `plugin-<id>@X.Y.Z` (it needs `RELEASE_TOKEN`, and the plugin workflow needs the signing key). The push that carries the 2.0.0 bump tags `sdk@2.0.0`; no workflow listens for an sdk tag. A running install must reinstall apollo, exa, rss, granola and airtable after that release; the four bundled plugins upgrade on first boot once their version is above 0.1.0, and read as degraded on a 2.0 host until then.
- **Gmail reconnect** — older connections lack `gmail.send` and must reconnect before sending.

## Unticketed follow-ups

- Phone and feeds, after the backlog run: a phone list's column head pins by a scroll-driven animation, so Firefox and Safari before 26 let it scroll away with the rows; a space page at 390px scrolls sideways (its tab bar and readouts strip overflow); a headline photo that failed before the retry count existed is never retried, and the Feeds page's photo-pending flag does not cover a photo that arrives by a late retry; a refetch after a feed's address changes still counts as new on Today.
- Menus (E12): a list where one item is current (Sort's columns, a view's columns) leads with a check or an empty lane, not a glyph; the editor's block and table menus take their marks by BlockNote's English label, and a label BlockNote adds later keeps an empty lane.
- Notes: in the note window a file-mention chip does not open its preview and a dropped file does nothing (the note page does both); an edit still inside the 800ms debounce is dropped when you confirm leaving.
- Icons: export names in `components/icons.ts` are still Lucide's; the list's menus and Sort button keep `↑`/`↓` text glyphs; `apps/web/components.json` still says `lucide`.
- The app-wide error screen says `The database did not answer.` for every failure; an unknown `/api/…` path falls to the app's catch-all route and its sign-in guard.
- Brand marks: Granola, Apollo and Exa marks were not seen on a live screen (no such rows in the dev database); `Voyage` has no mark.
- Edges: Import's inner grids and the empty-state pages are not carded.
- Windows (E3): a window's head, body and foot pad 16px, but a ledger row inside a padded body insets a further 12px, so its text stands at 28px while the title stands at 16px (the meeting window's Linked records); edge-to-edge windows (the file viewer) need the row inset itself to be 16px. One sweep over the 40 windows, `windows-1`: every window's text on one 16px line.
- Record rail: a deal's Company group swaps the company from its `+` (the attribute is required), which reads as add; an existing install keeps its attribute order (only a fresh seed leads with identity), so a one-off `Reset to default order` on the object's settings page would let it catch up.
- Settings: the folded head's actions pin to the page edge, not the 800px column; `listStatusOf`'s `tone` is unused; `DESIGN.md` "Printed details" still names a double rule under a settings head.
- Settings heads, after `settings-2`: Search's `Catch up` reads as a verb and the account page's `Used for` is borderline; Enrichment Sources' `first answer wins` and Routing's `sensitive lists local models only` print the same on every instance, which the invariant-line rule says is documentation.
- Portfolio, after `ownership-1`: `holdingNow().ourShares` in `lib/ai/ledger-event.ts` sums the shares bought and never subtracts a sale; the dev seed has no priced holding with both a counted round before its check and a sale, so no seeded page shows a sale point (Aarogya's check postdates its only counted round, Garuda is a SAFE); the holding page's `Sale` label has no render test.
- Plugins, after `schema-2`: zod is still imported by host-internal plugin files it did not have to touch (`core/plugins/{credit,lock,auto-enrich}.ts`, the worker's `host.ts`, `queues.ts`, `credit.ts`, `plugin-db.ts`, `run-job.ts`); the pre-commit eslint hook runs out of memory on a 200-file commit (the per-package `turbo run lint` is the gate that passed).
- `updateTerm` takes a partial input whose defaults still fill, so an update that omits `aliases` or `definitionMd` clears them.
- Effect Schema, after `schema-3`: `/api/v1` has no endpoint that takes record values (capture, `registry.list`, `records.list`, `records.get` only), so there was no zod bridge to remove and nothing yet composes `valueValidator` there; it returns a `Schema.Decoder<Json>` ready for the first write endpoint. `packages/core/src/ai/schema.ts` keeps zod for its claim and envelope checks: `ai/schema.test.ts` lists `zod` as an expected import, and an Effect port failed four characterisation rows. `jsonValueZod` in `packages/core/src/json-zod.ts` is a twin for five zod shapes that still compose it (`writes/ports/content.ts`, `writes/vault/index.ts`, `mcp/registry.ts`, the worker's `plugins/queues.ts`). 31 files in core still import zod (`ai` 11, `enrichment` 3, `plugins` 3, the rest one or two a folder). `Schema.Record` accepts a Date, a Map or a class instance and keeps a `__proto__` key where zod refused them; `jsonValue` guards against it, and any other record shape converted later must too.
- Effect sweep, after `effect-4`: six older failure classes carry no `message`, so a database error behind them reads as an empty string (`InboxQueryFailed`, `ResetLinkQueryFailed`, `SpaceQueryFailed`, `TagManyFailed`, `MoveHereFailed`, `WatchingFailed`); the inbox area holds two query failures, as notes and documents do; `tagByHand` in `spaces/tag.ts` stays plain because `spaces/tag.test.ts` reads its source text for `insertSpaceTag(tx`; three files are exempt from the rule by a stated `eslint-disable` (`auth.ts`, `documents/unfiled.ts`, `views/scope.ts`); `poll-storage-live.test.ts` and `poll-storage-gone-live.test.ts` in the worker fail under load on `storage().exists(sha)` and pass alone; the likely cause, not reproduced, is that every test worker has its own database but all share one blob directory, so a delete that checked references in one database removes bytes another file still expects.
- Effect sweep, after `effect-3`: `lib/notes/` and `lib/documents/` each hold two query failures, the older `NoteQueryFailed` and `DocumentQueryFailed` (no message, 32 uses in six files and one worker job) beside the message-carrying `NotesQueryFailed` and `DocumentsQueryFailed`; folding the old into the new makes those callers print the cause's message where they print nothing today. The JSDoc in `notes/delete.ts` still says a tagged error carries no message.
- Two `no-shadow` warnings in `record-details.test.tsx`.
- Note page: `Edited` and `Replaced by` history rows carry no who (nothing records it); a tool-landed note shows `Landed from` and `Written` at one instant; the `+ File on…` picker prints `record` for a custom object because search returns no singular.
- `buildRequest` hands `renderPrompt` a negative budget when a lane's system part alone exceeds `budgetChars`, and the subject is then dropped silently; guard it (every lane's budget is far above its instructions today).
- `MoreMenu` draws Carbon's `overflow-menu--horizontal` now, not the mono `···` text; the contract's wording still says `···`.
- The `···`/last-control alignment is proved by shared padding, not a measured box; a Playwright check at 1280px would make it mechanical.
- Watch delete path.
- Today and search links to `?modal=email`.
- `EMAIL_CATEGORIES` against the canvas categories.
- MCP interactions read through `emailListing`.
- `removeRecordedNotesProgram` assumes one note per member per meeting.
- No stored `References` chain; threading is root + parent.
- Review fills are lost when the composer closes.
- A draft is deleted after send without checking the row landed.
- `labelNames` on the sent copy gets an empty label map (cosmetic).
- From-meetings rows carry no meeting id, title or time.
