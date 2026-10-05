# Design brief — the product at first ship

_2026-10-06. For the session that works the Paper file `spaces` (id in `DESIGN.md`). Two jobs, in order: condense the file into six pages that mirror `docs/design-contract.md`, then draw the main routes as they will look once projects 19–26 have shipped, on the **Surfaces** page. Those sheets are the reference every surface slice in projects 23–26 cites, so they are drawn before those slice bodies are written._

## Part one — the file mirrors the contract

The file holds initial renders, proposals and approved sheets side by side. By project 26 most proposals are decisions, so the file is condensed into six pages. A slice cites one place; a reviewer checks it against one section of the contract.

| Page            | Holds                                                                                                                                                                                                                                                                                | Contract section  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **Foundations** | materials, type steps, voices, the Casing Rule, the Commentary Rule, the Separation Rule cards                                                                                                                                                                                       | §1 the vocabulary |
| **Components**  | one sheet per primitive, each naming its code file: `RecordHeader`, `RecordBody` + `PropertyGrid`, `LedgerSection`/`LedgerRow`/`LedgerFigure`, `SettingsSection`/`SettingsRow`, card, chip and ref chip, dialog, confirm, composer row, picker — plus the new ones Part two produces | §2 the primitives |
| **Patterns**    | the five shapes (shelf, queue, settings section, record, ledger of a stream) and the new ones Part two produces                                                                                                                                                                      | §3 precedent map  |
| **Surfaces**    | every route as it is at first ship, one sheet per route, its states beside it                                                                                                                                                                                                        | the routes        |
| **Landing**     | the marketing site, its own grammar                                                                                                                                                                                                                                                  | none              |
| **Archive**     | every initial render and proposal, moved not deleted, captioned with the date and the sheet or decision that superseded it                                                                                                                                                           | none              |

Rules for the condensation:

- **A Surfaces sheet must be true by project 26 or shipped.** Anything that depends on an open question or a later project goes to Archive with a note: Harmonic's filter form, the two-axis routing grid, anything past 26.
- **One sheet per route.** Where p-D-0 and p-E-0 drew a route twice, the one that survives the rule pass stays; the other is archived.
- **Components carry the code pointer.** The sheet names the file. The repo stays the truth and the canvas stays the draft.
- **Proposals that became decisions become captions.** The D number sits on the surviving sheet; the proposal page is archived.
- **Archive is append-only.** Never delete; a superseded render is the record of why.
- **Mapping before moving.** First an inventory: every page and sheet, with its proposed destination and, for Archive, what superseded it. The owner approves the mapping; then one pass of moving; then Part two on a clean file.

## Part two — the Surfaces at first ship

Projects 19–26 carry decisions D59–D73. Half of their surfaces exist on the canvas already (p-D-0 "Storage & Email", p-E-0 "Meetings · Relationships · Objects", both of which Part one folds into Surfaces); the other half — the finder, Ask, the space page, Review with space heads — has never been drawn. Part two does two things at once:

1. **Draws the missing surfaces**, from the decisions named per sheet below.
2. **Re-reads the existing sheets against The Separation Rule** (approved 2026-10-05, `DESIGN.md` §3–§5, `docs/design-contract.md`), so that one grammar runs through every route. Re-read means adjust in place where the rule is broken; it does not mean redraw.

Shipped surfaces are not redesigned beyond the rule. The product keeps its philosophy: Instrument, light only, paper rows under bone heads, values on the surface, behaviour in tooltips, data dense and commentary scarce.

## Rules that bind every sheet

- **Hierarchy before density.** The owner's direction of 2026-10-06: the product is not an information-dense terminal. A sheet shows what a reader needs at this moment and lets the rest fold. Hierarchy is made with every means the system has, not with weight alone: tone (paper, bone, bone-deep as three depths), size (the named type steps), colour (ink, graphite, label), material (hairline versus rule), and distance (32–40px between groups). A primary line in ink at body 14, a secondary in graphite, a measured value in mono; a section head on bone, a nested group on bone-deep. Prefer fewer rows that read at a glance to more rows that must be scanned.
- **The invariant-line test.** A line of UI that would read the same on every instance is documentation, not data: delete it, and put what it said in a tooltip or in the docs. "Dismiss is permanent for this space", "writes as you", an account address under a dialog title, "native files keep text only" — identical every time, so gone. A count, a date, a provenance mark, a record name, a state word — different every time, so they stay. The owner named this on 2026-10-06 after reading the first component sheet; it has plagued the canvas since the first proposal pages, and every re-read sheet is checked against it.
- **One close per dialog, and `esc` is never printed.** Cancel in the foot, unmarked. No standalone `esc` in the head, no cross, no `esc` hint anywhere: it closes every dialog in every app, so it fails the invariant-line test. A printed key earns its place only when the binding is ours and not guessable — `⌘↵` to submit from inside a text field, `L` to log, `G T` to go. `esc` to close and `↵` on a primary or an Open are universal and are not printed. Owner, 2026-10-06. Amends P8 and the card foot.
- **The affirmative verb is pine.** One pine-filled button per card, dialog or section foot — the verb that writes. Everything beside it is ghost text. `DESIGN.md` has said this since August (`button-primary`); the Review sheet’s outlined primaries were wrong against it and are corrected in the rule pass. Owner, 2026-10-06.
- **Providers wear their own mark.** A plugin or connection is shown by the provider’s logo at 14–16px, never a two-letter monogram: Exa, Harmonic, Apollo, Fathom, Granola, Gmail, Drive, Calendar. Degraded is the same mark at reduced opacity. The canvas uses the favicons in `docs/design-assets/providers/`; the product serves the mark from the plugin’s manifest. Owner, 2026-10-06.
- **The readout strip is variant B** (Components › Readout strip · variants): equal 220px cells on rules, the number mono 22 on top, a sentence-case 12px graphite label under it, a ratio printed `1 / 2`. A readout is a derived or cross-cutting number, never the count of a section on the same page. Amends P1 and the shipped `RecordHeader` strip.
- **Keep the dither and the strict lines.** The retro texture (Foundations › Texture — Dither) and the hairline-and-rule discipline are the character. Innovate inside them: a new way to separate or to foreground is welcome if it uses tone, size, colour, material or distance, and unwelcome if it adds a border, a shadow, a card or a colour outside the vocabulary.

- **The Separation Rule.** Bone for section heads, tabs, folder bands, dialog heads and feet; paper for rows. Heights: table 36 / ledger 40 / section head 44 / dialog head 48. Sentence-case section titles at title 15/500 with a mono count. Hairline opens a section; rule between rows. 32–40px between groups.
- **Values on the surface, behaviour in tooltips.** A tooltip explains what a control does; it never hides information. Descriptions, counts, dates, participants and summaries sit on the surface; a second graphite line is fine when it is content.
- **Mock data is spec.** Read `SYSTEM_ATTRIBUTES` (`packages/core/src/attributes/registry.ts`) and the enums before drawing a value; a mocked attribute that does not exist is a bug in the sheet. No headline sentence repeating what the readout strip already shows.
- **Vocabulary only.** `text-graphite`, `border-rule`, `bg-bone`, `bg-paper`, `text-label`, `rounded-md`/`rounded-none`; the named type steps; no new colour, no new step, no dark mode.
- **The precedent map decides the shape** (`docs/design-contract.md` §3): shelf → `/portfolio`; queue → `/inbox`; settings section → the FX ledger; record → `RecordHeader` + `RecordBody`; ledger of a stream → Today's spine. Name the precedent in the sheet's caption.
- **Empty, loading, degraded.** Every new sheet carries its empty state and, where a plugin is involved, the degraded state (D63: a manifest action is absent, not disabled, and Review and Today say why).
- **AI and plugins only propose.** Nothing on these sheets writes to the graph without a card or an explicit user action; a card always shows its evidence.
- **Captions** clone `BJD-0` and carry EXTENDS (what shipped component this reuses) and RULES (which bullet above the sheet leans on). Index sheet at x = −1520 as on the other pages. Questions for the owner go on the index, numbered.

## The sheets

Ten Surfaces sheets. "Re-read" sheets exist and get the rule pass plus the named additions; "new" sheets are drawn from scratch. Each new sheet also yields Components and Patterns sheets, listed at the end.

### 1. Today — re-read M1, add the attention row

Precedent: Today's spine. Shows: the Meetings section with day navigation and external meetings only (D68); the attention row counting a space's open Review cards ("6 to review in In-space manufacturing", D72); the existing ledger sections unchanged. Decisions: D68, D72. Reuse: `LedgerSection`, `LedgerRow`, `LedgerFigure`.

### 2. Cmd-K, the finder — new

Precedent: none shipped for a palette; the current Cmd-K is the base. Shows the four groups in order — **Jump to**, **Actions** (printed keys; on a record its own verbs first: Log interaction, Write email, Move stage), **Records** (lexical and fuzzy only), **Passages** (semantic, second wave). A highlighted result opens the preview pane: a record's readout strip and key fields, or an object's views and counts; nothing highlighted, the list runs full width. Foot: navigate · actions on this result · open · **Tab → Ask**. Draw the typed-name case where the record wins first. Decision: D70. States: no results; Passages still loading.

### 3. Ask — new, two sheets in one

Precedent: the palette from sheet 2, then a full thread view. Shows: the same palette after Tab with the query carried over; an answer where every claim is cited (`doc:…#n`, `note:…`) and citations are the existing ref chips; **action cards** below the answer (create task, move stage, file into a space, add a company found on the web) each with Apply; `@space` / `@record` scoping chips in the prompt; the foot with **Save as note** and, when the turn used a research tool, **Save as watch**; the thread list, private to its author. Draw one refused state: the context held a sensitive space, the local model answered or the call was refused, and the sheet says which. Decisions: D70, D71, D72. Scope is optional and the default is the whole workspace: records, portfolio, every mounted plugin tool, the web. Mock the palette unscoped ("which Series A deals have gone quiet, and did anything happen to them this week?": query_records, interaction stats, Exa news, portfolio, cards to log and to task) and keep the scoped example for the thread, so `@space` reads as a narrowing, never as the mode. Spaces tools and plugin tools both appear in the call strip, web hits and filed records are never confused, the cards are the only crossing. The surface is named Ask (D70): a verb beside Today, Review and Spaces, not a persona. **Four doors:** Tab from Cmd-K with the typed text carried over; `⌘J` anywhere, empty; the `Ask` nav row (`G A`) opening the thread view at /ask; and "Ask about this" in a record’s or a space’s `···` menu, opening Ask with the `@scope` chip set. The chassis on every Surfaces sheet shows the Ask row after Spaces.

### 4. Space page — re-read the existing Space sheet

Precedent: record (`RecordHeader` + `RecordBody`); the Space sheet on Surfaces is the base and is good. Add to it. Head: caps breadcrumb as the full path (`Aerospace › In-space manufacturing`), serif name, the actions area with Rename · Move · Archive in the menu and **Add watch** as the one action (D73, D72). Body left: **Criteria** (one to three sentences, editable in place) above the memo; **Companies** grouped by stage with "via <subspace>" on inherited rows (ancestor visibility, 2026-09-21); the **subspace tree with counts**. Rail right: **Watching** — one row per watch: engine mark and name, cadence or "manual", last run, a live status cell over D64's stream ("running · 7 found · 6 cards"), **Run now**; **What's moving** — signals on members, cited, newest first; **Terms**. Draw the empty Watching lane (no engine installed: the lane says which plugins can watch) and the degraded one (Exa breaker-tripped: the row says why, Run now absent). Decisions: D71, D72, D73. Mock on the dev tree: `aerospace › in_space_manufacturing`, members Varda, Space Forge, Flawless Photonics.

### 5. Review — re-read V1, add the space heads

Precedent: queue (`/inbox`, renamed Review, D61). Shows the existing lanes (suggestions, duplicates) plus cards **grouped under a space head** ("In-space manufacturing · via Exa · 6"): **add-record** cards (name, domain, the evidence refs with their URLs, "Add and file here", Dismiss) and **file-record** cards ("Also file Redwire here? Filed in Ground systems"). Dismiss is permanent per space and the tooltip says so. Accept shows the thirty-second after-state once: the record exists, Apollo's enrich is running. Decisions: D61, D72. Keep the one-card-one-decision rule: no bulk accept.

### 6. Company record — re-read O1

Precedent: record. Add: the **Team** panel over D60's `companies` references (editing writes the person's value); the **relationship rail** entries as D69 draws them — the inverse side reads as a plain attribute, no visual difference from the owning side; **Enrich** and **Research** as manifest actions in the head's action area (D63), and the same head with both absent and a one-line "Apollo is disabled" in the readout; signals from a watch in the Interactions section with `via Exa`. Decisions: D60, D63, D69, D72.

### 7. Meeting dialog — re-read M2

Precedent: dialog (48px bone head). Confirm: time and link, participants with RSVP shown and never editable, linked records, the write-up (one canonical body), **artifacts by role** (transcript, recording link, attachment), pending suggestions (summary as a note suggestion, action items as task suggestions, "these notes are mine" filling an empty write-up), **Prep** on demand with Save as note. Decision: D68.

### 8. Email viewer and compose — re-read E1–E8

Precedent: p-D-0 as rebuilt 2026-10-05. Rule pass only. Confirm the two-line summary clamp with the Gmail snippet as the unmarked fallback, the privacy row ("visible to: you · widen"), the drafts count in the account menu, variables as paths in the composer. Decision: D67. If the rule pass changes nothing, say so on the index rather than touching the sheets.

### 9. Settings → Integrations and Connections — new

Precedent: settings section (the FX ledger). Two sheets. **Integrations**: installed rows with version, status, last run, last error; Apollo enabled; a breaker-disabled row with Reset; a degraded old-sdk row naming the fix; a **watches** count in the right lane for engines that watch (project 19, D72). **Connections**: one row per `(product, account)` — Drive, Calendar, Gmail — each with its own scopes listed as D66 names them, status and Disconnect; the admin-entered OAuth client above them. Decisions: D66, D72, project 19's ledger milestone.

### 10. Files on a record with a linked Drive folder — re-read S1–S4

Precedent: p-D-0. Rule pass only. Confirm the read-only Drive tree under the folder name, native files opening in Google, `retain: text` shown as a value not a sentence, the unlink confirm with its counts. Decision: D66.

## What Part two adds to Components and Patterns

Drawn once on their own page and referenced from the Surfaces sheets, never redrawn per surface.

- **Components:** the watch row (engine mark, cadence or "manual", last run, live status cell, Run now); the action card (proposal, evidence refs, Apply, as Ask and Review both use it); the call strip (which tools a turn called, Spaces and plugin alike); the criteria field (in-place editable sentences under a title); the space head's path breadcrumb; the add-record and file-record cards as card variants.
- **Patterns:** a queue grouped by head (Review under space heads; also the Interactions section filtered by kind); a palette with a preview pane (Cmd-K, Ask); a record with rail lanes that stream (the space page's Watching and What's moving, over D64).

## Out of scope

- Dark mode, new colours, new type steps.
- Redesigning shipped routes beyond The Separation Rule.
- The two-axis routing grid (`ai-4b`); it has its own approval path.
- Harmonic's filter form (project 23 ships Exa first; the watch settings form is generated from the manifest and takes the dialog grammar as given).
- Any surface for projects 20–22 beyond sheets 9 and 10; their canvas is p-D-0.

## Deliverable

Part one: the inventory and mapping, approved, then the six pages. Part two: the ten Surfaces sheets, the Components and Patterns sheets they add, and an index on Surfaces with numbered owner questions and one line per sheet saying new / re-read-changed / re-read-unchanged. When the owner has reviewed it, the slice bodies for projects 23–26 are written citing sheets by number, and the projects go to Linear.

## Status — 2026-10-06

Part one done: six pages, 17 archived sheets with pointers, the v1 flows deleted. Part two done: Components › "Research · Ask · Watches" and "Readout strip · variants"; Patterns P8 amended, P9–P11 added; Surfaces K1 Cmd-K, A1 Ask, SP1 Space, R1 Review, T1 Today, I1 Integrations, C1 Connections, F1 Fathom, strips on O1–O4 and E8 converted to variant B with section counts dropped, `esc`/`↵`/dialog `⌘↵` hints stripped across the page, M1 archived as a second Today. The Surfaces index (00, at x −1520) lists every sheet with its status and five owner questions. Next: the owner reviews the canvas, then the slice bodies for projects 23–26 are written citing sheets, then the Linear upload.
