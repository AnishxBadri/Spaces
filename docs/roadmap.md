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
22. Drive as the archive, Box on the same port (three slices still open, below)
23. Meetings and recorders
24. Cmd-K finds, Ask answers
25. Email — viewed, shared, tracked, composed
26. Relationships, and what a newer file supersedes
27. Instrument, printed — the decided design lands
28. Spaces, research and watches
29. Enrichment is the host's

Plus the UI sweep (the printed sheets landing) and Corrections.

## Open

- **Clean UI — one shape per element** (`afk`, the next lane): `SPA-349` action grammar and page heads, `SPA-350` one record head, `SPA-351` row ends and dialog feet, `SPA-352` create windows and empty states, `SPA-353` the walk's remaining findings, `SPA-355` orphaned components and tokens, `SPA-356` lib leftovers and dependencies. Bodies in Linear.
- **Project 22, owner decisions** (`hitl`): `SPA-297` mirror root, `SPA-291` live files, `SPA-298` binding health. Speculative until a user asks; cutting them is a fair answer.
- **Project 16** (`afk`, In Progress in Linear): `SPA-188` install, upgrade and rollback docs, `SPA-190` one-click templates. `docs/install.md` and `docs/upgrade.md` exist, so check whether 188 is done.

## Next, in order

1. **Clean UI**, the remaining design port.
2. **Hybrid data layer** — route loaders own navigation, auth and route context; TanStack Query owns page data, freshness and mutations (`ensureQueryData` in the loader, `useSuspenseQuery` in the component, `invalidateQueries` by key after a write). Decided; starts after Clean UI.
3. **Docs consolidation** — `DESIGN.md` and `docs/design-contract.md` merge into one design doc, checked against the Paper library; `CONTEXT.md` rewritten to current state only.

## Owner calls

- **SDK 1.5 release** — pending changesets `email-snippet`, `recorder-contract`, `granola`, `gmail-send`; then point granola and google-calendar at `sdk ^1.5`.
- **Gmail reconnect** — older connections lack `gmail.send` and must reconnect before sending.

## Unticketed follow-ups

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
