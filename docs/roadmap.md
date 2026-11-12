# Roadmap

What is shipped, what is open, and what comes next. Linear (team `Spaces`) holds the scheduled work; `docs/backlog.md` holds the full bodies of its open slices; `docs/considerations.md` holds ideas not yet decided.

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
16. A published image anyone can run (two slices still open, below)
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
30. The canvas lands — the instrument port (shipped 2026-10-30, with the Clean UI leftovers `SPA-355` and `SPA-356`; its follow-ups `port-C1` SPA-385 and `port-C2` SPA-386 shipped 2026-11-09)
31. Edges and the AI shape — `edges-1` SPA-387 (the 12px edge, cards, folder tabs, the toolbar, `+ New x`, one icon list, `ProviderMark`) and `ai-a` SPA-388 (system and user parts, Anthropic cache markers, one shared prefix per lane, `tokensCached`) shipped 2026-11-10, and `notes-1` SPA-391 (the note page as a record: kind stamp, meta line, the ··· with the kind, the rail with Filed on · Mentions · Mentioned in · Visibility · History) the same day; `edges-2` SPA-392 (the 24px edge, the 12px gutter, the bone ground, paper cards, the folder as the page's one ink object), `record-1` SPA-393 (the rail as unboxed rows, Long text as an Overview paragraph, each relationship once and removable there, registry order with identity first) and `settings-1` SPA-394 (settings on the shared head, group cards 800px wide, the sheet differences) shipped 2026-11-11; `ai-b` SPA-389 is open below

Plus the UI sweep (the printed sheets landing) and Corrections.

## Open

- **Project 16** (`afk`, In Progress in Linear): `SPA-188` install, upgrade and rollback docs, `SPA-190` one-click templates. `docs/install.md` and `docs/upgrade.md` exist, so check whether 188 is done.

## Next, in order

1. **Project 31, the rest** (P-SPA-35), body in `docs/backlog.md` § 31: `ai-b` SPA-389 (migration, hitl: the owner confirms AI column answers may change under the mandate). `settings-2` SPA-395, `shell-2` SPA-396 and `record-2` SPA-397 shipped 2026-11-12. Then the Ask set, which the owner has not picked from yet.
2. **Project 32, one backend grammar** (D84, D85; bodies in `docs/backlog.md` § 32). `schema-1` SPA-400 shipped 2026-11-12 (`input()`, the proof, Tasks as the reference module). `effect-1` SPA-401 shipped 2026-11-12 (nine server modules, the typed session gate, the shared `serverQuery`). `effect-2` SPA-403 shipped 2026-11-12 (the other seven server modules). `effect-3` SPA-405 shipped 2026-11-12 (documents, notes, records, the portfolio loader, the shared input shapes). Left: `effect-4` SPA-406 (the rest, with the lint rule), and `schema-3` SPA-404 (`valueValidator` and core's json shapes). `schema-2` SPA-402 shipped 2026-11-12 (the plugin contract as SDK 2.0.0). From Corrections, `notes-kind` SPA-398 (D83, migration 0092) and `ownership-1` SPA-399 (ownership counts the shares sold) shipped 2026-11-12.
3. **Hybrid data layer** — route loaders own navigation, auth and route context; TanStack Query owns page data, freshness and mutations (`ensureQueryData` in the loader, `useSuspenseQuery` in the component, `invalidateQueries` by key after a write). Decided; starts after project 30.
4. **Docs consolidation** — `DESIGN.md` and `docs/design-contract.md` merge into one design doc, checked against the Paper library; `CONTEXT.md` rewritten to current state only.

## Owner calls

- **Plugin release** — the SDK is 2.0.0 on main, set by hand with its notes in `packages/sdk/CHANGELOG.md` (a major changeset on top of it planned 3.0.0, so there is none); no `sdk@2.0.0` tag is pushed until the owner tags it. `pnpm release:status` plans every plugin's bump (seven to 0.2.0, rss and airtable to 0.1.1). A running install must reinstall apollo, exa, rss, granola and airtable after that release; the four bundled plugins upgrade on first boot once they are 0.2.0, and read as degraded on a 2.0 host until then.
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
- Effect sweep, after `effect-3`: `lib/notes/` and `lib/documents/` each hold two query failures, the older `NoteQueryFailed` and `DocumentQueryFailed` (no message, 32 uses in six files and one worker job) beside the message-carrying `NotesQueryFailed` and `DocumentsQueryFailed`; folding the old into the new makes those callers print the cause's message where they print nothing today. The JSDoc in `notes/delete.ts` still says a tagged error carries no message. `draft-composer.test.tsx` "Delete draft" fails under load and passes alone.
- Two `no-shadow` warnings in `record-details.test.tsx`.
- Note page: `Edited` and `Replaced by` history rows carry no who (nothing records it); a tool-landed note shows `Landed from` and `Written` at one instant; the `+ File on…` picker prints `record` for a custom object because search returns no singular.
- `buildRequest` hands `renderPrompt` a negative budget when a lane's system part alone exceeds `budgetChars`, and the subject is then dropped silently; guard it (every lane's budget is far above its instructions today).
- `MoreMenu` draws Lucide's `Ellipsis` now, not the mono `···` text; the contract's wording still says `···`.
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
