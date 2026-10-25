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

### Where the rules live

The canvas's rules and verdicts are recorded, not kept here. The vocabulary, the
hierarchy ladders, casing, dates, dither and A1–A10 with H1–H3 are in
`docs/design-contract.md` §1; the primitives in §2; the record anatomy in §3; the
surface verdicts the code has not reached yet in §5. What changed a decision is an
amendment of 2026-10-25 in `docs/decisions.md` (D63, D64, D70, D73, D74, D79, D81).
Where a board and the contract disagree, the contract is right until the owner amends
it.

### Review loop

Each page: drift check against Kit + grammar (orchestrator) → owner verdicts,
one page at a time, as Paper comment threads on the board → fixes back to the
same agent → verdicts written to memory, then into the contract and the decision
amendments once per wave.
