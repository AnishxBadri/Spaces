# Product map

Every surface of Spaces, grouped by shape, with where its design and its build
stand. The canvas (Paper file `spaces`) is organised the same way: one page per
shape. Draw by shape, read by feature — a feature is a path through this map,
not a page of its own.

Status columns: **design** P = printed sheet exists (pre-grammar), L = library
parts only, — = nothing. **build** ✓ shipped, # queued slice, h waiting on an
owner decision.

## The seven spines

Shell → Today (attention) → Lists (find) → Record (work) → Windows (act without
leaving) → Ask / Cmd-K (across everything) → Settings. Files, Email, Meetings and
Enrichment are each a list + a record tab + a window, so the record anatomy
decides most of the surface area and is designed first.

## 1. Shell — Paper page `Shell`

| Surface               | What                                                                                                                                                             | Design                | Build |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| Sidebar A             | Today · Tasks · Spaces · Notes · Meetings · Files · Companies · People · Deals · Portfolio · Mandate; starred spaces, overflow, account row, Ask + Settings foot | P (p-J, drawn 5 ways) | ✓     |
| Sticky head           | page/record head folds to a 40px bar                                                                                                                             | P                     | ✓     |
| Keyboard help, toasts |                                                                                                                                                                  | L                     | ✓     |
| First run (D80)       |                                                                                                                                                                  | P (p-O)               | ✓     |
| Login · Setup · Join  | `/login` `/setup` `/join`                                                                                                                                        | —                     | ✓     |

## 2. Today — Paper page `Today`

| Surface     | What                                                                                                                                  | Design  | Build |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| Today (D79) | day strip · Needs-you ledger (suggestions, duplicates, proposals, notices band) · Meetings with Prep · rail Portfolio + What's moving | P (p-O) | ✓     |

## 3. Lists — Paper page `Lists`

One shape, many objects. `PageHeader` with tabs (views), view bar, filter row,
`RecordTable`, selection bar.

| Surface                                                                            | What                                                                                   | Design              | Build |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------- | ----- |
| Companies · People · Deals (table + board) · Portfolio · Files · custom `/o/$slug` | the object list                                                                        | L                   | ✓     |
| Views                                                                              | saved/pinned views, filter row, column run, sort, stat columns, bulk enrich, list menu | L                   | ✓     |
| Tasks                                                                              | Open/Done                                                                              | —                   | ✓     |
| Notes                                                                              |                                                                                        | —                   | ✓     |
| Meetings                                                                           | upcoming by day with Prep, past with the unwritten first                               | P (p-N, stale keys) | ✓     |
| Mandate                                                                            |                                                                                        | —                   | ✓     |
| Spaces index                                                                       |                                                                                        | P (p-I)             | ✓     |
| Review                                                                             | All / Suggestions / Duplicates, pair compare                                           | —                   | ✓     |
| Import                                                                             | wizard, mapping grid, preview ledger, batch receipt                                    | —                   | ✓     |

## 4. Record — Paper page `Record`

The most-used surface. One anatomy, seven kinds.

| Surface          | What                                                                                                                          | Design                   | Build                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Anatomy          | head (A4, ≤7 things) · tabs Overview · Notes · Interactions · Files · History · rail (attributes, relations, spaces, waiting) | L (Hierarchy After only) | ✓; Overview tab # (amends D74)                       |
| Kinds            | company, person, deal, holding, custom object, term, note, space                                                              | —                        | ✓                                                    |
| Space page       | 3 readouts, criteria, Watching lane, What's moving, Notes/Files tabs, move/split/archive                                      | P (p-I)                  | ✓; watch-4 #                                         |
| Holding          | portfolio detail, ledger, void flow                                                                                           | —                        | ✓                                                    |
| Files tab        | folder band, revisions, superseded, add row                                                                                   | P (p-F)                  | ✓; 264 first sync #, 271/281 #, mirror root h        |
| Interactions tab | two-line thread rows, kind filter, week bands                                                                                 | P (p-G)                  | 268 viewer ✓; 278 drafts #, 285/286 #, 277 privacy h |
| Notes tab        | From meetings, via, superseded dim                                                                                            | —                        | ✓; 265/274/316 h                                     |

## 5. Windows — Paper page `Windows`

Everything that opens over a record without leaving it.

| Window                                                                                              | Design  | Build             |
| --------------------------------------------------------------------------------------------------- | ------- | ----------------- |
| Email viewer · reply/forward/new · review · drafts · templates + variables                          | P (p-G) | 268 ✓; rest # / h |
| File viewer + sidebar · upload · newer version · link folder · storage picker                       | P (p-F) | ✓                 |
| Meeting · Prep (M2) · Granola write-up                                                              | P (p-N) | h                 |
| Log interaction · create company · enrich · suggest spaces · plugin actions · space move · confirms | L / —   | ✓                 |

## 6. Ask — Paper page `Ask`

| Surface           | What                                                               | Design                | Build                  |
| ----------------- | ------------------------------------------------------------------ | --------------------- | ---------------------- |
| Cmd-K             | finder, 4 groups, preview pane, contextual actions                 | P (p-H, 04 B/C stale) | ✓                      |
| Ask dock + `/ask` | threads, citations, @scope, action cards, Find table, Save as note | P (p-K, pre-Library)  | ✓; 318 Save as watch # |

## 7. Settings — Paper page `Settings` (D81)

| Group        | Pages                                                                            | Design  | Build |
| ------------ | -------------------------------------------------------------------------------- | ------- | ----- |
| You          | Email & calendar (+ connection), Files (+ connection), Meeting notes, API tokens | P (p-M) | ✓     |
| Workspace    | General, Members, Objects (+ per-object), Templates, Currency & FX               | P       | ✓     |
| AI           | Models, Search, Usage & limits                                                   | P       | ✓     |
| Integrations | Plugins (+ per-plugin page), Enrichment, Email forwarding, Connection apps       | P (p-L) | ✓     |

Legacy routes still in the tree (`/settings/{ai,arrival,connections,integrations,embeddings,workspace}`, `/inbox`, `/documents`, `/dedupe`) — redirects or dead; not surfaces.

Landing (apps/site) is out of scope for now.

---

## The canvas

Pages: Foundations · Kit · Grammar (library) · Shell · Today · Lists · Record ·
Windows · Ask · Settings (product) · Archive. The ten printed pages of 10-08/09
are **source** for the product pages — approved pieces are cloned out of them
with the grammar applied on the way — and move to Archive once their product
page is adopted. Surfaces B-0 goes to Archive.

Order: Record → Lists → Settings (wave 1) → Windows → Today → Ask → Shell
(wave 2). Record is verdicted before wave 2 starts; Windows and Today build on
it. Cards are designed on the first page that needs them.

### How a page is drawn

- One board per shape instance, 1440 wide, `height: fit-content`, in a row at
  x = 0, 1520, 3040 … (a second row at y = 2400 if the page needs it). Board
  name is `NN Title`. Inside: a mono caps label (11px, graphite,
  `01 · ANATOMY`), the UI, then a **states strip** (rest · hover · focus ·
  selected · empty · loading · error · overflow) and **interaction instances**
  side by side (menu open, row selected, head folded, inline edit). Cases are
  drawn, not written.
- Build from Kit by clone (`<x-paper-clone node-id="…" />` or
  `duplicate_nodes`); never redraw a primitive. Kit boards (page 9-0): Actions
  WTD-0, Inputs WZ6-0, Navigation X59-0, Data X8V-0, Overlays UBA-0, Display
  U4G-0, Chassis UDH-0, Ledger UJL-0, Record parts UN1-0, Marks and chips UPX-0.
  Foundations (8-0): Hierarchy V7H-0 is the reference record; Foundations 40Q-0
  the type scale; Motion 6TJ-0 and State changes TLH-0. Grammar (A-0): Action
  grammar UX6-0 (A1–A10, H1–H3).
- Mock data comes from the schema — `SYSTEM_ATTRIBUTES`
  (`packages/core/src/attributes/registry.ts`) and the enums — using the
  Exponent record set the Hierarchy board uses. No headline repeats a readout.
- Canvas text is title + UI. A hint survives only for cost, privacy or
  something irreversible. Text identical on every instance is documentation:
  delete it or make it a tooltip. Each board carries one caption naming the code
  symbol it draws (`RecordHeader · record-parts.tsx`) and `proposed` where the
  drawing is ahead of or contradicts the code.
- Tokens only, no raw hex. Fonts Inter · Source Serif 4 · JetBrains Mono.

### The rules in force (canvas-decided, not all in the contract yet)

- **Hierarchy, three ladders, no new tokens.** Text: value ink 13–14, label
  graphite sans 12, kind graphite mono caps; nothing lighter than graphite.
  Surface: paper = work, bone = frame, bone-deep = pressed. Line: double rule
  once, ink = structure, rule inside a pane, space inside a group. Attribute
  grid = bone label cell + paper value cell.
- **Casing.** CAPS mono only for kinds and band/group labels. Tabs, field
  labels and everything else sentence case. Nothing starts lowercase.
- **H1** an empty section is one row: name in graphite + `+`. No sentence, no
  composer, no 0. Exception: absence that is news keeps its sentence.
- **H2** you are never listed among a row's people; a sent row reads `To X`.
- **H3** a list prints the day; time lives in the viewer or a tooltip; long
  lists break by week on bone bands. Exception: today's rows and scheduled
  meetings show time.
- **Record.** No readout strip under the title. Overview is the default tab
  (readouts with a value, open tasks, latest 3 threads, latest files, each
  ending on a link to its tab). Rail = attributes + relations. Head per A4,
  ≤7 things.
- **Tabs.** One tab bar per screen, bone bar, sentence case, mono counts,
  no count at 0, straight ink-edged open tab. A nested switch is a bounded
  Segmented (28px, selected = paper inside a bone band, counts inside; the
  title then carries no count).
- **Dates, app-wide** (owner 10-15): today `10:42` (or `Today` in a
  readout), this year `13 Oct`, older `4 Oct 2024`. No `MM-DD`. Hand-rolled,
  never `Intl`.
- **Every record has an Overview tab and no readout strip** (owner 10-15),
  spaces included: a space's Overview holds its readouts (in pipeline, last
  filed, the funding-stage bar), What's moving, open tasks and the latest
  companies; its rail keeps Criteria, Watching and Map. The holding has one
  view and no tab bar, so its figures sit at the top of the pane.
- **Empty tab** = one `Name +` row (H1), no composer. A tab with rows keeps
  its composer row. Custom-object heads carry Log interaction when the object
  links people; the space head is `···` only.
- **Keys** never inside a button; tooltip. **Dither** never moves at rest;
  only for a state change, Bayer order, stepped, 1-bit. Popover dithered,
  window solid.
- **Cognitive load first.** Rare things into menus, dropdowns, tooltips; state
  shown only when non-default. The company head 16 → 7 is the reference case.
- A1–A10: the Grammar board. The design contract (`docs/design-contract.md`)
  holds the rest; where it disagrees with a rule above, the rule above wins and
  the contract is amended after the wave.

- **Settings nav group heads are ruled bands (owner 10-24):** YOU · WORKSPACE · AI ·
  INTEGRATIONS in ink mono caps with a hairline under, the LabelHead grammar the
  settings ledgers use; no graphite whisper. Drawn on Settings 09 §8.
- **Connections (owner 10-24):** a connection is a provider with an admin-registered
  OAuth app serving a core job (Google, Box, Microsoft later); bundled, never
  installed. Everything else, recorders included, is a plugin. Integrations nav =
  Connections · Plugins · Enrichment · Email forwarding. A provider is a sub-page
  with two Kit tabs, Set up · In use; the first Set up row asks Workspace or
  personal Gmail. Sync health per use lives on In use; no Gmail plugin page.
  Reconnect is a Today line. Drawn on Settings 09.

### Canvas verdicts 10-16 (recommendations taken; not yet in the contract)

- **Lists** (confirmed): applied filters are chips under the bar; row `···` on hover
  (Add to space · Copy link · Archive); bulk = Enrich… (outline) + Add to
  space, no Tag; first run = one `Name +` row. Column heads sentence case.
- **Today:** single suggestions decided in place, groups → Open in Review ›;
  Undo on accept, dismiss and Ask cards by holding the write ~5s; no day strip
  without a calendar (amends D79); Needs you above Meetings; head = title +
  date; readout strip kept, non-zero figures only, each figure filters Needs you (confirmed; cards compared on Today 08).
- **Ask:** Cmd-K one fixed size — width and height (confirmed 10-24: e.g. 1060 × 560, results scroll inside, empty/typing/no-results/loading in the same box, preview pane always present, shrinks only with the screen); scope chips in the composer (amends D70);
  a citation previews its passage on hover; stamps are plain rectangles.
- **Windows:** a second window steps down under its parent (one stacked at
  most); plugin verbs live in the record `···` (amends D63/D64); confirms say
  Cancel; reply opens as Reply; four sizes S 440 · M 560 · L 768 · viewer 1152.
- **Shell:** Ask at the sidebar foot (⌘J), Upload off the account row; the
  workspace head opens General · Members · Invite; password reset is an
  admin-issued one-time link; the phone drawer hides key hints; sidebar counts
  are ink, red only for overdue.
- **Settings:** the Meeting notes page (key + folders) is SPA-265's design.

### Review loop

Each page: drift check against Kit + grammar (orchestrator) → owner verdicts,
one page at a time, as Paper comment threads on the board → fixes back to the
same agent → verdicts written to memory and here; contract and D-amendments
once per wave.
