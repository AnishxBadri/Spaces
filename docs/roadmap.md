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

1. **Project 31, the rest** (P-SPA-35): `ai-b` SPA-389 (migration, hitl: the owner confirms AI column answers may change under the mandate). Body in `docs/backlog.md` § 31. Then the Ask set, which the owner has not picked from yet.
2. **Hybrid data layer** — route loaders own navigation, auth and route context; TanStack Query owns page data, freshness and mutations (`ensureQueryData` in the loader, `useSuspenseQuery` in the component, `invalidateQueries` by key after a write). Decided; starts after project 30.
3. **Docs consolidation** — `DESIGN.md` and `docs/design-contract.md` merge into one design doc, checked against the Paper library; `CONTEXT.md` rewritten to current state only.

## Owner calls

- **SDK 1.5 release** — pending changesets `email-snippet`, `recorder-contract`, `granola`, `gmail-send`; then point granola and google-calendar at `sdk ^1.5`.
- **Gmail reconnect** — older connections lack `gmail.send` and must reconnect before sending.

## Unticketed follow-ups

- Edges: a window and a popover keep a 12px row inset where E3 says 16px; Import's inner grids and the empty-state pages are not carded; Tasks' `Open · Done` switch could be the page's folder tabs, as the lists' are.
- Record rail: a deal's Company group swaps the company from its `+` (the attribute is required), which reads as add; an existing install keeps its attribute order (only a fresh seed leads with identity), so a one-off `Reset to default order` on the object's settings page would let it catch up.
- Settings: the folded head's actions pin to the page edge, not the 800px column; `listStatusOf`'s `tone` is unused; `DESIGN.md` "Printed details" still names a double rule under a settings head.
- Two `no-shadow` warnings in `record-details.test.tsx`.
- Note page: `Edited` and `Replaced by` history rows carry no who (nothing records it); a tool-landed note shows `Landed from` and `Written` at one instant; the `+ File on…` picker prints `record` for a custom object because search returns no singular; `FilingRow` is now used only by `space-page.test.tsx`.
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
