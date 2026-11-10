# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Three slices the owner agreed on 2026-11-07/08 (Linear project P-SPA-35, "31. Edges and the AI shape"). `edges-1` (SPA-387, the canvas's "Edges and icons" system) and `ai-a` (SPA-388, the two-part prompt with cache markers) shipped 2026-11-10; `notes-1` (the note page, boards 13/14) and `ai-b` are what is left; `ai-b` carries the migration.

---

#### `notes-1` (SPA-391) · afk · M — The note page: the record head, the body on paper, the rail that says where it is filed and who may read it

**Blocked by:** none (`edges-1` shipped). **Owns** `apps/web/src/routes/_app/notes_.$noteId.tsx`, `lib/server/notes.ts` (`getNote`'s shape only), `components/editor/note-column.ts`, `styles.css` (the `prose-note` heading ladder), a new `components/notes/*`, and the tests beside them. **Does not touch** `routes/_app/notes.tsx` (the list, shipped) or `lib/ai/*`. No migration; no schema change.

**The boards** are the Paper Record page `p-S-0`, 13 "Note" and 14 "Note · revised"; where they differ, 14 wins. Boards 15 and 16 (the list) are shipped. The edges rule E1–E8 (`docs/design-contract.md` § 1) applies: one rule under the head, the rail as the company record draws it.

**Today:** the note page is a 48px bar (back link, `ViaMark`, `OpenIn`, a kind `Segmented`, the save word, a visibility toggle, a Delete button, `···`), then a 72ch column holding the title input, two filing rows (spaces, records) under the title, the editor, and a "Linked from" list at the foot. No stamp, no record head, no rail, no history.

**What to build.**

1. **The head is the record head (A4).** `RecordHeader` with the kind as the stamp (`NOTE` / `MEMO` / `SCRATCH`; a private note adds a second, outlined stamp `PRIVATE`), the serif title as the editable name field (wraps, never clips), and one mono meta line whose shape is the note's state: hand-written `Anish · 13 Oct 14:02`; via a tool `via Granola · Priya Raman · 13 Oct · Open in Granola ↗` (today's `ViaMark` and `OpenIn` fold into this line); private `Only you · 13 Oct 14:02` with the square; superseded: the line dims and ends `→ <replacing title> ›` linking to it, replacing today's "Replaced by →" paragraph. Right of the title: the save word (`Saved` / `Saving…` / `Unsaved changes`, mono, `role=status`) and the `···`, nothing else — no Edit, no Share, no Delete button, no back link (the sidebar is the way back). One rule under the head. The head and the body share one left edge, and that edge is the editor's inset (`NOTE_INSET`), because BlockNote's side menu needs the room: the one named exception to E1, written into the contract.
2. **The `···` menu.** A `KIND` group of three checked rows — Note / Memo / Scratch — that call `setNoteKind` (replaces the `Segmented`). Rule. `Save as new version` · `Save as template…` · `Copy link` (the page URL to the clipboard, toast `Link copied`). Rule. `Delete…` (destructive, through the existing confirm). The author-only visibility toggle moves to the rail.
3. **The body.** The editor column stays at 72ch, prose 17px serif; the heading ladder in `prose-note` is H1 20 / H2 17 / H3 15 sans medium (the title stays 28 serif). Mentions stay ink links. Nothing renders between the title and the editor: the filing rows leave.
4. **The rail.** Right of the body, the record rail (`RailSection` / `RailRow` from `record-parts.tsx`, `w-72`, bone, rule left; under `md` it stacks below the body):
   - `FILED ON · N`: every record and space the note hangs from, one row each — the name as an ink link, the kind in the mono end lane (`company`, `person`, `deal`, a custom object's singular, `space`); records first then spaces, each in edge order. The last row is `+ File on…`, which opens one picker offering both records and spaces (today's `RecordFilingPicker` and the space `Select` merge into it). Unfiling stays as today (the row's ×). With nothing filed the section reads one row, `Not filed`, then `+ File on…`.
   - `MENTIONS · N`: the records the body mentions (this note's outbound `mentions` edges), name and kind; derived, never editable. Hidden at zero.
   - `MENTIONED IN · N`: the inbound backlinks (today's "Linked from"), same row shape; a document row opens the preview as today. Hidden at zero.
   - `VISIBILITY`: `Shared with the workspace` with the `Switch`, for the author only; another reader sees the words without a switch. Private reads `Only you`.
   - `HISTORY`: rows from data that exists, newest first, each `<event> · <day> · <who>`: `Written` (the entity's `created_at`, the author); `Edited` (`note.updated_at`, when more than a minute after `created_at`); `Landed from <tool>` when `via` is set; `Replaced by <title>` when superseded (the `supersedes` link's `created_at`). Kind changes are not logged today, so `Made a memo` is not shown and no log is added.
5. **Data.** `getNote` returns what the rail needs and no more: `author` (display name), `createdAt`, `mentions` (outbound, name + kind + objectSlug), `filedAgainst` gains the object's singular label, `replacedBy` gains `at`. One query per list as now; no per-row queries.
6. **Contract.** `docs/design-contract.md` § 3: the Notes precedent becomes the note page (A4 head, the rail's five sections, the `NOTE_INSET` exception to E1); any § 5 line promising the note page is deleted.

**Acceptance criteria**

- [ ] The note page renders `RecordHeader` with the kind stamp, a `PRIVATE` second stamp when private, the meta line in each of the four states, the save word and a `···` — and no Edit, Share or Delete button, no back link, no `Segmented` (render tests, one per state).
- [ ] The `···` holds the `KIND` rows (checked on the current kind, changing it on select), `Save as new version`, `Save as template…`, `Copy link`, `Delete…`, in that order with the two rules (test).
- [ ] Nothing renders between the title field and the editor (test); the `prose-note` heading sizes are 20 / 17 / 15 (CSS test like `printed-details.test.tsx`).
- [ ] Rail: `FILED ON` rows carry the kind lane and end on `+ File on…`; `MENTIONS` and `MENTIONED IN` render only when non-empty; `VISIBILITY` shows the switch to the author only; `HISTORY` shows exactly the rows the data supports (tests on fixture notes: plain, private, via a tool, superseded, unfiled).
- [ ] Filing and unfiling (record and space), kind change, visibility, new version, template and delete still go through the existing server fns and their tests stay green; one test each on the moved controls.
- [ ] The head's left edge equals the body's (test on the shared class); the contract names the exception.
- [ ] Gates: typecheck, test, lint, prettier; web build. The browser pass is the orchestrator's.

---

#### `ai-b` (SPA-389) · hitl · M · migration — The mandate in every judging lane, and cached tokens on the ledger

**Blocked by:** `ai-a`. **Owns** `lib/ai/complete.ts` (the system part's mandate slot), the judging lanes' callers (`column-run.ts`, `attribute-run.ts`, `read-deck-summarize.ts`, the meeting prep, `propose.ts`'s suggest-spaces), `lib/server/mandate.ts`, `packages/db/src/schema/ai.ts`, `routes/_app/settings/usage.tsx`.

**hitl:** the owner has not yet confirmed that AI column answers may change under the mandate. Ask before step 1 and record the answer in `docs/decisions.md`.

**What to build.**

1. **The mandate in judging lanes.** A `renderMandate` (pure, `packages/core`) prints the mandate's facts as a short block. `completeProgram` puts it in the system part after the lane instructions, before the cache marker, for the judging lanes only: AI columns, meeting prep, summaries (`read-deck-summarize`), suggest spaces. Mechanical lanes (extract, classify, embed, vision text) never see it. With no mandate recorded, the block is absent and the prefix is unchanged.
2. **`tokens_cached`.** Migration: `ai_usage.tokens_cached integer` nullable (and the same on `ai_run`'s step usage if it carries tokens). `completeProgram` writes `usage.tokensCached` from `ai-a`.
3. **Usage page.** `settings/usage.tsx`: the Tokens readout gains the cached share (`Cached · 41%` when any run has it); the run table's tokens cell reads `in (cached) / out`; `tokens()` handles null.

**Acceptance criteria**

- [ ] A judging lane's system part contains the mandate block when a mandate exists and not otherwise; a mechanical lane's never does (tests per lane).
- [ ] The prefix stays byte-identical across rows with the mandate in it (test).
- [ ] Migration adds `tokens_cached`; `boot.test.ts` green; `ai_usage` rows carry it after an Anthropic call.
- [ ] Usage page prints the cached share and per-run cached count (render test).
- [ ] Gates: typecheck, test, lint, prettier; web build; `boot.test.ts` alone.

---

## 16. A published image anyone can run

#### `ship-10` · afk · M — Install, upgrade and rollback docs — back up first, pin the tag, never lose MASTER_KEY

**Blocked by:** `ship-3`, `ship-5`, `ship-8`

**What to build**

Three recorded decisions have no written home and all three are standing debt. README is still the TanStack Start template's ('Welcome to your new TanStack Start app!', a section on removing Tailwind, Better Auth setup notes) — the front door of a product people are meant to self-host. Write the docs the earlier slices made true, and nothing more. docs/install.md: the compose file pinned to a published tag, the two required env vars and the fact that there are only two, what ./data holds, the setup token printed to the logs, and the HTTPS overlay as step two. docs/upgrade.md: back up with scripts/backup.sh, pull, up — and the reason, which is now enforced rather than requested, because an older image refuses a newer database. The MASTER_KEY warning appears in bold in three places saying the same sentence, per CONTEXT's 'docs must say this in bold'. The ./data ownership paragraph must tell the truth after ship-2: the entrypoint repairs it, and `chown -R 1000:1000 ./data` is only needed when the container is pinned to a non-root user. Every command in these docs is run once by a human against a clean box, and no command that was not run appears.

**Acceptance criteria**

- [ ] README is the product's front door: what Spaces is, the compose quickstart pinned to a published tag, links to install and upgrade — and none of the TanStack template's remaining sections
- [ ] docs/install.md covers: compose from a pinned tag, DATABASE_URL and APP_URL as the only required vars, what lives in ./data, the first-run setup token from the logs, then the TLS overlay
- [ ] docs/upgrade.md covers: backup → pull → up; the bold statement that an older image now refuses a newer database and that the way back is restore, never a downgrade; and the psql two-liner for the dealos→spaces role/database rename
- [ ] The MASTER_KEY sentence appears in bold in install, upgrade and backup sections, identically worded: lose ./data/secret.key and every stored credential is unrecoverable
- [ ] The ownership paragraph matches ship-2's behaviour — the entrypoint repairs ./data; the chown line is documented only for containers pinned to a non-root user
- [ ] Every command in both documents was executed against a clean box by a human, and the PR says so; no untested command appears
- [ ] docs/architecture.md hosting lines are re-pointed at these documents instead of repeating them
- [ ] Explicitly out of scope and named as such: the comparison page, the PaaS templates, and the marketing site
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Hand someone the README who has never seen the repository: they get a running, HTTPS-served instance from a published tag, know what to back up, and know what happens if they lose secret.key — without asking a question.

**Spec** — CONTEXT.md — BYOK ('Losing it makes every stored key unrecoverable — docs must say this in bold'); CONTEXT.md — Hostability decisions #5 and #6; Standing debt ('Rollback is unsafe and undocumented', './data ownership landmine'); README.md (still the TanStack Start template)

#### `ship-12` · afk · S — One-click templates — Coolify, Railway, Render, Unraid

**Blocked by:** `ship-10`, `ship-8`

**What to build**

CONTEXT's Hosting rules end with 'Publish Coolify / Railway / Render / Unraid templates. Cheap, huge reach — that's where self-hosters live', and nothing owns it. Once there is a published tag and a written install doc, each template is a small declarative file wrapping the same two-container shape. The one thing that actually breaks these platforms is the database: we need pgvector, and only some managed Postgres offerings have it — Render's does, Railway needs the pgvector image variant. A template that provisions a plain Postgres fails at the first migration, so each one either provisions pgvector or says plainly that it cannot. Two other rules: APP_URL comes from the platform's assigned domain (a template that leaves it unset reproduces the Secure-cookie login loop on a platform that always terminates TLS), and ./data must be a persistent volume or every restart loses secret.key and with it every stored credential.

**Acceptance criteria**

- [ ] Templates under deploy/ for Coolify, Railway, Render and Unraid, each pinning a published tag and never `latest`
- [ ] Each provisions Postgres with pgvector, or states in its description that the platform cannot and is unsupported — no template fails at the first migration
- [ ] APP_URL is wired to the platform's assigned domain in every template, and a deployed instance sets a Secure cookie on login
- [ ] ./data is a persistent volume in every template, and each description carries the backup-and-secret.key sentence from ship-10
- [ ] Each template is deployed once by a human and the resulting URL reaches /setup with the token retrievable from that platform's log view — a template whose setup token is unreachable is a broken install and is fixed or dropped here
- [ ] The README links the templates and says which platforms were actually tested and when
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Deploy from the Railway template, wait, open the assigned URL, read the setup token out of the platform's logs, and finish the wizard — a working instance with no terminal involved.

**Spec** — CONTEXT.md — Hosting ('Publish Coolify / Railway / Render / Unraid templates. Cheap, huge reach'); CONTEXT.md — Hostability decisions #6 (frozen required-env set), Two self-host auth traps #1 and #2; docker-compose.yml (the two-container shape the templates wrap)
