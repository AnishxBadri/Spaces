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

Plus the UI sweep (the printed sheets landing), Corrections, and the list as a fixed pane (D106).

## Open

- `SPA-389` `ai-b` — the mandate in every judging lane, and cached tokens on the ledger. Project 31; `migration`, `hitl`: the owner confirms AI column answers may change under the mandate.
- `SPA-188` `ship-10` — install, upgrade and rollback docs. Project 16, In Progress. `docs/install.md` and `docs/upgrade.md` exist; check what is left.
- `SPA-190` `ship-12` — one-click templates for Coolify, Railway, Render and Unraid. Project 16, In Progress; each needs a human deploy.
- `SPA-407` — the record table to a screen reader: named by its view, the sort read aloud, the name as row header, a Tab stop while columns overflow; the `n more columns →` foot line already shipped with the fixed pane. `afk`, size S.
- `SPA-409` `notes-2` — the note page on the bone ground: the body a paper card, the rail a label lane like the record's property grid, record kinds as icons (rail, File on picker, `@` menu, Delete's list; one kind-icon map), a twelve-item slash menu, the head on the 24px page edge and the prose on the card's own 56px gutter (D107 keeps the page scroll). `afk`, size M.
- `SPA-410` `notes-3` — a failed note save says `Not saved · Retry` in crimson, retries once by itself, leaving warns while an edit has not landed, and the delete window says only `Can’t be undone.` above what the note leaves. `afk`, size S.
- `SPA-417` `notes-4` — loading, not-found and couldn't-load screens on the notes routes, and an app-wide default not-found and error in `router.tsx`. `afk`, size S.
- `SPA-418` `heads-1` — one ink line under every head (the code still draws the rule), and the title steps to 22px below `md`. `afk`, size S.
- `SPA-419` `notes-5` — the notes list's day lane fits a year (`Day`), and below `sm` the snippet goes. `afk`, size S.
- `SPA-420` `history-glyphs` — a record's History rows lead on icons from the shared list at one size (`size-4`), not mixed text glyphs. `afk`, size S.
- `SPA-421` `icons-carbon` — the shared icon list moves from Lucide to IBM Carbon at 16px, `NoteKindIcon` redrawn on its grid (D19). Blocks SPA-420. `afk`, size M.
- `SPA-422` `record-pane` — a tabbed record and a space page become fixed panes at `xl`: the head stays whole, the folder runs to the window's foot and each tab scrolls inside it (D106). `afk`, size M.
- `SPA-423` `note-window` — a record's Notes tab gets a toolbar (filter, `New note ⌄` with templates) and superseded notes fold; a note opens in a window over the record (D108). After SPA-409. `afk`, size M.
- `SPA-424` `brand-colour` — `ProviderMark` draws each brand's official logo in its own colours; Granola, Apollo, Exa and OpenAI get their real marks (D19, E7). `afk`, size S.
- `SPA-425` `count-baseline` — a tab's and a segment's count sits on its label's baseline (`Tabs`, `Segmented`). `afk`, size S.
- `SPA-426` `interactions-3` — thread rows put the clip under the day and clamp the summary at two lines; the email thread unfolds in place; the meeting and email windows end on `Done`; logging gains a Summary and opens the write-up over the record (D109). After SPA-423. `afk`, size M.

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
