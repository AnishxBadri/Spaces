# Backlog bodies — projects 14 to 29

_The slice bodies of projects 14–29. Project 27 (the printed design port), the split of project 23 into 23, 28 and 29, and the 2026-10-09 amendments to 23–25 were written after the 10-08 canvas verdicts. Projects 19–26 and Corrections were published to Linear on 2026-10-06 (`SPA-215`…`SPA-299`), each issue carrying its body verbatim with a footer naming the slice key; this file stays the source — amend both together. Projects 14–18 shipped from Linear before that; their sections here are history._

_Siblings: `docs/roadmap-2026-09.md` (all 23 projects and the audit), `docs/decisions-2026-09.md` (the 48 closed decisions), and the four `docs/spec-*.md` contracts these slices implement. Ordered exactly as the roadmap orders them. Published at the same time as the rest of the plan (2026-09-15, reconciled) and unchanged since, except where a decision in `docs/decisions-2026-09.md` amends a slice — those amendments are noted inline and the decision is authoritative._

**These are a backlog with an order, not a commitment.** The 2026-09-15 audit's verdict: everything from project 17 onward should not be scheduled until a user has asked for something in it, and half of project 22 is speculative until then. Publish a project to Linear when you reach it, not before — an issue nobody can start is a distraction with a number on it.

---

## 14. Import and export — a spreadsheet becomes the graph

_Spaces v1 · 12 slices_

The onboarding-critical channel: every prospective user has deal flow in a spreadsheet today and a portfolio that predates the product. Read CSV and XLSX into one grid, map onto the object registry so a custom object imports with no importer change, preview attach-or-create before anything is written, commit idempotently, and bootstrap holdings as dated events rather than balances — with a correction door, because the event tables are append-only and an import commits forty rows at once.

### ▸ A spreadsheet reads and maps

_Drop the messy CSV or xlsx onto /import, pick any object in the registry, and every column says where it lands and how many of its values will parse — '38 of 40', with the two offenders and their reasons one click away, and a Stage column reading 'Seed' against an option that does not exist refused by name rather than invented. Nothing has touched the graph and no new dependency entered package.json._

#### `import-1` · afk · M — Spreadsheet reader — CSV and XLSX to one cell grid

**Blocked by:** none

**What to build**

There is no import code in the repo: `src/lib/server/` has no import module, `package.json` has no CSV or spreadsheet dependency, and the only spreadsheet code that exists is `fromXlsx` in `src/lib/documents/extract.ts`, which flattens cells to tab-joined text for search and throws the grid away. Add a pure `src/lib/import/read.ts`: `readGrid(bytes, filename) → { sheets: Array<{ name, headerRow, rows: string[][] }> }`, with no new dependency. CSV is hand-rolled RFC 4180 (quoted fields carrying commas, doubled quotes and embedded newlines; BOM stripped; CRLF and LF identical; delimiter sniffed across `,` `;` and tab on the header line, because a European export is semicolon-delimited and configuring that is an onboarding failure). XLSX reuses the OOXML machinery already in extract.ts — `unzipSync` from fflate plus `sharedStrings`, `sheetNames` and `worksheetRows` — which this slice lifts into the shared reader, leaving `fromXlsx` composing it, so the repo keeps one xlsx parser rather than two. The reader also resolves numeric cells carrying a date number format (styles.xml → numFmtId) to `YYYY-MM-DD`: a serial landing as "45000" in a date column is the single most common import failure, and no later slice can recover the intent. Header detection is the first row with no blank and no duplicate cells — deterministic, no AI. Foundation exception, stated plainly: the reader has no surface of its own, but five later slices key on it and extract.ts is its immediate in-repo consumer, which is what keeps it from being a dead module.

**Acceptance criteria**

- [ ] `readGrid` returns one entry per sheet under the sheet's real name for .csv, .tsv and .xlsx, chosen by extension and sniffed content rather than by MIME alone
- [ ] A CSV field containing a comma, a doubled quote and an embedded newline round-trips into one cell; a UTF-8 BOM never survives into the first header; CRLF and LF files produce identical grids
- [ ] The delimiter is sniffed across `,`, `;` and tab from the header line, and a semicolon-delimited European export parses with no configuration
- [ ] A numeric xlsx cell whose style is a date format comes back as `YYYY-MM-DD` — a fixture asserts serial 45000 → 2023-03-15 — and a genuinely numeric cell is untouched
- [ ] `extract.ts`'s xlsx text path composes the shared reader; its existing tests pass unchanged and `unzipSync` appears in exactly one module
- [ ] A file above the row cap (20,000 data rows) is refused by name with its row count, never silently truncated
- [ ] `DATABASE_URL= pnpm exec vitest run src/lib/import/read.test.ts` is green with Postgres stopped
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — `DATABASE_URL= pnpm exec vitest run src/lib/import` over four fixtures — a quoted CSV with embedded newlines, a `;`-delimited export, a BOM'd file, and a two-sheet xlsx carrying a date serial and a shared string — all green with the database down; then `pnpm exec vitest run src/lib/documents` still green, proving extract.ts now reads through the same parser.

**Spec** — CONTEXT.md — The integration map #10 (migration/import, onboarding-critical); CONTEXT.md — phase 15 item 9, "Portfolio bootstrap import" (upload CSV/XLSX); src/lib/documents/extract.ts — fromXlsx, sharedStrings, sheetNames, worksheetRows

#### `import-2` · hitl · M — Staged import — a spreadsheet becomes a batch, nothing reaches the graph

**Blocked by:** `import-1`, `storage-6a1`

**What to build**

The staging tables and the wizard's first step. `import_batch(id, blob_sha, filename, sheet, mode: records|ledger, target_object_id → object, mapping jsonb, status: staged|planned|committed|failed, row_count, created_by, created_at, committed_at)` and `import_row(id, batch_id → import_batch, row_num, cells jsonb, plan jsonb, verdict, entity_id → entity, error, unique(batch_id, row_num))`. The payload is a blob, not a document: it stages through storage-6a's arrival module and stops at the blob — no `document` row, no edge, no extraction, no chunk, no embedding — because a portfolio spreadsheet must never become AI context, and because `finalizeDocumentUpload` still requires an `attachTo` today (an unfiled document is docsurf-6b's ground, not ours). The wizard posts the file to the server rather than hashing in the browser, so the repo's one `crypto.subtle` call stays docsurf-6a's. `import_row.entity_id` is a new entity-referencing column and needs its ENTITY_REFS entry — merge `repoint`, context role `null`, because a staging row is bookkeeping and must never enter a prompt. Route `/import`: pick a file, pick Companies / People / Deals / any custom object straight from the object registry, see the sheet tabs, the detected header row and the first 20 rows. hitl: this is the wizard's chrome — a stepped surface the product does not have — and it must be judged against DESIGN.md while the Instrument port is still mid-flight.

**Acceptance criteria**

- [ ] Uploading a 2 MB CSV creates one `import_batch` and one `import_row` per data row, with the raw cells preserved verbatim
- [ ] The same file uploaded twice reaches the same blob sha, and the wizard says when it was last imported and what that batch wrote instead of silently staging a duplicate
- [ ] Bytes are stored through the arrival module's blob half; a test counts `document` rows before and after and they are equal, and `grep -rn 'crypto.subtle' src` still returns exactly one line
- [ ] The object picker lists every non-archived object from the registry, system and custom alike, rendering each plural noun verbatim
- [ ] `entity-refs.test.ts` passes with the `import_row.entity_id` entry, and deleting that entry fails the test naming the column
- [ ] Migration generated with `pnpm db:generate --name import_batch` and hand-inspected; `pnpm generate-routes` ran and the generated tree is committed
- [ ] The wizard chrome is reviewed against DESIGN.md before merge; new .tsx passes gate 5
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Open /import, drop the messy deal-flow CSV, pick Companies: the sheet's header row and its first 20 rows render in the wizard. `select status, row_count from import_batch` shows one staged batch; `select count(*) from document` is unchanged from before the upload.

**Spec** — CONTEXT.md — phase 15 item 9 (one wizard: upload → map → preview → dry run → commit); CLAUDE.md — ENTITY_REFS rule (merge strategy and context role); src/lib/server/documents.ts:48 — finalizeDocumentUpload requires attachTo; docs/spec-storage-sources.md §3.1 — one server arrival path

#### `import-3` · afk · M — Column mapping onto the registry — the type system is already the mapping

**Blocked by:** `import-2`, `objects-5`

**What to build**

The mapping step. Each source column takes exactly one target: the record's name, an attribute of the chosen object, one of the object's identity keys, or ignored. Because the attribute registry already is the type system, the mapping is generated from it and custom objects work with no importer code — that is the whole reason this is cheap. Identity-key targets come from one helper: a company's domain and a person's email (D75), and `object.identity_keys` for a custom object, which objects-5 declares — the repo must not grow a second notion of what identifies a record. Auto-guess is deterministic: slugify the header, match an attribute slug, then an attribute name, then a small alias table (`Website` → domain, `Company` → name, `Round` → the deal's stage), and default to ignored when nothing matches, never to a guess. The mapping persists on `import_batch.mapping` so leaving the wizard and coming back resumes. Archived attributes and types no cell can carry are not offered.

**Acceptance criteria**

- [ ] Mapping is generated from the registry: create a custom object with three attributes and its columns map with no code change and no new branch
- [ ] A header matching an attribute slug or name is pre-selected; an unmatched header defaults to ignored and says so
- [ ] Identity-key targets read `object.identity_keys` for custom objects and the core four for company/person through one helper; grep shows no second list of identifying keys
- [ ] Exactly one column may map to the name; a mapping with none is refused with a reason before the step advances
- [ ] Two columns may not map to one attribute — the second selection clears the first and names what it replaced
- [ ] The mapping survives a reload because it lives on the batch row, not in component state
- [ ] The mapping table uses the shipped picker vocabulary and introduces no new control; gate 5 holds in the touched tsx
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Objects → New object "Funds" with three attributes; back on /import, map a Funds sheet — the picker offers those three attributes and the declared domain key, with no importer change. Reload the page mid-mapping and the choices are still there.

**Spec** — CONTEXT.md — phase 15 item 9 (map columns onto the registry/event fields); docs/spec-attribute-engine.md §9 — UI is registry-generated or it doesn't ship; src/lib/attributes/registry.ts — AttributeType, AttributeOptions

#### `import-4` · afk · M — Cell coercion per attribute type — and the columns that will not parse

**Blocked by:** `import-3`

**What to build**

A pure `src/lib/import/coerce.ts`: `(type, options, raw) → { ok: true, value } | { ok: false, reason }` for every `AttributeType`. number and currency strip thousands separators, currency symbols and parenthesised negatives, and handle the Indian grouping a rupee sheet actually contains. date takes ISO plus d/m/y or m/d/y **only when the mapping declares which** — never sniffed, because 03/04/2026 is two different dates and guessing wrong is silent. checkbox takes yes/no/true/false/1/0. select, multi_select and status match option labels case-insensitively and refuse an unknown label rather than minting an option, because importing must never expand a curated vocabulary. domain, email, url and phone call the existing normalizers in `src/lib/entities/normalize.ts` — no second normalizer. rating bounds by `options.max`. record_reference and actor_reference are refused here and answered by import-6. The mapping table then tells the truth about each mapped column — "38 of 40 values parse" — with the failures and their reasons one click away, which is what turns a silent 300-row disaster into a two-cell fix in the sheet.

**Acceptance criteria**

- [ ] Every AttributeType has a coercion test naming the shapes it accepts and rejects, all running with Postgres stopped
- [ ] `(1,250.00)` in a currency column becomes -1250 and `₹1,25,000` becomes 125000; `TBD` becomes a reason, never 0
- [ ] A date column carries a declared order chosen in the mapping; with none declared an ambiguous value is a reason while an unambiguous ISO value still parses
- [ ] A select value that is not an existing option is refused naming the value; no option is ever created by an import
- [ ] The mapping table shows a per-column parse count with the failing rows and reasons behind it, and calls out a column where nothing parses before the step advances
- [ ] domain/email/url coercion delegates to `src/lib/entities/normalize.ts`; grep shows no duplicated normalization
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Map a sheet whose Amount column mixes `$1,250`, `(400)` and `TBD`: the column reads "38 of 40 parse", clicking shows the two offending rows with reasons, and the Stage column reading "Seed" against a status attribute with no such option refuses by name rather than inventing one.

**Spec** — CONTEXT.md — phase 15 item 9 (per-row errors, never all-or-nothing); src/lib/entities/normalize.ts — normalizeDomain / normalizeEmail / normalizeLinkedin; src/lib/attributes/registry.ts — per-type validators and options

### ▸ The first import lands

_A 46-row company sheet and a 40-row deal sheet become companies, deals and people: the preview says '31 create · 12 attach · 3 errors' before anything is written, reference cells find their record or error naming both candidates, near-duplicates queue in the existing review inbox instead of appearing as silent twins, and re-running the same file writes nothing._

#### `import-5` · afk · M — Resolve preview — attach or create, decided before anything is written

**Blocked by:** `clean-3`, `import-4`

**What to build**

`resolveEntity` has no dry-run mode: it creates inside step 2 and fuzzy-sweeps in step 3, so a preview that called it would write. Add `previewResolve` beside it in `src/lib/entities/resolve.ts` — the read-only twin of step 1, sharing `normalizeKeys`, the identity-alias lookup and the `canonicalId` redirect, returning `{ verdict: 'attach', entityId, matchedOn }` or `{ verdict: 'create' }` and inserting nothing. The preview also catches what `resolveEntity` structurally cannot: two rows _inside one file_ claiming the same domain, because the second row does not exist yet when the first is written. Each `import_row` gets its plan — verdict, the coerced patch, and its per-row errors — persisted, so the dry-run report is a stored artifact the commit later replays rather than a recomputation that could disagree. The report is the dry run: "31 create · 12 attach · 3 errors · 2 rows collide with each other", each list openable, nothing written to the graph. Reconciliation worth stating in the PR: resolve.ts's header claims every entity creator goes through it, but `EntityKindResolvable` is company/person/organization only — deals are a direct `db.insert(entity)` in `createDeal` and custom records are `createRecordProgram`, which comments "No aliases, no dedupe sweep — that's core-only machinery". The preview therefore routes to three creators, and says which one each row will use.

**Acceptance criteria**

- [ ] `previewResolve` performs no insert — a test previews 50 rows and counts `entity`, `entity_alias` and `duplicate_candidate` unchanged
- [ ] A row whose domain matches an existing company previews as attach and names the matched key; previewing the same row twice gives the same answer
- [ ] Two rows in one file carrying the same identity key are reported as an in-file collision and neither is planned as a create
- [ ] A row with neither a name nor any identity key is an error matching resolveEntity's own refusal, and never aborts the rest of the batch
- [ ] The report says which creator each row will use — resolveEntity, the deal birth path, or createRecordProgram — rather than implying one door that does not exist
- [ ] Changing the mapping invalidates the stored plan and the preview recomputes; a stale verdict is never shown
- [ ] The report renders in the record-table row vocabulary with a verdict column and adds no new card shape; gate 5 holds
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Preview a 46-row company sheet where 12 companies are already in the CRM: the report reads "31 create · 12 attach · 3 errors", the attach list names the matching domain per row, and `select count(*) from entity` is identical before and after.

**Spec** — src/lib/entities/resolve.ts — THE choke point, steps 1–3, EntityKindResolvable; src/lib/server/deals.ts:25 — deals are a direct insert, not resolveEntity; src/lib/attributes/object-registry.ts:175 — createRecordProgram, "No aliases, no dedupe sweep"; CONTEXT.md — phase 15 item 9 (resolve-preview before anything is written)

#### `import-6` · afk · S — Reference cells find their record — a deal's company column

**Blocked by:** `import-5`

**What to build**

Deal flow in a spreadsheet is one row per deal with a company _name_ in a cell, so record_reference is the crux of the headline use case. A reference cell resolves through the same matcher as the rest of the preview: identity key first, then an exact `entity_alias` name match scoped to the referenced object, then failure. No fuzzy attach, ever — a near-match is a per-row error the operator fixes in the sheet, because silently attaching a deal to the wrong company is worse than a row that refuses. A reference target the file does not contain may optionally be created (a checkbox in the mapping, default off) which plans a second create row against the referenced object and shows up in the header counts. actor_reference matches a workspace member by email and errors on an unknown address rather than falling back to the importing user.

**Acceptance criteria**

- [ ] A Deals import whose Company column names an existing company plans a reference to it, and the preview shows which record it found
- [ ] A company name matching two records is an error naming both, never a coin flip
- [ ] With "create missing companies" off an unknown company is a per-row error; with it on the preview shows the extra creates and the header counts change accordingly
- [ ] actor_reference resolves a member by email and errors on an unknown address
- [ ] Reference matching is exact-only: no new fuzzy path is added to resolve.ts, and the code says why in a comment
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Preview a 40-row deal sheet against Deals: rows naming companies already in the CRM show the matched record, one ambiguous name errors naming both candidates, and flipping "create missing companies" on changes the header from "37 plan · 3 errors" to "37 plan · 6 companies also created".

**Spec** — src/lib/attributes/registry.ts — record_reference targetKind / targetObjectId; CONTEXT.md — Entity resolution & merge (deterministic auto, probabilistic suggest); src/lib/entities/resolve.ts — addIdentityAlias, exact-key matching

#### `import-7` · afk · M — Idempotent commit — the first import lands, and a re-run writes nothing

**Blocked by:** `clean-2b`, `import-6`, `objects-1a`, `sdk-1`

**What to build**

A worker job `import.commit` — registered in the one QUEUES definition and running inside sdk-1's `runJob`, so it leaves a `job_run` row like every other job — replays the persisted plan row by row, each row in its own transaction. Companies and people go through `resolveEntity`; deals go through a deal-birth program this slice extracts out of `createDeal`'s handler, because the stage=`invested` → `birthHolding` hook currently lives inline in a serverFn (src/lib/server/deals.ts:58) with no reusable program and the importer must not own a second copy of the pipeline→portfolio seam; custom records go through `createRecordProgram`, which gains the `source` parameter it lacks today (it hardcodes `source: 'manual'`) so an imported record is honestly an import. Values land through `setValues` with the source and the batch id, so every imported cell carries an `attribute_event` receipt naming the importing human. Re-running skips rows that already hold an `entity_id`; a per-row failure is recorded with its reason and that row alone is re-runnable after the sheet is fixed. Near-identical names become `duplicate_candidate` rows through the creators' own sweeps — for custom objects that is objects-1a's object-scoped sweep, not resolveEntity's — so a messy spreadsheet feeds the existing inbox instead of creating duplicates silently. An import is a human write, not a machine one: it writes values directly and never proposes.

**Acceptance criteria**

- [ ] Committing a 200-row sheet creates the records, and committing the same batch again changes no row count in `entity`, `entity_alias`, `attribute_event` or any side table — asserted end to end against the DB
- [ ] A row that fails leaves every other row committed, records its reason, and can be re-run on its own
- [ ] Every imported value carries an `attribute_event` with the importing user as actor and the batch id; no machine actor appears anywhere in the import path
- [ ] A custom-object import produces `duplicate_candidate` rows for near-identical names through objects-1a's object-scoped sweep, and a same-name record in a different object produces none — both asserted
- [ ] A Deals row at stage `invested` births its holding through the extracted program, and a test drives both `createDeal` and the importer through it asserting identical results
- [ ] `createRecordProgram` takes a source; the dialog and seed callers pass theirs and their behaviour is unchanged
- [ ] The batch page is the receipt — counts, per-row verdicts and links to what was created — and progress polls the batch row, with a comment naming sdk-18's SSE as the upgrade this slice deliberately does not build
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Commit the 46-row company sheet and the 40-row deal sheet: /companies and /deals fill, three near-duplicate names are waiting in the review inbox, and `select queue, status, duration_ms from job_run` shows the commit run. Hit commit again — the batch page says 0 written, and every table count is unchanged.

**Spec** — CONTEXT.md — phase 15 item 9 (idempotent commit, per-row errors); src/lib/server/deals.ts:20–61 — createDeal's inline invested → birthHolding hook; src/lib/attributes/object-registry.ts:175 — createRecordProgram hardcodes source 'manual'; CLAUDE.md — gates, and the ENTITY_REFS / merge-snapshot rule

### ▸ An angel arrives with a portfolio

_A 12-row tracking sheet becomes holdings with dated rounds, investments and marks — events, never balances — so MOIC, IRR and as-on views work on day one for checks that predate the product, with missing FX surfaced rather than faked. And because those tables are append-only with no edit path, the correction door lands first: a reversing entry with a reason, the same door ai-22's accepted proposals use._

#### `import-8` · afk · M — Ledger mapping — one spreadsheet row becomes dated events

**Blocked by:** `import-6`

**What to build**

Mode `ledger`, the phase 15 bootstrap. The mapping targets are event fields rather than attributes: the company (through import-6's matcher), our check's date / amount / currency / instrument / cap / discount / shares / vehicle, the round's kind / date / raised / pre / post / price-per-share / shares-outstanding, and a current mark's value / date / basis. A pure `src/lib/import/ledger.ts` decomposes one row of the universal tracking sheet into dated events — an optional `round`, one `investment`, an optional `mark`, an optional `distribution` — and never a balance, because CONTEXT fixes aggregates as derived and "as on <date>" as a filter over events. Three rules that must not be guessed and are pinned here: an instrument cell reading "SAFE" is ambiguous between `safe_post_money` and `safe_pre_money`, so the mapping carries an explicit choice per distinct source value and an unmapped value is a per-row error naming both candidates; a mark with no date takes the batch's declared "marks as of" date, declared once in the mapping, never silently today; and a row carrying a cap but no round data plans no round at all rather than inventing one, because a fabricated round corrupts the dilution ledger permanently. The dry-run report grows a per-company event list — "Pixxel · round Seed 2023-03-15 · investment $50,000 priced · mark $120,000 2025-12-31".

**Acceptance criteria**

- [ ] One tracking-sheet row (company, date, amount, instrument, round, current value) plans exactly one investment, at most one round, at most one mark, and no aggregate of any kind
- [ ] A "SAFE" instrument value with no explicit mapping is a per-row error naming the value and the two enum members it could mean
- [ ] Two rows for the same company plan one holding and two investments; the second row plans no second holding
- [ ] A mark with no date uses the batch's declared as-of date, and with none declared the row errors rather than defaulting to today
- [ ] The planner is pure and its tests run with Postgres stopped; money arrives as numbers and becomes strings only at the write boundary
- [ ] The planner is a function of the row and the mapping and never of the clock — planning the same row twice produces byte-identical events
- [ ] The report lists planned events per company in date order inside the existing report surface; no new card shape
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Stage a 12-row angel tracking sheet in ledger mode and map it: the report shows, per company, the round, the check and the current mark it would write, one row errors because its instrument cell says "SAFE" with no choice made, and nothing exists in `round`, `investment` or `mark`.

**Spec** — CONTEXT.md — phase 15 item 9 and the spec refinements (append-only dated events; aggregates derived); CONTEXT.md — instrument subtypes carry ownership semantics (post vs pre-money SAFE); src/db/schema/portfolio.ts — round / investment / mark / distribution columns; src/lib/portfolio/ — pure libs take numbers

#### `import-11` — body never written

#### `import-9` · afk · M — Ledger commit — holdings born, events appended, nothing overwritten

**Blocked by:** `import-7`, `import-8`

**What to build**

Executes the ledger plan through the portfolio write path, which this slice first extracts: `addRound`, `addInvestment`, `addMark` and `addDistribution` hold their logic inline in serverFn handlers in `src/lib/server/portfolio.ts`, so an importer calling the tables directly would become a second writer into append-only history. Extract `addRoundProgram` / `addInvestmentProgram` / `addMarkProgram` / `addDistributionProgram`; the serverFns become thin callers and the importer calls the same programs. `birthHolding` already lives in server/shared.ts and is `onConflictDoNothing`-idempotent, so a holding is born once per company no matter how many rows name it. Event idempotence is a natural key per event — holding + date + amount + currency + kind/instrument — recorded on `import_row.plan`, so re-running a committed batch appends nothing. No edit or delete path ships and none may: CLAUDE.md calls the portfolio tables append-only by design and names the correction policy an open decision, so a wrong committed row stays until that decision exists. Currencies with no `fx_rate` are surfaced the way /today already surfaces them — "6 events need an INR rate on or before 2023-03-15", linked to the FX settings section — and never converted at 1.0.

**Acceptance criteria**

- [ ] A 12-row tracking sheet commits into holdings, rounds, investments and marks, and /portfolio shows invested, last mark and MOIC for pre-existing positions with no manual entry
- [ ] Re-running the committed batch appends nothing — a test counts `round`, `investment`, `mark` and `distribution` before and after and all four are unchanged
- [ ] No UPDATE or DELETE against the four event tables exists anywhere in the import path, asserted by a test over the module's SQL
- [ ] A row in a currency with no rate still commits and is counted in a missing-rate readout naming the currency and the earliest date needing a rate; nothing is converted at 1.0
- [ ] Both the serverFn handlers and the importer write through the extracted programs — a test drives one event through each caller and asserts identical rows
- [ ] A failed ledger row leaves the other rows' events in place and names the company it failed on
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Commit the 12-row tracking sheet: /portfolio fills with holdings showing invested, current value and MOIC, one company's detail page shows its Seed round, our check and the 2025 mark as three dated events, and /today's missing-fx count rises by the two currencies the sheet introduced. Commit again — four table counts unchanged.

**Spec** — CLAUDE.md — the portfolio event tables are append-only by design; correction policy is open; CONTEXT.md — currency conversion decided 2026-08-06 (missing rate surfaced, never 1.0); src/lib/server/portfolio.ts:386–583 — addRound / addInvestment / addMark / addDistribution; src/lib/server/shared.ts:117 — birthHolding, onConflictDoNothing

### ▸ Out as well as in, and a dialect is a plugin

_The data can leave — the question a self-hosted product must be able to answer — and an Airtable export imports through the same preview and the same commit as a hand-mapped CSV, proving the pipeline stays core while dialects live outside it. This milestone is the one part of the project gated on the SDK._

#### `import-12` — body never written

#### `import-10` · hitl · M — The importer kind gets its tenant — a dialect is a plugin, the pipeline stays core

**Blocked by:** `import-7`, `sdk-12a`, `sdk-5`

**What to build**

`docs/spec-plugin-sdk.md` §5 fixes `importer: { parse(file) → Claim[] }` and no bundle implements it, while core now owns reading, mapping, preview and commit — which is the right split under the doctrine that plugins feed the graph and never extend the product. The architectural choice this slice settles, and the reason it is hitl: whether an importer plugin returns a **grid** (the plugin only speaks the dialect; core still maps, previews and commits) or **claims** (already mapped; core previews and commits with no mapping step). Either way the plugin never writes — its output lands in an `import_batch` and walks the same preview and the same commit as a hand-mapped CSV. The tenant is an Airtable CSV export, which is genuinely a dialect and not a format: multi-select cells are comma-joined, linked-record columns carry display names rather than ids, and attachments arrive as URLs. Per-row errors must stay per-row, so whatever shape wins, a unit of output carries its row ordinal.

**Acceptance criteria**

- [ ] The chosen shape is recorded in CONTEXT.md and in spec-plugin-sdk.md §5 before code lands; if `parse` changes shape the SDK major is stated in the PR
- [ ] A 30-row Airtable export staged through the plugin previews identically to the same data pasted into a plain CSV
- [ ] Multi-select cells map onto the object's existing options and an unknown option is still refused rather than minted
- [ ] A malformed unit of plugin output fails its own row only, and the rest of the batch still commits
- [ ] The plugin receives only the ports its kind grants (Identity, Facts, Content, Judgment, Config, Log); a test proves a withheld port is a runtime "service not found"
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Drop an Airtable CSV export on /import: the dialect plugin is picked up automatically, the preview shows the same verdicts as the equivalent hand-mapped file, and committing produces identical records — then disable the plugin and the same file falls back to the plain CSV path with an explicit mapping step.

**Spec** — docs/spec-plugin-sdk.md §5 — importer: parse(file) → Claim[]; docs/spec-plugin-sdk.md §4 — kind → ports table (importer); CONTEXT.md — The integration map #10 (CSV/Airtable/Notion/CRM import); CONTEXT.md — plugins feed the graph and never extend the product

---

## 15. packages/core and apps/worker

_Extensibility · 8 slices_

The attribute and identity write paths, the vault, storage, seeds and the boot composition, the assembler and canRead move into packages/core; the dependency fence becomes lint; apps/worker becomes its own package carrying the already-shipped wrapper and heartbeat. This project ships no user-visible surface and is verified by regression — that is the success criterion for an extraction, not a smell.

### ▸ The write paths move

_Edit a select cell and a reference cell, merge two duplicate people, save a shared and a private view — all through code now in packages/core, with setValues' single-write-path fence enforced by lint and the author/admin guard still refusing a stranger._

#### `mono-8a` · afk · M — packages/core, attribute write path — setValues keeps its single-write-path fence

**Blocked by:** `mono-5`, `mono-7`

**What to build**

Move the db-coupled half of the attribute engine into @spaces/core: create.ts, update.ts, values.ts, defaults.ts, object-registry.ts and objects.ts (objectIdForKind, an Effect + db module the draft left unassigned). core gains @spaces/db as a dependency — the one internal dependency the rules allow. These are the modules the plugin SDK's Facts port will sit on top of, so they move before the SDK exists. One invariant rides along and must not loosen: the eslint rule pinning entity.values to a single write path — setValues, so validation, attribute_event and reference-link materialisation stay in one transaction — has to follow values.ts into core with its file glob widened from src/** to the workspace and its ignore list rewritten to the new paths. attributes/seed.ts deliberately stays behind for mono-9a, where it lands with lib/seeds and the boot composition. These suites are the first core tests needing Postgres, which is what mono-4 and mono-5 built.

**Acceptance criteria**

- [ ] packages/core depends on @spaces/db and nothing else internal; it still imports no react and no @tanstack/*
- [ ] The entity.values single-write-path lint rule lives with values.ts, its glob covers every package, and it still errors on a direct `.update(entity).set({ values })` outside it — verify by writing one in apps/web and seeing lint fail
- [ ] create/update/values/defaults/object-registry test files run as core tests against the test database and stay green
- [ ] apps/web's server fns import setValues and objectIdForKind from @spaces/core; no '#/lib/attributes/{create,update,values,defaults,object-registry,objects}' specifier remains
- [ ] turbo run test --filter=@spaces/core now needs Postgres and the globalSetup says so clearly when it is down
- [ ] Adding a new system attribute still works end to end through SYSTEM_ATTRIBUTES in core's registry.ts, reseeded insert-if-absent by db:migrate:run
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — In the running app, edit a select cell on a company and a reference cell on a deal: the value validates, attribute_event is written, the reference link materialises — all through code now living in packages/core. Then try to bypass setValues in a scratch file and watch lint refuse.

**Spec** — docs/spec-plugin-sdk.md §2 (core: resolveEntity, setValues); CONTEXT.md — Backend paradigm #9 (one write path for entity.values); CLAUDE.md — After specific change kinds (new system attribute)

#### `mono-8b` · afk · M — packages/core, identity write path — resolve, merge, and the view store

**Blocked by:** `mono-8a`

**What to build**

Move the remaining db-coupled write paths into @spaces/core: lib/entities/resolve.ts and merge.ts, plus lib/views/store.ts — the Effect-first view write side the draft never assigned to any slice, which explains why its acceptance list later claimed src/lib held only web-bound modules. resolve and merge are what the SDK's Identity port will sit on. The contract that must not loosen is merge.ts's per-strategy snapshot convention: ENTITY_REFS in packages/db declares a merge strategy and a context role for every entity-referencing column, entity-refs.test.ts diffs that list against drizzle's FK metadata, and a `custom` strategy needs both its section in merge.ts and its snapshot. There is no unmerge executor — the snapshot is the only contract, and this was the worst bug of a review cycle. merge.test.ts and resolve.test.ts become core tests against the test database; the 'view store' describe block split out of filter.test.ts in mono-7 follows store.ts into core as its own file.

**Acceptance criteria**

- [ ] merge.test.ts, resolve.test.ts and the extracted view-store test run as core tests against the test database and stay green, including every custom-strategy snapshot assertion
- [ ] A custom merge strategy added without its section in merge.ts still fails, and an entity-referencing column added without an ENTITY_REFS entry still fails entity-refs.test.ts naming the column — verify both by adding one temporarily; entity-refs.ts stays in packages/db and needs no connection
- [ ] apps/web's server fns import resolveEntity, merge and the view programs from @spaces/core; no '#/lib/entities' or '#/lib/views/store' specifier remains
- [ ] The merge executor's generic repoints still iterate the ENTITY_REFS registry from @spaces/db — core reads the registry, db does not import core
- [ ] src/lib/entities and src/lib/views are gone from apps/web except for anything genuinely web-bound; the PR lists what is left
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Merge two duplicate people from the dedupe inbox: aliases, links, entity_space rows and values repoint, the merge_event snapshot is written, and the loser's record page redirects — with the executor now living in packages/core. Then save a shared view and a private one from /companies and confirm the author/admin guard still refuses a stranger.

**Spec** — docs/spec-plugin-sdk.md §2 (core: resolveEntity, setValues); CLAUDE.md — After specific change kinds (ENTITY_REFS, merge snapshots); CONTEXT.md — Plugin architecture (Identity port)

### ▸ Vault, storage, seeds and boot — three silences, three PRs

_Delete secret.key on a scratch database and boot: it regenerates at 0600 with the warning, a credential written before the move still decrypts, and a session cookie from before the PR still logs you in. Uploads round-trip under both drivers with the blob beside the ones already on disk. One command still migrates then seeds, in that order, and a deleted taxonomy space stays deleted._

#### `mono-9a` · afk · S — Vault into core — the master key, /data, and nothing regenerates

**Blocked by:** `mono-8a`

**What to build**

Move lib/vault into @spaces/core: crypto.ts (AES-256-GCM envelope encryption, the AAD binding a row to `scope:provider` so a copied row fails authentication instead of decrypting), key.ts (MASTER_KEY → <DATA_DIR>/secret.key resolution and the first-boot generator) and index.ts (storeCredential / resolveSecret over the credential table, user key → workspace key → null). Exactly three apps/web files follow it and no more: auth.ts derives the better-auth session secret from the master key by HKDF, setup-token.ts writes the one-time /setup token beside secret.key, and storage/local.ts signs blob URLs with it — which is why the vault moves before storage rather than with it. One decision is pinned here for good: dataDir() falls back to process.cwd()/data, so the package it lives in decides where an unset DATA_DIR resolves. Pin it to the workspace root rather than inheriting cwd a third time (mono-1 already made the same call for the move), and log the resolved path once at boot so an operator can see it instead of discovering it. Getting this wrong is silent in the worst way the product has: nothing throws, a new key is generated, and every credential written before the move is unrecoverable.

**Acceptance criteria**

- [ ] @spaces/core exports the vault — loadMasterKey, dataDir, encryptSecret, decryptSecret, redact, storeCredential and resolveSecret; apps/web's auth.ts, setup-token.ts and storage/local.ts import them from there and no '#/lib/vault' specifier remains
- [ ] With MASTER_KEY and DATA_DIR both unset, dataDir() resolves to the same directory as before the move: secret.key is NOT regenerated, the existing setup-token file is still found, and the resolved path is logged once at boot
- [ ] A credential row written before the move still decrypts — resolveSecret returns the same plaintext — and a row whose scope or provider is altered by hand still fails authentication rather than decrypting, so the AAD binding survived the move
- [ ] MASTER_KEY set as 32 base64 bytes still wins over the file, and a wrong-length MASTER_KEY still fails with the same 'openssl rand -base64 32' message
- [ ] Sessions survive the PR: a cookie issued before it still validates after it, because the HKDF-derived better-auth secret is byte-identical
- [ ] packages/core still imports nothing from apps/web — grep for '#/' and for any apps/web path under packages/core/src prints nothing
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — On a scratch database: delete /data/secret.key, boot, and watch it regenerate at mode 0600 with the back-this-up warning. Restore the original key, restart, and a credential stored before the move decrypts and drives a provider call. Then run the dev app with DATA_DIR unset and confirm secret.key and setup-token are the same two files in the same directory they were in before the PR — and that a session cookie from before it still logs you in.

**Spec** — docs/spec-plugin-sdk.md §2 (core: ports/lanes, vault, storage, jobs/, ai/); CONTEXT.md — Plugin architecture, packages/core; CONTEXT.md — BYOK (line 1145): master key resolution, /data/secret.key, 'losing it makes every stored key unrecoverable'; CONTEXT.md — Hostability decisions (line 1543): DATA_DIR and /data

#### `mono-9d` · afk · S — Storage into core — one driver interface, both drivers, the same bytes

**Blocked by:** `mono-9a`

**What to build**

Move lib/storage into @spaces/core: the Storage port (put, getDownloadUrl, getUploadUrl, getBytes, delete, exists), the local driver and the s3 driver. This is the blob backend, and it is where the StorageSource read port later sits beside it — a storage source is not a blob backend, and keeping them adjacent in one package is what makes that distinction legible. core gains @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. Two couplings decide the export surface. local.ts reads dataDir and loadMasterKey from the vault, core-internal once mono-9a has landed — that is the whole reason this slice follows it. And apps/web's /api/blob/$key route imports LocalStorage, blobPath and verifyBlobToken directly, so the local driver's HMAC token helpers are part of the package's public surface rather than an accident: export them deliberately and say so in the PR, because the alternative is a route reaching into a package's internals. MAX_UPLOAD_BYTES already reaches local.ts from lib/documents, in core since mono-7. Consumers after the move are the blob route, the extraction job and seeds/dev.ts, all still in apps/web.

**Acceptance criteria**

- [ ] @spaces/core exports storage() and the Storage type, and from its local subpath LocalStorage, blobPath, signBlobToken and verifyBlobToken; no '#/lib/storage' specifier remains in apps/web
- [ ] STORAGE_DRIVER unset or =local still round-trips: upload a document, open it through the signed /api/blob URL, download it under its original filename, and find the blob at <DATA_DIR>/blobs/<aa>/<sha> beside the blobs that were already there — not in a new directory
- [ ] The content-addressed write still refuses a lie: PUT bytes whose sha does not match the key and the request fails with the temp file removed; push past MAX_UPLOAD_BYTES and it is rejected mid-stream
- [ ] An expired or tampered blob token is still refused — the HMAC is keyed off the master key that now lives beside it in core
- [ ] STORAGE_DRIVER=s3 against the dev MinIO still round-trips a blob: upload a document, open it, and the sha-verified bytes come back, with x-amz-checksum-sha256 still baked into the presigned PUT signature
- [ ] STORAGE_DRIVER=nonsense still throws the named 'Unknown STORAGE_DRIVER' error at first use rather than at import
- [ ] packages/core still imports nothing from apps/web
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Upload a PDF with STORAGE_DRIVER=local: it stores, previews and downloads under its own filename, and the file is on disk beside the ones uploaded before the move. Repeat against the dev MinIO with STORAGE_DRIVER=s3 — same document, same sha, bytes come back. Then hand the presigned PUT the wrong bytes and watch the bucket reject them.

**Spec** — docs/spec-plugin-sdk.md §2 (core: ports/lanes, vault, storage, jobs/, ai/); CONTEXT.md — Storage (line 1239): local filesystem default, S3 opt-in via env, re-argued and confirmed 2026-08; CONTEXT.md — Sources are documents ('storage source ≠ blob backend') · docs/spec-storage-sources.md; CONTEXT.md — Plugin architecture, packages/core

#### `mono-9e` · afk · S — Seeds and the boot composition — one command migrates, then seeds

**Blocked by:** `mono-8a`

**What to build**

Move the two seeds that actually run at boot into @spaces/core — lib/seeds/taxonomy.ts (the deliberately tiny starter tree, first boot only, so deleted nodes stay deleted) and lib/attributes/seed.ts (system objects and SYSTEM_ATTRIBUTES, insert-if-absent on every boot, held back from mono-8a so both halves of seeding move at once) — and give the boot composition its final home there. core exports a boot entry that calls packages/db's runMigrations() and then the two seeds in that order, replacing the interim apps/web entry mono-3 created and the CONTEXT.md note recording it as interim. packages/db still declares no internal dependency; runMigrations() stays a library function core composes, never the reverse. Two seed files deliberately do not move, and the PR must say why: seeds/demo.ts reaches resolveEntity, which does not arrive in core until mono-8b, so moving it here would make core import apps/web — and it is invoked from a settings server fn at setup, never at boot; seeds/dev.ts is the developer bench, 3,660 lines, and never runs in the image at all. Ordering is the whole risk: system attributes must exist before the starter taxonomy writes entity rows against them, both must run after migrations, and all of it stays one command on every boot with no `docker exec` step.

**Acceptance criteria**

- [ ] @spaces/core exports seedSystemAttributes, seedStarterTaxonomy and the boot entry; packages/db still declares no internal dependency and its runMigrations() is a library function core composes
- [ ] The container entrypoint and pnpm db:migrate:run both still run migrate-then-seed as one command, in the order migrate → system attributes → starter taxonomy, and the interim shape recorded in mono-3's CONTEXT.md note is replaced with the final one
- [ ] On a scratch database the first boot applies the 24 migrations, seeds the system objects and SYSTEM_ATTRIBUTES, and seeds the starter taxonomy; the second boot applies zero migrations and inserts zero rows of either
- [ ] Deleted seed nodes stay deleted and user edits survive: delete a starter taxonomy space and reboot — it does not come back; rename a system attribute's label and reboot — the rename survives
- [ ] Adding a new entry to SYSTEM_ATTRIBUTES in core's registry.ts still appears after db:migrate:run without stomping user edits — the rule CLAUDE.md states for new system attributes still holds with registry and seed both in core
- [ ] No '#/lib/seeds/taxonomy' or '#/lib/attributes/seed' specifier remains; '#/lib/seeds/demo' and '#/lib/seeds/dev' stay in apps/web deliberately and the PR says why — demo reaches resolveEntity, which lands in core with mono-8b, and dev is the bench that never boots
- [ ] packages/core still imports nothing from apps/web
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Point the app at an empty database and run one command: migrations apply, the system objects and attributes appear, the starter taxonomy appears, and /companies renders its columns. Delete a taxonomy space, rename an attribute label, run the same command again — zero migrations, zero inserts, and both the deletion and the rename survive. Then accept the demo-data offer at setup and watch it still seed, from apps/web.

**Spec** — docs/spec-plugin-sdk.md §2 (core: ports/lanes, vault, storage, jobs/, ai/); CONTEXT.md — Seed taxonomy, deliberately tiny (line 577); CONTEXT.md — Seeded system attributes (line 799); CLAUDE.md — 'After specific change kinds': new system attribute → SYSTEM_ATTRIBUTES, db:migrate:run reseeds insert-if-absent; CONTEXT.md — Hostability decisions (line 1543): migrations auto-run on every boot

### ▸ The assembler moves, the fence goes up, the worker is its own app

_The context readout returns the same items in the same order with canRead intact, now running through packages/core. Dependency rules stop being aspirational: a db import from the plugins fixture fails with the rule's message and the spec section. apps/worker becomes its own package, an apps/web import inside it is refused, and the queue names are renamed once with the consequence for in-flight jobs and the 03:30 schedule row recorded._

#### `mono-9b` · afk · M — Context assembler into core — and canRead leaves the server barrel with it

**Blocked by:** `mono-8b`

**What to build**

Move lib/context — the Effect-first assembleProgram, the pure ranker, ref grammar, renderer, types and their snapshots — into @spaces/core. One dependency blocks the move and the draft missed it: assemble.ts imports canRead from lib/server/shared.ts, a module full of request-scoped better-auth helpers (requireUser, requireAdmin) that must stay in apps/web. canRead is not one of those — it is a pure policy predicate over a row's visibility, and the SDK's Read port ('canRead as integration') is exactly where it is headed. So split shared.ts: canRead moves to core as the read-policy module every future port and assembler call site uses, requireUser/requireAdmin/createSpaceRow/birthHolding stay behind the server-only eslint zone. The assembler's invariants come along untouched: asOf is an input, the ranker is snapshot-tested, canRead runs in SQL, and the output-leak invariant still holds.

**Acceptance criteria**

- [ ] canRead lives in @spaces/core and is the only definition; lib/server/shared.ts keeps requireUser, requireAdmin, createSpaceRow, birthHolding and lastTouchedMap, and the server-only import zone still fires when a route imports from it
- [ ] The assembler's snapshot tests pass unchanged — asOf is still an input, the ranker snapshots are byte-identical, and the output-leak invariant test still holds
- [ ] assemble.test.ts runs as a core test against the test database (its old cleanupTestEntities import is already gone as of mono-5)
- [ ] apps/web's server fns import assembleProgram from @spaces/core through the effectFn() adapter; Effect still never crosses into React and the eslint rule proves it
- [ ] No '#/lib/context' specifier remains in apps/web
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Open a company record and pull up the 'everything about this record' context: the same items in the same order as before the move, with a non-admin user still seeing only what canRead allows — the whole path now running through packages/core.

**Spec** — docs/spec-ai-substrate.md (context assembler); docs/spec-plugin-sdk.md §4 (Read port — canRead as integration); CLAUDE.md — Traps (server-fns is a client-imported barrel; server helpers live in server/shared.ts)

#### `mono-10` · afk · S — Dependency rules as lint — packages/config and the import zones

**Blocked by:** `mono-9a`, `mono-9c`

**What to build**

The spec's dependency rules are stated as a turbo-and-lint contract; nothing enforces them. packages/config already holds tsconfig.base from mono-1 — finish it by moving the eslint base and prettier config in, then add the boundary zones: sdk imports nothing internal; core imports db and sdk only; web imports core and sdk, never plugins/_; db imports nothing internal. Each violation gets a message naming the rule and the spec section, matching the existing style. The four existing architecture seams (server-only helpers, Effect in React, bare Intl.NumberFormat, a direct entity.values update) move file here verbatim, with no change to their content — mono-1 already proved they fire after its glob move, so this slice's claim on them is narrower and different: that the file move into packages/config did not unhook them. The new work in this slice is the boundary zones and nothing else, and the failing-case demo is a boundary zone. Two zones cannot be proved yet and must be honest about it: packages/sdk and plugins/_ do not exist in this area, so they are fenced against a fixture directory, and the worker zone lands with apps/worker in mono-11a rather than being asserted against nothing. Land this before the SDK package is born (sdk-3) so @spaces/sdk grows up inside the fence rather than being retrofitted into it — note that sdk-1 and sdk-2 land against the flat tree ahead of the monorepo and are deliberately not fenced by it.

**Acceptance criteria**

- [ ] Each provable new zone has a failing-case test recorded in the PR: importing @spaces/core from packages/db, and importing @spaces/db from a plugins fixture, each produce an eslint error naming the rule and its spec section
- [ ] The four existing architecture rules survive the move into packages/config with their content unchanged and still fire (server-only helpers from a route, `import { Effect } from 'effect'` in a component, a bare Intl.NumberFormat, a direct entity.values update) — this is the file-move guard; mono-1 owns the glob-move guard
- [ ] Every package extends packages/config for tsconfig, eslint and prettier; no package carries a divergent copy, and lefthook's staged-file prettier and eslint still run from the root after the config moves
- [ ] The sdk and worker zones are written but explicitly marked as unproven until those packages exist, with mono-11a named as where the worker zone gets its failing-case test
- [ ] pnpm lint from the root runs through turbo across all packages and reports zero errors
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Add `import { db } from '@spaces/db'` to a scratch file under packages/core — allowed. Add the same import to the plugins fixture — eslint fails with the rule's message and the spec section. Revert both.

**Spec** — docs/spec-plugin-sdk.md §2 ('Rules the turbo graph and no-restricted-imports enforce'); CONTEXT.md — Plugin architecture (ports, privilege boundary); CLAUDE.md — Backend paradigm (Effect never crosses into React)

#### `mono-11a` · afk · S — apps/worker — its own package, behaviour untouched

**Blocked by:** `mono-10`, `mono-9c`

**What to build**

Lift src/worker out of apps/web into apps/worker: a package depending on @spaces/core and pg-boss and on nothing in web, with its own tsconfig extending packages/config and its own vitest config. Nothing about how jobs run changes here — index.ts still registers the four queues, schedules the 03:30 dedupe sweep, and calls extractDocument directly; the runJob wrapper is the next slice. What changes is ownership: the root `pnpm worker` script, the Dockerfile COPY and entrypoint paths, and the mono-10 worker zone, which finally gets a real package to fence and its failing-case test. Splitting this from the wrapper keeps the move reviewable as a move — a rewritten handler and a relocated package in one diff is where a behaviour change hides in a rename.

**Acceptance criteria**

- [ ] apps/worker's package.json depends on @spaces/core and pg-boss and never on apps/web; the mono-10 worker zone now has a failing-case test — importing from apps/web inside apps/worker errors with the rule named
- [ ] pnpm worker from the repo root starts apps/worker, registers all four queues and logs '[worker] pg-boss started'; a document upload still extracts end to end with the same log lines
- [ ] The 03:30 dedupe schedule is registered exactly once after the move — no duplicate schedule row against the same queue name
- [ ] git diff -M shows the worker move as renames plus import-specifier lines; extract-document.ts's logic is unchanged
- [ ] docker build . still produces an image that boots ROLE=all, ROLE=web and ROLE=worker, with the entrypoint's supervision contract byte-for-byte intact
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — pnpm worker from the root, upload a PDF, watch it extract and become searchable — identical log output to before the move. Then add an apps/web import inside apps/worker and watch lint refuse it.

**Spec** — docs/spec-plugin-sdk.md §2 (apps/worker; 'worker → core, sdk'); docs/spec-plugin-sdk.md §14 step 1; CONTEXT.md — hostability contract 2

---

## 16. A published image anyone can run

_Extensibility · 8 slices_

The pruned, source-free image; the first browser coverage the project has ever had; multi-arch images on GHCR and Docker Hub from a tag; install, upgrade and rollback docs; upgrade CI that boots the last release against this commit's schema; and one-click templates. Placed here rather than last because the rename already landed in project 1, so nothing bakes DealOS in — and because the image is the adoption win CONTEXT calls the biggest one outstanding.

### ▸ A source-free image

_turbo prune --docker layering, the docker/ layout, the ROLE branch, and the worker, migrate and health entries bundled so src/ and tsx leave the image — with su-exec and both entrypoint privilege phases intact, a PDF and a DOCX still becoming searchable, and the before/after image sizes recorded._

#### `mono-13a` · afk · M — Pruned image — turbo prune --docker, docker/ layout, built on every PR

**Blocked by:** `mono-6`, `sdk-2`

**What to build**

Today's image installs the full prod dependency tree and copies src/ and drizzle/ wholesale. Rebuild the layering on turbo prune --scope=web --scope=worker --docker: the pruned lockfile layer installs only what those two need, the build layer produces apps/web/.output, and the runtime layer copies that plus packages/db's migration SQL plus the pruned node_modules. The worker and the migrate entry still run through tsx in this slice — removing src/ needs a bundler and that decision gets its own PR. The Dockerfile moves to docker/ per the spec tree and both compose files follow with an explicit build context. docker/entrypoint.sh keeps its supervision contract verbatim: either process dying kills the container, and the trap distinguishing operator stop from crash. Add an image-build job to CI so the image is proven on every PR rather than first at release — with the heartbeat from mono-12 as the thing that proves the bundled worker actually started.

**Acceptance criteria**

- [ ] docker compose up on a clean machine works first try: migrations apply on boot, seeds run, /api/health returns ok with worker: ok, and a document upload extracts
- [ ] The Dockerfile lives at docker/Dockerfile and both compose files name an explicit build context and dockerfile; .dockerignore is re-pointed for the workspace layout
- [ ] ROLE=web and ROLE=worker each start only their process; ROLE=worker is verifiable through the heartbeat and ROLE=web reports worker absent
- [ ] Killing the worker inside a ROLE=all container stops the container with '[entrypoint] worker exited' and a non-zero exit code; docker stop exits 0 with the signal message — the supervision contract is unchanged
- [ ] The pruned install is smaller than the full prod tree — record before/after `docker images` sizes in the PR
- [ ] CI builds the image on every PR as its own named job and fails when the build breaks
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — docker compose down -v && docker compose up --build on a clean checkout: the app comes up at :3000, /api/health says db ok and worker ok, an uploaded PDF becomes searchable. Then docker kill the worker process inside the container and watch the container stop non-zero.

**Spec** — docs/spec-plugin-sdk.md §2 ('docker/ Dockerfile (turbo prune --scope=web --scope=worker --docker)'); CONTEXT.md line 227 — hostability contracts 2 and 4; docker/entrypoint.sh (supervision contract)

#### `mono-13b` · hitl · M — Bundled worker — src/ and tsx leave the image

**Blocked by:** `mono-13a`, `sdk-1`

**What to build**

Finish the image: bundle the worker entry, the migrate entry and sdk-2's ROLE=worker health command so the runtime layer carries no application source and no tsx, and move tsx from dependencies (where it sits only because the entrypoint needs it) to devDependencies. The entrypoint's `node_modules/.bin/tsx src/...` lines become bundled entry points; everything else about the supervision contract stays byte-identical. The health command matters as much as the worker here — it is invoked by the $ROLE-branched HEALTHCHECK and would otherwise pin tsx into the very image this slice exists to strip. This is hitl because the bundler is an open decision the spec only gestures at: it names tsup, which is not installed, while vite (v8, rolldown-backed) is already the toolchain and `vite build --ssr` would add no dependency. The default written into this slice so it stays implementable is vite build --ssr with three entries; a human confirms or overrides before it bakes into the Dockerfile. Whichever wins, the risk to check is the same: pg-boss, drizzle-orm's node-postgres driver, unpdf and mammoth must survive bundling, the runJob wrapper and its Effect Layers must survive it, and the drizzle migration SQL stays a copied directory, never an inlined asset.

**Acceptance criteria**

- [ ] The runtime image contains no src/ or apps/*/src directory and no tsx binary — verify with `docker run --rm --entrypoint sh <img> -c 'ls /app; ls node_modules/.bin | grep -c tsx'`
- [ ] tsx is in devDependencies and nothing in the image needs it
- [ ] The bundler choice is recorded in CONTEXT.md with the reason, so the next person does not relitigate it
- [ ] A bundled boot still migrates and seeds: on a fresh database the container applies all migrations, seeds system attributes and the starter taxonomy, and /api/health returns ok with worker ok
- [ ] A bundled worker still extracts through runJob: upload a PDF and a DOCX and both become searchable, proving unpdf, mammoth and the Effect Layers survived bundling; pg-boss still registers queues and the nightly schedule
- [ ] The ROLE=worker HEALTHCHECK works in the bundled image — it invokes the bundled health entry rather than tsx, and under docker-compose.split.yml the worker container flips unhealthy once its process is stopped
- [ ] The entrypoint's supervision contract is unchanged — killing either process stops the container non-zero, docker stop exits 0
- [ ] The image is smaller than mono-13a's — record before/after `docker images` sizes in the PR
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — docker compose up --build on a clean checkout: health ok with worker ok, a PDF and a DOCX both upload and become searchable, and `docker run --entrypoint sh <img> -c 'ls /app'` shows .output, a bundled worker, a bundled migrate entry, a bundled health entry and the drizzle SQL — with no src/ anywhere. Then bring up docker-compose.split.yml and stop the worker process: its container goes unhealthy, web stays healthy.

**Spec** — docs/spec-plugin-sdk.md §2 ('the worker gets bundled (tsup) so src/ + tsx leave the image'); CONTEXT.md line 227 — hostability contract 2; docker/entrypoint.sh (supervision contract)

### ▸ A browser proves it works

_A real Chromium proves you cannot reach /today signed out, cannot claim /setup without the log token, cannot claim it twice, and cannot sign up once an admin exists — then composes the image built from the PR, waits for health to say db ok and worker ok, drops a DOCX on a company's Files tab and asserts the extracted text in the preview. The first time any of that has been checked outside a person's hands, and a harness every later UI slice adds one spec to._

#### `ship-6` · afk · M — Playwright harness — the login gate and the first-run setup window

**Blocked by:** `mono-6`

**What to build**

Playwright is in CONTEXT's stack table and has been the standing want since phase 6, and none of it exists: no dependency, no e2e directory, no browser coverage, while the plan ahead adds roughly forty UI surfaces. Land the harness with the two specs that are pure security and need no fixtures — so every later area has somewhere to add one spec instead of each inventing a harness. The harness boots what CI boots: a disposable Postgres database on the dev compose server, `pnpm build` plus `node .output/server/index.mjs`, DATA_DIR pointed at a temp directory and MASTER_KEY set so runs are reproducible. e2e lives in its own project with its own config and tsconfig, excluded from vitest so `pnpm test` stays the unit suite and `pnpm e2e` is separate. The specs cover the auth surface the code already implements and nothing tests: the login gate, and the first-run window auth trap 2 names — /setup open to anyone who reaches the port between compose up and admin creation, guarded by a one-time token printed to the logs, consumed inside the databaseHook (not the route) because the public signup endpoint would bypass a route check, and cleared before the after-hook so two concurrent first-run signups cannot both win.

**Acceptance criteria**

- [ ] @playwright/test added, `e2e/` with its own config and tsconfig, excluded from the vitest project; `pnpm test` runs the unit suite unchanged and `pnpm e2e` runs the browser suite
- [ ] The harness creates and drops its own database and DATA_DIR per run and never touches the dev database or the vitest test database — verified by row counts before and after
- [ ] Login gate spec: an unauthenticated GET of /today redirects to login; a wrong password is refused; the seeded fixture user signs in and lands on /today
- [ ] First-run spec: against an empty database /setup refuses signup with no token, accepts the token printed in the logs once, and refuses a second use of the same token
- [ ] Closed-signup spec: with an admin present, a direct POST to the signup endpoint with neither setup token nor invite token is refused
- [ ] A CI job named e2e runs chromium headless and uploads the trace on failure; it is additive to mono-6's five gates and rewrites none of them
- [ ] The suite is under 90 seconds cold, recorded in the PR, and is not flaky across three consecutive runs
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — `pnpm e2e` builds the app, boots it against a throwaway database, and a real Chromium proves you cannot reach /today signed out, cannot claim /setup without the log token, cannot claim it twice, and cannot sign up once an admin exists.

**Spec** — CONTEXT.md — Stack table ('Tests: Vitest + Playwright') and post-v1 backlog ('Playwright preview smoke test'); CONTEXT.md — Two self-host auth traps #2 (the first-run window); docs/spec-plugin-sdk.md §13.8 (Browser E2E); src/lib/auth.ts (first-run token consumed in the databaseHook, single-use invites)

#### `ship-7` · afk · M — Upload to preview in a real browser — the smoke that gates a release

**Blocked by:** `mono-13a`, `sdk-2`, `ship-2`, `ship-6`

**What to build**

CONTEXT has named this test for two phases: 'no automated test — a Playwright upload→preview→assert test is the natural first CI case'. Write it, and run it against the image rather than a dev server, so one job is both the browser smoke and the image smoke and becomes the gate the release workflow keys on. The specs exploit a property the preview surface already has: Office preview renders the worker's already-extracted text, while PDF and images render client-side without the worker. So a DOCX upload that previews its text proves upload, blob write, pg-boss enqueue, worker extraction and preview in one pass, and a PDF upload proves the security shape — pdf.js draws to a canvas and the browser never navigates to the blob URL, while the download route still answers `attachment` + `application/octet-stream` (echoing an upload's own content-type would be stored XSS against the app's own origin). The job composes the PR-built image plus Postgres, waits for /api/health to report db ok and worker ok, and only then runs the specs, so a red run says which half broke instead of failing inside a click.

**Acceptance criteria**

- [ ] DOCX spec: sign in, open a company record's Files tab, upload the fixture, and the preview modal shows the worker-extracted text — upload, blob, enqueue, extraction and preview proven in one pass
- [ ] PDF spec: the preview renders to a canvas, the page never navigates to the blob URL, and the download link returns Content-Disposition attachment with application/octet-stream — the stored-XSS rule enforced in a browser for the first time
- [ ] The job runs against the image mono-13a builds on every PR, composed with Postgres — not against `pnpm dev` — so it is also the image smoke
- [ ] The job polls /api/health until db ok and worker ok before the first spec, and fails with that payload when the worker never reports, so a broken worker is never mistaken for a broken upload
- [ ] Fixtures live in e2e/fixtures, are committed, and are under 200 KB each; the run fetches nothing from the network
- [ ] The whole job is under three minutes cold on a standard runner, recorded in the PR
- [ ] The job's name is stable and is the one ship-8's release workflow requires before it pushes
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — CI composes the image built from the PR, waits for health to say db ok / worker ok, then a real browser signs in, drops a DOCX on a company's Files tab, and asserts the extracted text appears in the preview — the first time any of that has been checked outside a person's hands.

**Spec** — CONTEXT.md — phase 6 notes ('Office preview depends on the worker running, PDF and images do not; no automated test — a Playwright upload→preview→assert test is the natural first CI case'); CONTEXT.md — 'Downloads are always attachment + application/octet-stream'; docs/spec-plugin-sdk.md §13.8; mono-13a (image built on every PR), mono-12 (worker heartbeat in /api/health)

### ▸ docker compose up from a published tag

_A stranger with no checkout drops in a compose file pinned to a multi-arch tag and is at /setup in a minute on arm64 or amd64, with no 583 MB build on their box. They can back up, they can restore from total loss, and the README tells them what to back up and what losing secret.key costs — in bold._

#### `ship-8` · hitl · M — Published images — multi-arch GHCR and Docker Hub on a core@ tag

**Blocked by:** `mono-13a`, `ship-1`, `ship-7`

**What to build**

Standing debt calls this the biggest adoption win: compose still says `build: .`, so installing means building 583 MB of node_modules on the target box for a 9.3 MB .output — tight on 2 GB of RAM, failing on 1 GB. mono-13a builds the image on every PR; nothing publishes one. Add a release workflow triggered on `core@*` tags that builds docker/Dockerfile once with buildx for linux/amd64 and linux/arm64 (arm64 is not optional — it is the audience's hardware) and pushes the same digest to GHCR and Docker Hub, then flip docker-compose.yml from `build: .` to a pinned image with the build stanza kept as a commented developer override. Three things are open and a human settles them here rather than after people have pulled: the GHCR and Docker Hub namespaces (and creating them, plus the Docker Hub token as a repo secret — GHCR uses the built-in token); whether `latest` moves at all, given that our own docs tell people to pin tags; and whether images are signed or carry provenance attestations, which cannot be retrofitted gracefully once an image is in circulation and which should be answered alongside sdk-21a's plugin signing scheme rather than separately.

**Acceptance criteria**

- [ ] A release workflow triggers on `core@*` tags only, builds with buildx for linux/amd64 and linux/arm64, and pushes one manifest to ghcr.io/<ns>/spaces and docker.io/<ns>/spaces with the same digest
- [ ] The workflow refuses to push unless the commit's gates and ship-7's image smoke are green, and the smoke re-runs against the built image's amd64 variant immediately before the push
- [ ] arm64 is genuinely arm64: `docker run --platform linux/arm64 <tag> id` prints uid=1000 and the container boots and migrates (under QEMU in CI is acceptable; record the run)
- [ ] Tag policy is decided and recorded in CONTEXT.md — exact version and major.minor always; `latest` only if the human chooses it, with the reason written down either way
- [ ] Signing/attestation is decided and recorded in the same place, cross-referenced to sdk-21a's plugin signing scheme so the project has one answer, not two
- [ ] The GHCR package and Docker Hub namespace exist, are public, and the Docker Hub token is a repository secret; the first real tag is pushed as part of this slice, not left as a future exercise
- [ ] docker-compose.yml pins that published tag as `image:` with the build stanza commented as the developer override, and the placeholder `# image: ghcr.io/OWNER/dealos:TAG` is gone
- [ ] A clean machine with only docker-compose.yml and no repository checkout can `docker compose up` and reach /setup — recorded as a real run, with the pull size and boot time in the PR
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — On a machine that has never seen the repository — an arm64 Mac and an amd64 VM — drop in the compose file, `docker compose up`, and the app is at :3000 in under a minute with nothing built locally.

**Spec** — CONTEXT.md — Hosting ('Prebuilt multi-arch image (arm64 matters) on GHCR + Docker Hub. Non-root UID 1000. Docs tell people to pin tags, not latest'); CONTEXT.md — Standing debt, 'No published images yet' ('the biggest adoption win'); docs/spec-plugin-sdk.md §2 ('CI builds the image on core@x tags'); docker-compose.yml line 5 (the commented image placeholder)

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
- [ ] docs/CODEBASE.md hosting lines are re-pointed at these documents instead of repeating them
- [ ] Explicitly out of scope and named as such: the comparison page, the PaaS templates, and the marketing site
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Hand someone the README who has never seen the repository: they get a running, HTTPS-served instance from a published tag, know what to back up, and know what happens if they lose secret.key — without asking a question.

**Spec** — CONTEXT.md — BYOK ('Losing it makes every stored key unrecoverable — docs must say this in bold'); CONTEXT.md — Hostability decisions #5 and #6; Standing debt ('Rollback is unsafe and undocumented', './data ownership landmine'); README.md (still the TanStack Start template)

### ▸ The path back is tested

_Push a migration that drops a column something still reads and the upgrade job goes red naming that migration, with both images' logs attached, instead of the breakage arriving on an operator's box. And the PaaS templates put the whole thing one click away on the platforms self-hosters actually use._

#### `ship-11` · afk · M — Upgrade CI — last release's image, this commit's schema

**Blocked by:** `ship-5`, `ship-8`

**What to build**

CONTEXT: 'Never ship a breaking migration; CI must test the upgrade path from every prior release', banked as 'upgrade CI only once there is a release to upgrade from' — which ship-8 now provides. The job boots the last published core tag against a fresh Postgres, seeds it, takes a backup with scripts/backup.sh, then boots the commit's image against the same volume and asserts that migrations applied, health reports db ok and worker ok, and the seeded document still downloads. It also asserts the reverse, which is the rollback story proven rather than documented: the previous image booted against the upgraded database is refused by ship-4's guard, and restore.sh brings it back. 'Every prior release' is unbounded and will become unaffordable, so the supported window is pinned here — N-1 while there is one prior tag, widening to the current major's tags as they accumulate — and CONTEXT is corrected to say what is actually tested. Until a second tag exists the job self-skips with a clear message instead of failing red.

**Acceptance criteria**

- [ ] A workflow boots the last published `core@` tag against a fresh Postgres, seeds it, backs it up, then boots the commit's image against the same volume
- [ ] It asserts migrations applied, /api/health reports db ok and worker ok, and a document seeded under the old image still downloads with matching bytes
- [ ] It asserts the reverse: the previous image against the upgraded database is refused by ship-4's guard, and restore.sh recovers the pre-upgrade state
- [ ] The tag matrix is generated from the published tag list and the supported window is pinned in this PR; CONTEXT.md's 'every prior release' is corrected to what is actually run
- [ ] The job runs on tags and nightly, never on every PR, and self-skips with a clear message while only one published tag exists
- [ ] A failure names the migration that broke and attaches both containers' logs as artifacts
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Push a migration that drops a column something still reads, tag it, and the upgrade job goes red naming that migration — with the old image's and new image's logs attached — instead of the breakage arriving on an operator's box.

**Spec** — CONTEXT.md — Hosting ('Never ship a breaking migration; CI must test the upgrade path from every prior release'); CONTEXT.md — phase 16 banked note ('upgrade CI only once there is a release to upgrade from'); CONTEXT.md — Hostability decisions #5

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

---

## 17. The plugin SDK — claims without a database

_Extensibility · 13 slices_

@spaces/sdk, the semver-frozen claim and kind contracts, the testing kit, the loader, the live ports, and claims landing as graph writes with provenance a plugin cannot forge. Born inside the dependency fence rather than retrofitted into it, and tested with Postgres stopped — the cheapest second agent you can have running.

### ▸ A plugin can be written and tested without the app

_An author writes a manifest in TS (emitted as JSON Schema so web renders it without the bundle, with the supported type subset refused at validation time rather than rendered badly), a job against typed ports, normalizes identity keys the same way the choke point does, and proves 'this provider JSON produces these claims' with no Postgres, no network and no running product. Pack and verify settles the signing scheme and the unsigned escape._

#### `sdk-3` · afk · M — @spaces/sdk skeleton — manifest as TS, JSON Schema on disk, definePlugin

**Blocked by:** `mono-1`

**What to build**

The first package a plugin author touches, and it must settle a contradiction the spec leaves: §3 types manifest.settings as a ZodSchema, but web renders settings from manifest.json without loading the bundle — and a zod schema does not survive JSON. Resolution pinned here: the manifest is authored once as a TS const with a zod settings schema, and the plugin build emits manifest.json with settings serialised through zod 4's z.toJSONSchema. The on-disk schema covers manifestVersion, the immutable id slug, version, the sdk range, kind, name/description/icon, requires.credential and requires.connection, settings (JSON Schema), jobs (schedule, concurrency, timeout, retry, on, interactive), ingress, actions, http.rateLimit, sensitivity. Plus SDK_VERSION, satisfiesSdk(range) returning a named reason rather than a boolean, and definePlugin(). The dependency rule is enforced by lint, not convention. Consumer: plugins/_fixtures/echo, a real manifest plus one job, parsed and range-checked by tests.

**Acceptance criteria**

- [ ] packages/sdk builds to ESM plus d.ts; its package.json dependencies list only effect, zod and (if the range check is not hand-rolled) semver — a source file importing @spaces/core or @spaces/db fails pnpm lint via no-restricted-imports
- [ ] The manifest is authored as a TS const and the build emits manifest.json; a test asserts the emitted JSON parses under manifestSchema and that its settings block round-trips z.toJSONSchema of the authored zod schema
- [ ] manifestSchema.parse on plugins/_fixtures/echo/manifest.json succeeds; a manifest whose id contains an uppercase letter or a dot is rejected naming the id field
- [ ] satisfiesSdk('^2.0') against SDK_VERSION 1.x returns { ok: false, reason: 'requires sdk ^2.0, host provides 1.0.0' } — the exact string the loader later writes as the degraded reason; caret, tilde and exact ranges each have a test
- [ ] definePlugin returns a Plugin whose jobs keys are constrained to the manifest const's declared jobs: a bundle declaring job 'enrich' but exporting 'enrichh' fails typecheck
- [ ] SDK_VERSION is exported from one place and asserted equal to packages/sdk's package.json version by a test
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — pnpm --filter @spaces/sdk build emits d.ts and the echo fixture's manifest.json; pnpm test runs that manifest through the schema and prints the named reason for the deliberately-too-new sdk range fixture.

**Spec** — docs/spec-plugin-sdk.md §3; docs/spec-plugin-sdk.md §6; docs/spec-plugin-sdk.md §2 (dependency rules)

#### `sdk-4a` · hitl · M — Claims and kind interfaces — the semver-frozen contract

**Blocked by:** `sdk-3`

**What to build**

A plugin returns claims, never writes, and the claim union is the SDK's public surface: once published it moves only on a major. The spec sketches Claim = Identity | Fact | Content | Judgment but fixes no payloads, so a human ratifies the shapes. Two things the spec does not answer and this slice must: how a Fact claim addresses an entity that an Identity claim in the same batch created (a local ref grammar, e.g. a claim-scoped handle resolved by the router), and whether estimateCost returns credits or a typed budget. Define the union and the seven kind interfaces (enricher, researcher, syncer, ingress, importer, poller, and the storage-source kind literal whose body the storage area owns), and export the kind-to-allowed-ports table as data the loader and the tests both read. CONTEXT describes an Enricher interface as if it exists; grep finds only comments — this writes it fresh. A claim carries no source, actor or integration id: provenance is stamped by the port and the type must make forging it impossible.

**Acceptance criteria**

- [ ] Claim is a discriminated union on type: 'identity' | 'fact' | 'content' | 'judgment'; an expectTypeOf test asserts no member exposes a source, actor, actorType, integrationId or sourceRef key
- [ ] A fact, content or judgment claim addresses its subject either by entityId or by a handle minted by an identity claim in the same batch; a claim referencing an unminted handle is a typed error, snapshot-tested on the fixture
- [ ] Each kind interface is declared with methods returning Effect of claim arrays (enricher: enrichCompany, enrichPerson, estimateCost; researcher: research; syncer: pull with cursor; ingress: verify plus handle; importer: parse; poller: poll); storage-source is declared as a kind literal with a TODO body owned by the storage area
- [ ] KIND_PORTS is exported data and a test asserts it matches the spec §4 table exactly — enricher has Facts and not Ai, researcher has Ai and not Facts, poller has neither Facts nor Identity
- [ ] A content claim distinguishes document, interaction and signal by a nested tag, so a plugin cannot emit an interaction carrying document fields
- [ ] plugins/_fixtures/echo grows an enricher variant mapping a recorded provider JSON fixture to claims, snapshot-tested
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Read the exported types in one file with the KIND_PORTS table beside them, then run the fixture's snapshot test to see the claims a real provider payload produces, including a fact claim attached to a handle the identity claim minted. Review against docs/spec-plugin-sdk.md §4 and §5.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §5; CONTEXT.md — Plugin architecture (Ports = the SDK contract)

#### `sdk-4b` · afk · S — Identity-key normalizers move into the SDK — one list, no drift

**Blocked by:** `sdk-4a`

**What to build**

An identity claim carries domain, email and linkedin keys, and the plugin must normalize them the same way the choke point does — but src/lib/entities/normalize.ts is core, and plugins import only the SDK. Today Apollo would have to reimplement normalizeDomain and isRoleEmail, and the role-email rule (CONTEXT: role emails never identify a person) would drift between the plugin and resolveEntity. Move the pure normalizers (normalizeDomain, normalizeEmail, normalizeLinkedin, normalizeName, isRoleEmail) into @spaces/sdk, which has no internal deps, and have src/lib/entities/normalize.ts re-export them so resolve.ts and every existing caller are unchanged. normalize.test.ts moves with the code and must pass unmodified — that is the proof the behaviour did not shift. Small, mechanical, and it removes the single most likely source of silent identity drift once third-party plugins exist.

**Acceptance criteria**

- [ ] The six normalizers live in @spaces/sdk with no internal imports; src/lib/entities/normalize.ts re-exports them and no call site changes
- [ ] normalize.test.ts moves to packages/sdk unmodified and passes; resolve.test.ts passes untouched
- [ ] A plugin fixture importing only @spaces/sdk can normalize a domain and reject a role email, asserted by a test in the fixture
- [ ] No second copy of the role-email list exists anywhere in the repo, asserted by a grep-style test or a single exported constant both sides read
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — pnpm vitest run packages/sdk src/lib/entities — the moved normalize tests and the untouched resolve tests are both green, and the echo fixture normalizes a domain without importing core.

**Spec** — docs/spec-plugin-sdk.md §2 (dependency rules); CONTEXT.md — Entity resolution & merge (role emails)

#### `sdk-5` · afk · M — Port tags and the testing kit — claims provable without a database

**Blocked by:** `sdk-4a`

**What to build**

Declare the port interfaces as Effect service tags — Identity, Facts, Content, Judgment, Receipts, Ai, Read, Secrets, Config, PluginDb, Http, Log — with the signatures the spec's port table fixes, and no implementations. Clock is deliberately not a port: Effect ships one, and declaring ours would be a second source of time. These are the first Effect services in the repo (today Effect appears only as Effect.fn programs behind the effectFn adapter, no Layer or tag anywhere), so this sets the house pattern: effect is 4.0.0-rc.112, so Context.Service classes with Layer.effect constructors — invoke the vendored effect-ts skill first. Secrets declares accessToken() now even though the storage area implements it, so adding it later is not an SDK major. Ship @spaces/sdk/testing alongside: in-memory Layers that record every call instead of writing. Ai and PluginDb get interfaces but no test Layer — their fakes land with the areas that implement them.

**Acceptance criteria**

- [ ] Twelve tags exist with the spec's signatures; Facts.fill takes an entityId plus a values record and returns the conflicts it refused rather than void; Secrets declares get() and accessToken(), the latter typed to fail NotConnected until the storage area implements it
- [ ] @spaces/sdk/testing exports IdentityTest, FactsTest, ContentTest, JudgmentTest, ReceiptsTest, ReadTest, SecretsTest, ConfigTest, HttpTest and LogTest, each a Layer plus a recorder handle listing the calls it received
- [ ] The fixture enricher's test runs end to end on the test Layers with no DATABASE_URL set and no network, asserted by a CI step running that file with the env var unset
- [ ] A job program that yields Facts while typed as a poller job fails typecheck, demonstrating the R type as documentation
- [ ] HttpTest lets a test script responses and assert exact request headers, so rate-limit behaviour is testable before HttpLive exists
- [ ] No Clock tag is declared; a test or lint rule pins that plugin code reads time through Effect's Clock
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — DATABASE_URL= pnpm vitest run packages/sdk — the fixture enricher's claim tests pass with no database and no network, and the recorder output shows exactly which ports the fixture touched.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §6; docs/spec-plugin-sdk.md §13.1

#### `sdk-21a` · hitl · M — Pack and verify — the signing scheme, registry.json, and a tamper check

**Blocked by:** `sdk-3`

**What to build**

Before anything can be installed, something must be publishable and verifiable — and the scheme is undecided, which is why a human settles it. CONTEXT and the spec both say 'first-party signed tarballs only' with an unsigned escape for development but name no scheme: minisign or raw ed25519 with the public key baked into the image is simplest and offline-friendly, sigstore/cosign is more standard and wants network. The second undecided thing is how the unsigned escape reaches a container without touching the frozen required-env set; the leading candidate is a marker file under the data dir rather than an env var. This slice decides both, ships the packer (tarball plus sha256 plus signature), fixes registry.json's committed format, and ships a verify function with no install path — verification is testable, and useful, on its own.

**Acceptance criteria**

- [ ] The signing scheme and the location of the public key are decided and recorded in CONTEXT.md under Plugin architecture; so is how the unsigned development escape is expressed without adding required env
- [ ] A packer command produces <id>-<version>.tgz plus its sha256 and signature from a plugin directory, and a test round-trips the echo fixture through it
- [ ] verify(tarball) accepts a correctly signed archive and rejects, with distinct named reasons, a flipped byte (sha mismatch), a wrong signature, an unsigned archive with the escape off, a manifest id that disagrees with the registry entry, and a path-traversal entry in the archive
- [ ] registry.json is committed with the documented fields (id, version, sdk, kind, name, description, requires, tarball, sha256, sig, minCore) and is copied into the image by the Dockerfile
- [ ] The unsigned escape defaults to off and the required-env set stays {DATABASE_URL, APP_URL}, asserted by a test that boots with only those two set
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Pack the echo fixture, verify it (pass), flip a byte and verify again (sha mismatch), strip the signature and verify (refused), then turn on the documented escape and watch the unsigned one pass with a warning.

**Spec** — docs/spec-plugin-sdk.md §9 (registry, signing); CONTEXT.md — Plugin architecture (trust, signed tarballs); CONTEXT.md — Hostability decisions (contract 6)

### ▸ Ambient ports and the loader's verdict

_Point the data dir at four fixtures and start the worker: one verdict line per plugin, /api/health listing the degraded ones with reasons beside the worker line it already carries, manifests cached on the integration rows, and the extraction queue serving throughout. Config, Secrets, Log, Http and ReadLive are live and bound to one integration row — the log shows the redacted key and shows a private note was never read._

#### `sdk-11` · afk · M — Loader part one — discover, locate, validate, cache the manifest, mark degraded

**Blocked by:** `clean-2a`, `sdk-3`

**What to build**

Boot reconciliation: the half of the loader that decides whether a plugin may run at all. On worker boot, read enabled integration rows, locate <dataDir()>/plugins/<id>/current/{manifest.json,bundle.mjs} reusing the existing dataDir() from src/lib/vault/key.ts rather than a second resolver, zod-parse the manifest, check the sdk range against SDK_VERSION, verify the bundle sha against lock.json, import the module, and set integration.status. Two things the spec leaves loose and this pins: lock.json does not exist until the installer lands, so a plugin with no lock entry loads and is recorded unpinned while a mismatch against an existing entry degrades; and the validated manifest is written to integration.manifest jsonb, so web renders actions, settings and ingress from a row rather than reading /data — which is what makes 'web never executes plugin code' airtight in split-role deployments. No queues registered yet. Every failure path is degraded plus a reason and boot continues.

**Acceptance criteria**

- [ ] Migration adds integration.manifest jsonb via pnpm db:generate --name integration_manifest (or the column is requested from clean-integration-table and this slice only writes it), SQL hand-inspected; the loader writes the parsed manifest on every successful validation
- [ ] Boot with four fixtures on disk and four rows ends with echo enabled, old-sdk degraded('requires sdk ^2.0, host provides 1.0.0'), a tampered bundle degraded('bundle sha does not match lock.json'), needs-key degraded('missing credential'), and the process still running
- [ ] A plugin with no entry in lock.json loads and is recorded unpinned with that noted in the log; a plugin whose entry disagrees with the bundle sha degrades
- [ ] A row whose files are missing degrades with a reason naming the expected path; files present with no row are ignored — the row is intent, per the three-sources-of-truth rule
- [ ] A bundle whose top-level import throws degrades that plugin with the thrown message truncated into last_error while the other plugins still load
- [ ] GET /api/health lists degraded plugins as [{ id, version, reason }] read from integration rows (so it works from the web process in split roles) and the overall status stays ok — a degraded plugin is not an unhealthy box
- [ ] Reconciliation is idempotent: booting twice against unchanged files and rows produces identical statuses and no extra writes
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Point the data dir at a temp dir holding the four fixtures, seed four integration rows, start the worker: the log prints one verdict line per plugin, /api/health lists the degraded ones with reasons, the integration rows carry their parsed manifests, and the worker keeps serving the extraction queue throughout.

**Spec** — docs/spec-plugin-sdk.md §7 steps 1-4 and 8; docs/spec-plugin-sdk.md §10 (boot reconciliation)

#### `sdk-6a` · afk · M — Ambient ports live — Config, Secrets, Log and Http bound to one integration row

**Blocked by:** `clean-2a`, `sdk-5`

**What to build**

The ports that carry no lane doctrine but do carry the binding. ConfigLive validates integration.config against the manifest's emitted JSON Schema and fails typed when they disagree, which the loader turns into degraded rather than a crash. SecretsLive decrypts through the existing vault — but resolveSecret(provider, userId?) resolves by provider, not by id, so this slice adds resolveSecretById(credentialId) which reads the row's own scope and provider to rebuild the AAD, and uses it so the layer is scoped to the bound row's credential and nothing else. Worker process only; never in a log line. LogLive prefixes every line with [plugin:<id>]. HttpLive is the only way a plugin reaches the network: a rate-limited fetch that self-throttles from response headers (Retry-After, X-RateLimit-*) rather than a hardcoded rpm, per the Apollo notes. The throttle is per worker process — documented, since a future multi-worker deployment would exceed it.

**Acceptance criteria**

- [ ] ConfigLive returns the manifest-typed config for the bound row; a row whose config fails the manifest's settings schema yields a typed ConfigInvalid carrying the field path, not a throw
- [ ] resolveSecretById(credentialId) exists in src/lib/vault and decrypts with the AAD rebuilt from that row's scope and provider; SecretsLive.get() returns it and null for a row with no credential_id; a test asserts a second integration's credential is unreachable from the first row's layer
- [ ] A 429 with Retry-After: 2 makes HttpLive wait about 2s and retry once; a 429 with X-RateLimit-Remaining: 0 plus a reset header waits until reset — both asserted against a fake server with a TestClock
- [ ] Concurrent HttpLive calls beyond manifest.http.rateLimit.rpm queue rather than burst, asserted by request timestamps at the fake server; the per-process scope of the throttle is stated in the module doc comment
- [ ] A secret passed through Log or embedded in an Http error is redacted to the vault's redact() form in the emitted line, asserted on captured log output
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — A test boots the four live layers against a seeded integration row and a fake HTTP server: it prints the typed config, fetches through the throttle under a 429, and shows the log prefix and the redacted key.

**Spec** — docs/spec-plugin-sdk.md §4; CONTEXT.md — BYOK (vault, workspace scope); CONTEXT.md — Enrichment (read rate-limit headers, do not hardcode)

#### `sdk-6b` · afk · S — ReadLive — the plugin's view of the graph, as actor integration

**Blocked by:** `clean-2a`, `sdk-5`

**What to build**

The port the draft plan forgot and every enricher needs: Apollo's enrich job is handed an entityId and must read that entity's domain before it can call anything. Read is granted to enricher, researcher and importer in the kind table, so it cannot wait. ReadLive implements entity(id) and search(q) through the existing canRead choke point with the actor fixed to { type: 'integration', id: row.id } — which today means private note bodies are never visible, and the shape is right when the policy gets richer. Merged-away entities resolve through the merge redirect the way every other read path does, so a plugin handed a stale id reads the survivor rather than nothing. context(id, …) is explicitly out: the context assembler is the AI substrate's and lands with it. Consumer is the echo enricher fixture, which reads a seeded company's domain and emits a claim from it.

**Acceptance criteria**

- [ ] Read.entity(id) returns the entity with its identity aliases and values; a private note body is absent from the result, asserted by a test that seeds one
- [ ] Read.entity on a merged-away id follows mergedIntoId and returns the survivor, matching every other read path
- [ ] Read.search(q) runs the existing search path with canRead applied as the integration actor and never returns a row a plugin should not see
- [ ] The layer has no way to name a different actor: a test asserts the actor is taken from the bound row and is not a parameter of any exported function
- [ ] ReadTest and ReadLive satisfy the same interface, asserted by running the fixture enricher's claim test against both
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Seed a company with a domain and a private note, run the echo enricher against the dev database through ReadLive: the claim it emits carries the domain and the log shows the note body was never read.

**Spec** — docs/spec-plugin-sdk.md §4 (Read); CONTEXT.md — Plugin architecture (Ports = the SDK contract)

### ▸ Claims become graph writes

_A fixture plugin's claims land as entities, aliases, receipts, interactions, signals, documents and values — each stamped to an integration row by the port, fill-blanks decided inside the row lock, collisions becoming duplicate candidates and conflicts becoming suggestions in the queue that already exists. Content.fileDocument is a thin port over the intake and birth modules with no pipeline of its own._

#### `sdk-7a` · afk · M — Identity and Receipts live — provenance the plugin cannot forge

**Blocked by:** `clean-2a`, `clean-3`, `sdk-5`

**What to build**

The first two write lanes, and the pair Apollo needs. IdentityLive wraps resolveEntity and addIdentityAlias — today resolve.ts takes a string-union source including literal 'apollo' and 'gmail'; after the enum collapse it takes source_class plus source_ref, and the port supplies the bound row id, never the plugin. A colliding identity key still becomes a duplicate_candidate because the choke point already does that and the port must not bypass it. ReceiptsLive writes enrichment_record, whose provider column is free text with no integration reference today — so this slice migrates that table: add integration_id referencing integration, backfill provider values, and keep provider for pre-collapse rows. Content's lanes and fileDocument are deliberately elsewhere: Apollo needs neither, and a lane with no consumer is not a slice.

**Acceptance criteria**

- [ ] Every row written through these ports carries source_class 'integration' and source_ref equal to the bound integration id; a test asserts the port ignores any source fields a claim tries to smuggle in
- [ ] Migration adds enrichment_record.integration_id referencing integration(id) via pnpm db:generate --name enrichment_record_integration, SQL hand-inspected and the backfill of existing provider strings checked by hand; integration is not an entity so no new ENTITY_REFS entry is needed and entity-refs.test.ts stays green
- [ ] Identity.resolve on a domain that already identifies another entity writes a duplicate_candidate row and returns the existing entity id — it neither throws nor creates a second entity
- [ ] Identity.resolve twice with the same domain from the same integration attaches both times: one entity, one alias, no duplicate_candidate
- [ ] Receipts.store writes one enrichment_record row per call with the raw payload intact and credits_used when supplied, referencing the integration row
- [ ] An activity row written by these ports carries a null actor_id and names the integration in meta; the record timeline renders it without assuming a user
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Run the echo enricher against the dev database with a seeded integration row: a company appears whose source_ref is that row, its enrichment_record holds the raw JSON and points at the integration, and re-running produces no duplicate. Point a second fixture at the same domain with a different name and a duplicate_candidate appears in /dedupe.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §8; CONTEXT.md — Entity resolution & merge

#### `sdk-7b` · afk · M — Content's interaction and signal lanes — evidence rows with a typed source

**Blocked by:** `clean-2a`, `clean-3`, `sdk-5`

**What to build**

The lanes a syncer, researcher or poller writes through, split from Identity and Receipts because Apollo needs none of them and they would otherwise sit unconsumed. Content.logInteraction writes interaction plus interaction_entity; note that the manual path in src/lib/server/interactions.ts sets no messageId and does no dedupe, so the port cannot just copy it — the port sets messageId and relies on the existing unique index, which is what makes a webhook delivered twice one interaction. Content.emitSignal writes a signal row linked to the entity; signal.source is already open text, so no enum edit is needed. Both stamp source_class integration plus source_ref from the bound row. The consumers are the researcher and poller fixtures, which are also what sdk-12a's privilege test needs in order to prove that a poller granted Content but not Facts fails when it reaches for Facts.

**Acceptance criteria**

- [ ] Content.logInteraction with a messageId twice produces one interaction row and both entity edges, asserted against a real database; the manual path's behaviour is unchanged and its existing callers still compile
- [ ] Content.logInteraction without a messageId creates a new interaction each time, matching the manual path, so the port does not invent dedupe where the caller has no key
- [ ] Content.emitSignal writes a signal row with source naming the integration and the payload intact, linked to the entity
- [ ] Both lanes stamp source_class 'integration' and source_ref from the bound row and refuse any source the claim carries
- [ ] Researcher and poller fixtures under plugins/_fixtures emit interaction and signal claims and are snapshot-tested through the test Layers with no database
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Run the poller fixture against the dev database: a signal row appears on the record's timeline attributed to the integration. Replay the same payload with the same messageId through the researcher fixture and the interaction count stays at one.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §5; CONTEXT.md — Interactions and enrichment

#### `sdk-8` · afk · S — Content.fileDocument — a plugin's bytes through intake and birth

**Blocked by:** `clean-3`, `clean-4`, `sdk-7a`, `storage-6a2`

**What to build**

A plugin cannot call a server fn, and copying the document transaction into the port is how the two silently diverge. By the time this lands both halves exist: document-birth owns the row and its edges, document-intake owns stream → sha → blob. So Content.fileDocument is a thin port implementation with no pipeline of its own — validate the claim, open the plugin's stream, call intake with source_class 'integration', source_ref the integration row, actor {integrationId}. The earlier draft of this slice carried a hedge saying it would perform the extraction of the shared transaction if the documents track had not got there first; that hedge is deleted, because it is exactly the mechanism by which two areas build one subsystem twice. If storage-6a2 has not landed, this slice waits.

**Acceptance criteria**

- [ ] Content.fileDocument({stream | bytes, filename, mime, kind, fileAgainst}) is implemented entirely on document-intake; the SDK's source tree contains no insert into document, no createHash over file bytes and no storage() call — the greps storage-6a1 and storage-6a2 ship are re-rooted at the workspace so they cover packages/* as well as apps/web
- [ ] A document filed by a plugin has uploaded_by null, source_class 'integration' and source_ref set; the record page shows it with the integration named rather than a user, and the activity row carries a null actor_id
- [ ] The same sha filed by the plugin and then uploaded by hand against the same record produces one document row and one blob, through birth's per-target dedupe
- [ ] MAX_UPLOAD_BYTES is enforced by intake's streaming meter — the plugin cannot raise it, and a stream that exceeds it fails the job with a typed outcome and leaves no partial blob
- [ ] Extraction is enqueued after the transaction commits, so a down queue leaves a readable document at extraction_status 'pending' — the same contract as the manual path
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Run an importer fixture that files a fixture PDF against a company: the document appears on the record with provenance naming the integration, extraction completes, and uploading the identical file by hand dedupes to the same row.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §5; docs/spec-storage-sources.md §3.1 entry point 7; CONTEXT.md — Sources are documents

#### `sdk-9` · afk · M — Facts live — fill blanks only, inside the existing row lock

**Blocked by:** `clean-2a`, `clean-3`, `sdk-5`, `sdk-7a`

**What to build**

Facts.fill routes through setValuesEffect, which exists and is Effect-first — but it is a patch setter with no fill-blanks mode, and deciding what is blank by reading first and writing second is a read-modify-write race that setValuesEffect's own FOR UPDATE comment exists to prevent. So this slice extends setValuesEffect with a fill-blanks mode evaluated inside that transaction, rather than wrapping it; the existing values.test.ts must pass untouched. Two more reconciliations: the Actor union in src/lib/attributes/values.ts has an id-less { type: 'integration' } member, and attribute_event's CHECK makes actor_type 'user' equivalent to actor_id being set, so an integration write today cannot say which integration. The actor_ref column and the relaxed check come from the clean area; this slice consumes them and pins the expected shape. Facts.fill returns the conflicts it refused, and the receipt id rides along as the event's refs.

**Acceptance criteria**

- [ ] setValuesEffect gains a fill-blanks mode evaluated inside its existing FOR UPDATE transaction; values.test.ts passes unmodified and a new test asserts two concurrent fills of the same blank slug produce one write and one conflict
- [ ] A blank attribute is filled and its attribute_event carries actor_type 'integration', actor_ref equal to the integration id, source 'enrichment', and refs containing the enrichment_record id; the check constraint now reads (actor_type='user') = (actor_id IS NOT NULL) AND (actor_type='integration') = (actor_ref IS NOT NULL)
- [ ] An attribute whose current value came from a user is not overwritten; Facts.fill returns it in the conflicts array with existing and proposed values and writes no attribute_event for it
- [ ] An attribute previously filled by the same integration is updated in place — machine-over-machine is a fill, not a conflict, asserted as a distinct test
- [ ] A value failing registry validation yields the existing AttributeValidationError typed failure, which the wrapper maps to permanent failure; the whole fill is one transaction, so there is never a partial write
- [ ] Filling a required attribute with an empty value is refused as a clear, matching the existing required-means-can't-clear rule
- [ ] The record timeline names the integration by its manifest name instead of the existing 'An integration' placeholder; gate 5 passes on the touched tsx
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — On a dev company with headcount empty, run the echo enricher: the cell fills and the record timeline shows the integration by name with a receipt link. Set headcount by hand, re-run: the value is untouched and the job log reports one conflict.

**Spec** — docs/spec-plugin-sdk.md §4; docs/spec-attribute-engine.md §4 (typed actor); CONTEXT.md — Enrichment (never overwrite a manually-edited field)

#### `sdk-10` · afk · S — Judgment live — machine writes that are suggestions, and Facts conflicts become them

**Blocked by:** `ai-5`, `objects-3`, `sdk-9`

**What to build**

The last write lane. Judgment.suggest lands a claim in the review inbox rather than the graph, and the same lane picks up the conflicts Facts refused: 'Apollo says 120, you have 85 — accept?' is a suggestion row, not a log line. Provenance comes from the bound row, plus the rationale and refs the claim carries so the reviewer sees why. This slice also rewires Facts.fill's conflicts, which today it only returns, to raise suggestions — closing the loop the spec draws between the two ports. It waits on the AI substrate's suggestion table and inbox, which own that schema and that surface; this is the plugin-side producer, not the inbox. The dedupe key for a repeated suggestion is agreed with that area rather than invented here: a partial unique index over open suggestions on (entity, slug, proposed value).

**Acceptance criteria**

- [ ] Judgment.suggest writes one suggestion row per claim with the integration as proposer and the claim's rationale and refs carried through verbatim
- [ ] A Facts.fill conflict raises exactly one suggestion naming the attribute slug, the existing value and the proposed value; a second identical run raises no duplicate for the same open (entity, slug, value), enforced by the index the ai area owns rather than by a read-then-write in this port
- [ ] Accepting the suggestion through the inbox's existing accept path writes the value with actor_type 'user' and source 'suggestion' with the suggestion id on the attribute_event — asserted as an integration test against that path, which this slice does not build
- [ ] No port lets a plugin write a suggestion as already-accepted; a test asserts the status is always the inbox's initial state
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Set a company's headcount by hand, run the echo enricher with a different headcount: the value is untouched and one suggestion appears in the inbox naming both values; accept it and the timeline shows a user write citing the receipt.

**Spec** — docs/spec-plugin-sdk.md §4; CONTEXT.md — Plugin architecture (claims routed through lanes); CONTEXT.md — Enrichment (Apollo says X, you have Y)

---

## 18. Plugins run unattended, Apollo enriches

_Extensibility · 9 slices (sdk-14b dropped, D62) · reconciled 2026-10-02 against D51–D58 and the code project 17 shipped (PR #4); owner calls D62–D65_

A Layer per (integration, job) built from the job's `uses`, queues per job, the breaker, hot reload, then Apollo end to end with credit safety, manifest actions, live status and event triggers.

**Order:** `sdk-12a` ∥ `sdk-15` → `sdk-12b` (migration) → `sdk-13` ∥ `sdk-14a` ∥ `sdk-17` ∥ `sdk-19` → `sdk-16` → `sdk-18`. `sdk-12b` is the only migration-labelled slice, and it shares the one migration lane with every other migration slice in flight.

**What project 17 already built, so no slice here rebuilds it:** the manifest with per-job `trigger` and `uses` (no kind, D51), trigger-shaped job types and the `cost` hook (D53) in `packages/sdk/src/contract.ts`, `definePlugin` with `onEnable`/`onDisable`, the testing kit's recording Layers (`@spaces/sdk/testing`), the loader's steps 1–4 and 8 (`apps/worker/src/plugins/loader.ts`, `reconcilePlugins`, which returns `loaded` plugins with their job functions but registers nothing), every live port except `Ai` and `PluginDb` (`packages/core/src/writes/ports/*`: Identity, Facts, Content, Judgment, Receipts, Read, Secrets, Config, Http, Log, plus `AmbientPortsLive`), the worker's `Enqueue` (`apps/worker/src/plugins/enqueue.ts`), `job_run` with `integration_id` and a reserved `skipped` status, `runJob`'s `refs → integrationId`, `integration.error_count`/`last_error`/`status`, and `enrichment_record.integration_id` + `credits_used` (D57). Jobs call ports; there are no returned claims and no router (D52).

**Not in this project, and not blockers:** `Ai` live (`backfill-11`), `PluginDb` and plugin migrations (`sdk-24a`), the Integrations page and settings/key form (`sdk-20a`/`sdk-20b`, project 19). Until `sdk-20b`, an operator keys Apollo with the dev script `sdk-15` adds under `scripts/`.

### ▸ A Layer per job, and a queue per job

_The privilege boundary is built and released per (integration, job): a job that reaches for a port it did not declare fails with service-not-found while the database stays clean and the worker stays up. Queues register, schedule and unregister without a restart._

#### `sdk-12a` · afk · M — A Layer per (integration, job) — the privilege boundary, built and released

**Blocked by:** none (sdk-11, sdk-6a, sdk-6b, sdk-7a, sdk-7b, sdk-9 shipped in project 17)

**What to build**

Loader step six (spec §7). For each plugin `reconcilePlugins` returns in `loaded`, build one scoped Layer per (integration, job) holding exactly the ports that job's manifest `uses` names (D51), bound to the row: the ambient four through `AmbientPortsLive(row, { settings, rpm })`, the lane ports through their `*Live(row)` constructors, and the worker's `Enqueue` (`workerEnqueue`) where Identity and Content hand work back. There is no kind and no port table: `uses` is the grant. Cache the Layer per (integration, job) and release its scope on disable.

Two ports have no live implementation yet, `Ai` (`backfill-11`) and `PluginDb` (`sdk-24a`). A plugin whose job declares either is marked `degraded` by the loader with the port named ("job research uses Ai, which this host does not provide yet"), never half-wired.

Export `invoke(integrationId, jobName, input)`, which runs a loaded job through its Layer directly with the trigger's input shape (`ActionInput`, `ScheduleInput`, …); it is the demo seam and what `sdk-12b` wraps. An action job written as `{ run, cost }` (D53) is invoked through `run`. Call `onEnable` on the transition into enabled and `onDisable` on release; a hook that fails degrades that plugin with the message in `last_error` and leaves the others running.

**Acceptance criteria**

- [ ] The echo fixture's `enrich` job, invoked through `invoke`, has exactly Read, Http, Identity, Receipts, Facts and Log; an `overreach` fixture whose built bundle yields `Facts` from a job that declares only `Log` fails with service-not-found mapped to `JobPermanent`, and the database shows no write from that run
- [ ] Layers are cached per (integration, job): two invocations of one job build one Layer, asserted by a construction counter
- [ ] A plugin whose job declares `Ai` or `PluginDb` is `degraded` with the port named in `last_error`, and no Layer is built for it
- [ ] `onEnable` runs once on the transition to enabled and `onDisable` on release; a throwing hook degrades that plugin with its message in `last_error` and the others keep running
- [ ] Releasing a plugin closes its Layer scope (Http client, any pg handle), asserted by a finalizer counter
- [ ] Full gate pass: typecheck, test, lint, prettier; full `turbo run build` (fixtures under `plugins/` are built by it)

**Demo** — With the echo and overreach fixtures enabled (rows inserted by SQL), call `invoke` for echo's `enrich` job and watch the identity, receipt and fact land through the ports; invoke the overreaching job and watch it fail with service-not-found while the database stays clean and the worker stays up.

**Spec** — docs/spec-plugin-sdk.md §7 step 6; §4 (ports granted per integration and job, D51)

#### `sdk-12b` · afk · M · migration — Queues per job — register, schedule, unregister without restarting

**Blocked by:** `sdk-12a`

**What to build**

Loader step seven. For every declared job: `createQueue` and `boss.work('plugin.<id>.<job>', runJob(def, { host, layer }))` with the Layer `sdk-12a` built, a `JobDef` whose `schema` is the trigger's input shape and whose `refs` returns `{ integrationId, entityId }` (an action's `entityId`) so `job_run` is attributed through the existing write point. A `schedule` job is `boss.schedule`d at its manifest cron; its `ScheduleInput.cursor` lives in a new `integration.cursors` jsonb column keyed by job name (null until the first run) and is advanced from the returned `nextCursor` in the transaction that closes the run. Nothing in the spec gives the cursor a home today; this column is that home, and it is why this slice is `migration`-labelled (`pnpm db:generate --name integration_cursors`, SQL hand-inspected). The column references no entity, so no `ENTITY_REFS` entry. The manifest's `concurrency`, `timeout` and `retry` become the work and queue options; an `interactive: true` job gets its own queue name (`plugin.<id>.<job>.interactive`) so `sdk-18` can tune it later. Disable is the exact reverse: unregister, unschedule, release the scope, forget the module. Schedules are reconciled, not appended: a job that drops its schedule on upgrade is unscheduled.

`event`, `webhook` and `file` jobs are registered as queues here but nothing enqueues them yet: `sdk-19` adds the event dispatcher, `sdk-23` (project 19) the ingress, and `file` keeps the path the importer fixture already proves.

Web's `enqueue()` (`apps/web/src/lib/queue.ts`) is typed against `QueueName`; widen it to also accept `` `plugin.${string}.${string}` `` without weakening the core type. No other web change.

**Acceptance criteria**

- [ ] Every declared job is `createQueue`'d and registered as `plugin.<id>.<job>` through `runJob` with the manifest's concurrency, timeout and retry; enqueuing echo's `echo` runs it end to end and leaves a `job_run` row carrying `integration_id`
- [ ] The syncer fixture's `sync` job is scheduled at its cron; its returned `nextCursor` is stored in `integration.cursors.sync` and is what the next run receives, including after a worker restart; removing the schedule from the manifest and reconciling unschedules it, asserted against pg-boss's schedule table
- [ ] Releasing a plugin unregisters its queues; a job enqueued for it afterwards stays queued rather than erroring, and re-enabling drains it
- [ ] `enqueue()` accepts plugin queue names, and a misspelt core queue name still fails typecheck
- [ ] An `interactive: true` job is registered on its own queue name
- [ ] Full gate pass: typecheck, test, lint, prettier; full `turbo run build`

**Demo** — With the echo fixture enabled, enqueue `plugin.echo.echo` from the dev app or a psql-side send and watch the worker run it; disable the row and reconcile, enqueue again, and watch the job sit queued while the extraction queue keeps working.

**Spec** — docs/spec-plugin-sdk.md §7 step 7; §11 (queue names encode ownership); §5 (trigger shapes)

### ▸ Failures disable the plugin, never the worker

_Five failures fill job_run, set the integration aside with a reason and put one line on Today while extraction keeps working in the same worker. Enable, disable and upgrade happen over NOTIFY with no restart, and a restart stays an ordinary restart (D62)._

#### `sdk-13` · afk · M — Plugin breaker — five failures disable the integration, never the worker

**Blocked by:** `sdk-12b` (clean-2b shipped)

**What to build**

Attribution is already in place: `runJob` writes `job_run.integration_id` from the `refs` `sdk-12b` supplies, through its one write point. This slice is the breaker. A plugin job that ends `failed` increments `integration.error_count` and stamps `last_error` with the typed failure tag, in the same transaction that closes the `job_run` row (the ledger's `end`, not a second insert site). Five failures inside an hour, counted from `job_run` grouped on the queue name's `plugin.<id>` segment, set `integration.status = 'disabled'` with the reason in `last_error` and unregister that plugin's queues, while `integration.enabled` stays `true`: breaker-tripped and operator-disabled stay distinguishable, and re-enabling is a reset, not a reinstall (what `sdk-20a` renders). `reconcilePlugins` must leave a tripped row alone (enabled, status disabled) instead of marking it `enabled` again at the next boot; only a reset clears it. Contract 2 means the worker survives all of it. Today's line reuses `LedgerSection` and `LedgerRow`.

**Acceptance criteria**

- [ ] A failed plugin job increments `error_count` and stamps `last_error` in the transaction that closes its `job_run` row; `job-run-one-writer.test.ts` stays green because no insert site is added
- [ ] Five failures of a `throws` fixture inside an hour set `status = 'disabled'` with reason '5 failures in an hour', leave `enabled = true`, unregister its queues, and leave the worker running and extraction working
- [ ] A worker restart does not re-enable a tripped plugin: `reconcilePlugins` skips it, asserted by test
- [ ] Two plugins failing in the same hour trip independently (grouped on `plugin.<id>`)
- [ ] Tripping on the fifth job of a batch neither deadlocks nor drops the in-flight batch
- [ ] Four failures, a success, then one failure does not trip the breaker
- [ ] Today shows one line per tripped plugin and clears when the row is reset (by SQL here; the button lands with `sdk-20a`); `pnpm lint` (gate 5) passes on the touched tsx
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enqueue the throws fixture five times: `job_run` fills with failures attributed to the integration, the row flips to disabled with a reason, one line appears on Today, and extraction keeps working in the same worker. Restart the worker: it stays disabled. Reset by SQL and the line clears.

**Spec** — docs/spec-plugin-sdk.md §11 (isolation, breaker, queue-name grouping); CONTEXT.md — Hostability decisions (contract 2)

#### `sdk-14a` · afk · M — NOTIFY plugin_changed — enable, disable and upgrade without a restart

**Blocked by:** `sdk-12b`

**What to build**

There is no LISTEN client and no NOTIFY anywhere in the codebase; this adds the first. The worker holds a dedicated pg connection listening on `plugin_changed`; a notification carrying a plugin id re-runs the loader for that one id: release the old scope, unregister its queues, forget the module, then reconcile from disk and the row. Forgetting an ESM module is the sharp edge: `import()` caches by URL, so a version swap must import the new version's path (the version-directory layout gives one) and the reload must prove the new bundle ran. The connection reconnects with backoff and reconciles everything on reconnect, because a missed notification must not leave the worker's view stale. There is no exit-75 fallback (D62): if in-process reload ever fails, the remedy is an ordinary restart.

**Acceptance criteria**

- [ ] With the worker running, setting a fixture row enabled and calling `pg_notify('plugin_changed','echo')` registers its queues within a second, and a job enqueued immediately runs, with no restart
- [ ] Disabling by the same route unregisters queues and releases the Layer scope; a job already running finishes rather than being killed mid-write
- [ ] Swapping `current` to a new version directory and notifying runs the new bundle, asserted by a fixture whose two versions write different values through `Log` (or a port) — the ESM cache does not serve the old module
- [ ] Terminating the LISTEN backend reconnects within the backoff window and performs a full reconciliation, asserted by changing a row while the connection is down
- [ ] Two notifications for the same id arriving together produce one reconciliation
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Worker in one terminal, psql in the other. Update the row and NOTIFY: the worker log shows unregister, reload, register, and an enqueued job runs at once. Terminate the listener's backend and watch it reconnect and reconcile.

**Spec** — docs/spec-plugin-sdk.md §7 (runs on boot and on NOTIFY plugin_changed); §10 (split roles; NOTIFY crosses processes)

#### `sdk-14b` · Dropped (D62) — Exit-75 reload

Not built. In-process reload (`sdk-14a`) plus an ordinary restart is the answer; hostability contract 2 stays as it is, and spec §7's exit-75 fallback is struck. Nothing depends on it.

### ▸ Apollo enriches a company

_Key Apollo with the dev script (until `sdk-20b`), see the Enrich action on records rendered from the row's manifest, click it and watch blanks fill with Apollo as actor and the raw payload in an `enrichment_record` — credit-capped, 90-day cached, refusals visible on Today._

#### `sdk-15` · afk · M — plugins/apollo — the provider mapping, tested with no database

**Blocked by:** none (sdk-4b, sdk-5 shipped; the echo fixture's `enrich` job is the shape to copy)

**What to build**

`plugins/apollo` (`@spaces/plugin-apollo`) as a real bundle: a manifest declaring `requires.credential { kind: 'enrichment', scope: 'workspace' }`, its settings (including `cacheDays` default 90 and `dailyCreditCap`, which `sdk-16` enforces), `http.rateLimit`, and two `action` jobs, `enrichCompany` and `enrichPerson`, each `uses: ['Read', 'Http', 'Identity', 'Receipts', 'Facts', 'Log']`, each written as `{ run, cost }` (D53: `cost` is pure, `{ credits }` per entity in Apollo's unit, from the input alone). Actions: Enrich on `company` and on `person`.

The job calls ports in order (D52): `Read.entity` for the domain or email; `Http` to `organizations/enrich` or `people/match` with `X-Api-Key` from `Secrets` (HttpLive's header-driven throttle is the rate limiter, not a second one); `Receipts.store` with the raw response and `creditsUsed`; `Identity.addAlias`/`resolve` for keys Apollo returns; `Facts.fill` for the mapped attributes, citing the receipt. A pure `map.ts` turns provider JSON into those port arguments. Role emails are rejected with `@spaces/sdk/identity`'s `isRoleEmail`, not a local list. Apollo's own error text rides the typed failure; a 402 or 403 from a paid-plan-only endpoint is `JobPermanent`, not retried. Provable with the testing kit's recording Layers against committed fixtures derived from Apollo's documented responses, secrets scrubbed: no database, no network, no integration row.

Keying, until the settings form (`sdk-20b`, project 19): a small dev script under `scripts/` reads the Apollo key from an env var (`APOLLO_API_KEY`), stores it as a workspace `enrichment` credential through core's `storeCredential` (encrypted by the vault, never raw SQL), and inserts or updates the `apollo` `integration` row pointing at it, enabled. Idempotent: a second run updates the key and leaves one row. The root `tsconfig.json` already covers `scripts/**/*.ts`, so it typechecks under `typecheck:root`; it must resolve `@spaces/core` from where it runs.

**Acceptance criteria**

- [ ] `plugins/apollo` builds to `bundle.mjs` + `manifest.json` and imports `@spaces/sdk`, `effect` and `zod` only — a core or db import fails lint
- [ ] Against the fixtures, enriching a company by domain records one `Receipts.store`, the identity alias calls and one `Facts.fill` with the mapped attributes, in that order; the recorder's call log is snapshotted
- [ ] A person match returning only a role email records no identity call for that email
- [ ] A 402 or 403 fixture fails `JobPermanent` carrying Apollo's own message
- [ ] `cost` returns credits from the input without touching Http; each job's `R` is bounded by its `uses` (typecheck)
- [ ] The package's vitest suite is green with Postgres stopped and the network off; the fixtures carry no key material
- [ ] The dev script, run with `APOLLO_API_KEY` set, leaves exactly one enabled `apollo` integration row with an encrypted workspace `enrichment` credential; a second run with a new key updates both and adds no row; with the variable unset it exits non-zero naming it
- [ ] Full gate pass: typecheck, test, lint, prettier; full `turbo run build`

**Demo** — Run the package's tests with the network off: the Apollo fixtures produce a snapshotted call log (receipt, aliases, fill), the role-email fixture produces no identity call, and the 402 fixture fails permanently with Apollo's sentence. Then run the dev script with a key and see the `apollo` row and its credential in the dev database.

**Spec** — docs/spec-plugin-sdk.md §5 (triggers, port calls, D52/D53); §13 step 1; CONTEXT.md — Enrichment (Apollo endpoints, headers, error text)

#### `sdk-16` · afk · M — Credit safety — daily cap, 90-day cache, refusals that are visible

**Blocked by:** `sdk-13`, `sdk-15`

**What to build**

D53 settles where the guards live: in the host, around an `action` job, so a plugin cannot bypass them and `Receipts` keeps one `store()`. Before the job runs, in the wrapper `sdk-12b` registers:

1. **Cache:** if the entity's most recent `enrichment_record` for this integration (`integration_id`) is younger than `cacheDays`, skip — no provider call.
2. **Cap:** ask the job's `cost` hook for the estimate; if today's spend plus the estimate exceeds `dailyCreditCap`, refuse before any API call. A job with no `cost` hook is still refused once today's spend has reached the cap.
3. **Spend** is only ever `sum(enrichment_record.credits_used)` for this integration since UTC midnight, so it survives a restart.

A skip or refusal closes `job_run` with status `skipped` (already in the enum; no migration) and a reason, never a silent success: `runJob` gains a `skipped` outcome kind mapped to that status. `cacheDays` and `dailyCreditCap` are read from `integration.config` by those names and declared in the plugin's settings schema, so the Integrations page renders them without special-casing Apollo.

**Acceptance criteria**

- [ ] Enriching an entity whose latest receipt for this integration is younger than `cacheDays` makes no provider call and closes `job_run` as `skipped` with reason 'cached (enriched 12 days ago)'
- [ ] With `dailyCreditCap = 2` and a `cost` of 1, the third job of the day is refused before any Http call, closes `skipped` with the cap named, and shows one line on Today; gate 5 passes on the touched tsx
- [ ] Spend is per integration per UTC day from `enrichment_record`, asserted by restarting the guard mid-day and reading the same total
- [ ] The guards live in the host: a fixture job with no `cost` hook is still refused once the day's receipts reach the cap
- [ ] `runJob`'s new `skipped` outcome is the only writer of `job_run.status = 'skipped'`
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enrich a company twice: the second run logs 'cached, 0 credits' and `job_run` shows skipped. Set `dailyCreditCap` to 2 and enqueue three: the third is refused with the cap named and Today shows it.

**Spec** — D53; CONTEXT.md — Enrichment (credit safety); docs/spec-plugin-sdk.md §4 (Receipts), §11 (job_run)

#### `sdk-17` · afk · M — Manifest actions — the Enrich button, in the record head (D63)

**Blocked by:** `sdk-12b` (sdk-11 shipped: the loader already writes `integration.manifest`). `sdk-15` is needed for the Apollo demo only; echo's declared actions demo it earlier.

**What to build**

Web renders actions from `integration.manifest`, decoded with `manifestSchema`, and never loads a bundle or reads `/data`. For each enabled integration whose `status` is `enabled`, every declared action whose `on` (`company` · `person` · `deal`) matches the record's kind is a control in the **record head's action area** (D63), beside the record's own actions, using the existing record-head control styling. Firing it enqueues `plugin.<id>.<job>` with `{ entityId }` through a server fn and returns at once. A plugin that is degraded, disabled or breaker-tripped shows **no** action; Review and the Today line say why (the plugin and its `last_error`), so the record head never carries a broken control. Instrument vocabulary only (gate 5). Any member may fire an action (`requireUser`); settings and keys stay admin (`requireAdmin`).

**Acceptance criteria**

- [ ] With Apollo (or echo) enabled, a company record's head shows its declared action in the action area; degraded, disabled or tripped, it shows none; the web build contains no import of `plugins/*` and no read of the plugins directory, asserted by a build-output grep test
- [ ] A degraded or tripped plugin with declared actions appears on Today (and in Review) with its reason, so the missing action is explained somewhere the user looks
- [ ] Clicking enqueues `plugin.<id>.<job>` with the entity id and returns at once; a `job_run` row appears
- [ ] An action declared `on: 'person'` does not appear on company or deal records
- [ ] A non-admin member can fire the action and cannot reach Settings
- [ ] No new route file (a component plus a server fn); if one is added, `pnpm generate-routes` runs and `routeTree.gen.ts` is committed
- [ ] Gate 5 passes on the new tsx
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a company record with Apollo enabled: Enrich sits in the record head, and firing it produces a `job_run` row and, seconds later, filled blanks. Mark Apollo degraded and reload: the action is gone and Today says why, with no code change.

**Spec** — D63; docs/spec-plugin-sdk.md §3 (actions), §11 (manual trigger); docs/design-contract.md

### ▸ Under a second, and on creation

_LISTEN/NOTIFY to SSE so the cell goes pending then resolves with no refresh, survives a mid-run reload, and settles into failure rather than spinning when the worker dies. New companies with a domain enrich themselves on creation when the operator turns it on._

#### `sdk-18` · afk · M — Interactive status — one LISTEN client, SSE to the record (D64)

**Blocked by:** `sdk-13`, `sdk-14a`, `sdk-17`

**What to build**

Jobs declaring `interactive: true` get batch size 1 and the manifest's short timeout on the queue `sdk-12b` gave them. `runJob`'s ledger emits `pg_notify('job_status', …)` when it opens and closes a plugin job's `job_run` row (in the writer, so no trigger and no migration). Web holds **one shared LISTEN client** (D64) that fans each notification out to the SSE subscribers of an `apps/web/src/routes/api/` stream; it is the first long-lived pg client in the web process, created lazily, released on shutdown, and its module comment says so. The record page subscribes for its entity, so the cell reads pending and then the outcome with no polling. Pending and failed **reuse the existing ledger cell states** (D64): no new visual vocabulary. Reopening the page, or reconnecting a dropped stream, recovers state from `job_run`, never from a notification that already fired.

**Acceptance criteria**

- [ ] A new route under `apps/web/src/routes/api/` serves the stream; `pnpm generate-routes` runs and `routeTree.gen.ts` is committed
- [ ] An `interactive: true` job runs on its own queue with batch size 1 and its short timeout; batch jobs never starve it
- [ ] Firing Enrich shows the pending ledger state in under 200 ms locally and flips to the outcome when the job closes, with no polling request
- [ ] Closing and reopening the record mid-run shows the same pending state, read from `job_run`
- [ ] A dropped SSE connection reconnects and resyncs from `job_run`; the stream carries nothing the viewer could not read (`canRead` as the viewing user, never as the integration)
- [ ] Web holds exactly one LISTEN connection however many subscribers there are, asserted by test, and releases it on shutdown
- [ ] Pending and failed use the existing ledger cell states; gate 5 passes
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Click Enrich and watch the cell go pending then resolve with no refresh; reload mid-run and see pending restored; kill the worker mid-run and watch the cell settle into the failed state instead of spinning.

**Spec** — D64; docs/spec-plugin-sdk.md §11 (interactive jobs, SSE)

#### `sdk-19` · afk · M — Event triggers — enrich-on-create from resolveEntity and createDeal (D65)

**Blocked by:** `sdk-12b`, `sdk-15`

**What to build**

The contract half shipped in project 17: an `event` job declares `on: ['entity.created']` and receives `EventInput { event: DomainEvent }` (`DOMAIN_EVENTS` is closed at `entity.created`, kinds company · person · deal). This slice builds the emitter and the dispatcher, as D65 decided:

- **Emitted from `resolveEntity`** (company and person births, `packages/core/src/writes/entities/resolve.ts`, both `resolveEntity` and `resolveEntityInTx`) **and `createDeal`** (deal births, `apps/web/src/lib/server/deals.ts`), after the birth commits, never on an attach.
- **Skipped for seed and import births** (`source_class` `seed` or `import`), so seeding or a CSV never fans out into enrichment.
- **No outbox, no NOTIFY bus, no migration:** the dispatcher maps the event to `plugin.<id>.<job>` enqueues through the `Enqueue` service each process already has (`webEnqueue` in web, `workerEnqueue` in the worker), for enabled, non-degraded, non-tripped subscribers.
- **`autoEnrich` is off by default:** a per-integration config toggle the dispatcher reads; off means no enqueue.

Apollo gains an `event` job (`onCompanyCreated`, `on: ['entity.created']`) that declines an entity with no domain without spending a credit. CONTEXT.md's Plugin architecture block points at D65.

**Acceptance criteria**

- [ ] With `autoEnrich` on, creating a company with a domain emits `entity.created` once and enqueues Apollo's event job within a second; one without a domain is declined without a credit spent
- [ ] `autoEnrich` absent or off enqueues nothing
- [ ] A seeded or imported company emits no event; an attach (resolve finds an existing record) emits no event
- [ ] A deal created through `createDeal` emits `entity.created` with kind `deal`
- [ ] An event with no subscribers enqueues nothing (no `job_run` row)
- [ ] Merging two entities emits no `entity.created` for the survivor
- [ ] A degraded, disabled or tripped subscriber is skipped without raising into the write path that emitted the event
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Turn `autoEnrich` on and create a company with a domain in the dev app: the record fills itself within a second or two. Turn it off and create another: nothing enqueues. Seed a company: no event.

**Spec** — D65; docs/spec-plugin-sdk.md §5 (event trigger), §11; CONTEXT.md — Enrichment (never auto-enrich in bulk)

---

## 19. Install from the app, no redeploy

_Extensibility · 10 slices_

The integrations ledger, manifest-generated settings forms, install/upgrade/uninstall, the plugin release pipeline, air-gapped install, webhook ingress, plugin schemas, and the chaos suite that decides whether a plugin ships.

### ▸ The integrations ledger

_Settings → Integrations shows installed rows with version, status, last run and last error — Apollo enabled, a fixture breaker-disabled with a working reset, an old-sdk fixture degraded with the fix named — in the settings shell rather than a third invented layout. A manifest becomes an editable card with an inline-validated key field, and saving reloads the worker with the new config._

#### `sdk-20a` · hitl · M — Integrations ledger — installed rows, version, status, last run, last error

**Blocked by:** `clean-2a`, `sdk-13`, `sdk-14a`

**What to build**

The read half of the admin surface, split from the write half because src/routes/_app/settings.tsx is already 881 lines and the form generation is the harder problem. A new route lists every integration row with version, status, last_run_at, last_error and credits used, read from the row and job_run; web renders it from integration.manifest and loads no plugin code. Enable, disable and breaker-reset are the buttons here. New UI and a new settings section, so a human reviews against DESIGN.md — particularly how the three kinds of not-running read differently: degraded (the box could not load it, with the reason), breaker-disabled (it failed five times, offer reset), and operator-disabled (you turned it off). A missing key must read as 'not yet', not as an error. Admin-only via the existing requireAdmin gate.

**Acceptance criteria**

- [ ] A new route under src/routes/_app/ lists every integration row with version, status, last_run_at, last_error and credits used; pnpm generate-routes is run and routeTree.gen.ts is committed
- [ ] Degraded, breaker-disabled and operator-disabled render as three visibly different states; breaker-disabled offers a reset that clears error_count and restores status, and a NOTIFY reloads the plugin
- [ ] Disable unregisters queues (via NOTIFY) and the record-page actions disappear on the next load
- [ ] The page loads no plugin code and reads no plugin file: it renders from the row and its manifest jsonb, asserted by the same build-output test sdk-17 added
- [ ] A non-admin visiting the route is refused by requireAdmin, matching the rest of settings
- [ ] Gate 5 passes on the new tsx; the section follows the existing SettingsSection pattern
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Integrations with Apollo and the throws fixture on disk: Apollo shows enabled with its last run, the fixture shows breaker-disabled with its reason and a working reset, and the old-sdk fixture shows degraded with the version fix named.

**Spec** — docs/spec-plugin-sdk.md §9 (Installed pane); docs/spec-plugin-sdk.md §12 (admin-only); DESIGN.md — settings registry ledger

#### `sdk-20b` · hitl · M — Settings form and the key field — a manifest becomes an editable card

**Blocked by:** `sdk-20a`, `sdk-6a`

**What to build**

The write half: the settings form generated from the manifest's emitted JSON Schema, and the credential field generated from requires.credential so the operator pastes a key into the vault write-only. Saving writes integration.config and NOTIFYs; a config that fails the schema shows the error inline against the field rather than degrading the plugin. Pasting a key creates or updates the workspace credential row through storeCredential and sets integration.credential_id, then the plugin goes from degraded('missing credential') to enabled without a restart. Human review because this is where a generated form has to look like it was designed: which JSON Schema types the renderer supports (string, number, boolean, enum, and nothing else in v1), how a redacted key reads, and what a validation error looks like in the Instrument vocabulary.

**Acceptance criteria**

- [ ] The settings form renders from the manifest's JSON Schema for string, number, boolean and enum fields, with anything else refused at manifest-validation time rather than rendered badly
- [ ] Saving writes integration.config and NOTIFYs; a value failing the schema shows inline against its field and writes nothing
- [ ] Pasting a credential stores it workspace-scoped through storeCredential with provider equal to the plugin id, displays it redacted, sets integration.credential_id, and flips the row from degraded('missing credential') to enabled without a restart
- [ ] Removing a credential returns the row to degraded('missing credential') and the record-page actions disappear
- [ ] A non-admin is refused by requireAdmin; the key is never returned to the client in any form but redacted
- [ ] Gate 5 passes on the new tsx
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Integrations → Apollo: paste a key, watch the row go enabled and the Enrich action appear on records; set cacheDays to a bad value and see the inline error; set it to 30 and watch the worker reload with the new config.

**Spec** — docs/spec-plugin-sdk.md §9; docs/spec-plugin-sdk.md §3 (settings); DESIGN.md — settings registry ledger

### ▸ Install, upgrade, uninstall — and how a plugin reaches anyone

_Click Install and watch files land under the data dir and the worker load and enable it without touching a terminal; a tampered tarball is refused with the data dir untouched. A new version gets its own directory and runs its own migrations, the previous is kept one back, and a rollback after a migration refuses by name rather than corrupting. Merge a changeset and a plugin-<id>@x tag builds, tests, packs, signs and publishes it with the registry entry updated in the same commit._

#### `sdk-21b` · hitl · M — Install from the running deployment — fetch, unpack, row, notify, uninstall

**Blocked by:** `sdk-14a`, `sdk-20a`, `sdk-21a`

**What to build**

Install with no redeploy, Nextcloud-shaped, on top of sdk-21a's verifier. Web fetches the tarball named by the committed registry, verifies it, unpacks to <data>/plugins/<id>/<version>, swaps the current symlink, writes lock.json, inserts the integration row as installing, and notifies; the worker does the rest. Web moves bytes and writes rows; it never executes plugin code. Upgrade is the same path to a new version directory with the previous kept one back. Uninstall is the inverse and needs the human call this slice carries: what happens to source_ref on entities, values, documents and receipts that point at the row — soft-delete the row forever so provenance survives ('filled by Apollo, since removed'), or null the references and lose the attribution. Human review also covers the Available pane's look beside the Installed ledger.

**Acceptance criteria**

- [ ] Installing from a fixture registry served off disk lands files under <data>/plugins/<id>/<version>/, updates lock.json to { core, plugins: { <id>: <version> } }, writes the integration row, and the worker enables it within a second with no restart
- [ ] A refused tarball (any of sdk-21a's reasons) writes nothing — no partial directory, no row, no lock.json edit — verified by inspecting the data dir after the failure
- [ ] Upgrading creates a new version directory, swaps current, keeps the previous directory one back, and reloads the Layer; the old version's files are not deleted
- [ ] Uninstall removes the files, deletes the credential, and follows the recorded decision on source_ref, which is written into CONTEXT.md as part of this slice; a test asserts the chosen behaviour on an entity the plugin created
- [ ] Install, upgrade and uninstall all go through one installer function with one caller per entry point, asserted by test rather than by convention
- [ ] Any new route files are accompanied by pnpm generate-routes and a committed routeTree.gen.ts; gate 5 passes on the Available pane
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Integrations → Available, click Install on the fixture plugin: files appear under the data dir, lock.json updates, and the worker log shows it loading and enabling — without touching the terminal. Serve a tampered tarball and watch the refusal leave the data dir untouched. Uninstall and check what the record page says about who filled the field.

**Spec** — docs/spec-plugin-sdk.md §9; docs/spec-plugin-sdk.md §10 (plugin upgrade, rollback = restore); CONTEXT.md — Plugin architecture (install from the running deployment)

#### `sdk-22` · afk · M — Air-gapped install and SPACES_PLUGINS — the same installer, two other doors

**Blocked by:** `sdk-21b`

**What to build**

Two conveniences over the one installer, so there is no second code path to keep honest. An upload accepts a .tgz directly for boxes with no outbound HTTPS, running the identical verify-unpack-row-notify sequence. And SPACES_PLUGINS=apollo,rss is a first-boot convenience that runs the installer once against the bundled registry snapshot — optional, with the required-env set still frozen, so a box that never sets it is unaffected. SPACES_CREDENTIAL_<ID> seeds the vault once and is then ignored: env is an input to the vault, never the store, which is what keeps a rotated key from being silently reverted on the next boot. The <ID> is the plugin id and becomes credential.provider, matching what the Integrations page writes, so the two paths cannot produce two rows for one plugin.

**Acceptance criteria**

- [ ] Uploading a .tgz installs it through the same installer function as a registry install, verified by a test asserting one function with two callers; any new route is accompanied by pnpm generate-routes
- [ ] An uploaded tarball failing verification is refused with the same named reason as the registry path
- [ ] SPACES_PLUGINS on a fresh volume installs the named plugins at boot; on the second boot it is a no-op with no re-download and no row churn, asserted by comparing lock.json mtime and the row's updated timestamp
- [ ] SPACES_CREDENTIAL_<ID> seeds a workspace credential with provider = <ID> only when none exists; changing the key in the UI and rebooting keeps the UI's key
- [ ] Unsetting SPACES_PLUGINS uninstalls nothing — the row is intent and the env is a one-time convenience
- [ ] Booting with only DATABASE_URL and APP_URL set installs nothing and warns nothing, asserted by test
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With outbound HTTPS blocked in the container, upload apollo-1.2.0.tgz through Settings and watch it install and enable. Separately, bring up a fresh volume with SPACES_PLUGINS set: both plugins install on first boot and nothing happens on the second.

**Spec** — docs/spec-plugin-sdk.md §9 (air-gapped upload, SPACES_PLUGINS); CONTEXT.md — Hostability decisions (frozen required-env set)

#### `backfill-13` · afk · M — Plugin upgrade — a new version dir, its own migrations, and a rollback that refuses

**Blocked by:** `sdk-20a`, `sdk-21b`, `sdk-24a`

**What to build**

sdk-21b's installer already moves bytes for an upgrade (new version directory, swap current, previous kept one back) and sdk-24a runs a plugin's migrations against its own schema and journal on load. What §9 and §10 specify and nothing owns is upgrade as a flow: the update badge computed against the registry snapshot (semver satisfying, minCore and sdk range respected), one click to take it, SPACES_PLUGINS_AUTOUPDATE=compatible taking the newest satisfying version on boot with the default off, and the rollback rule — safe only if no migration ran, otherwise restore. Add the version comparison and its badge to sdk-20a's Integrations ledger, the boot path behind the env var, and the migration-ran record on the integration row that makes the rollback answer honest instead of a guess. The env stays optional with a working default, so the frozen required set {DATABASE_URL, APP_URL} is unchanged. Joins project 13 (Install from the app, no redeploy).

**Acceptance criteria**

- [ ] A plugin whose registry snapshot lists a newer satisfying version shows an update badge naming the target version; one whose newest version needs a newer core or a newer sdk major shows no badge and says why
- [ ] One click runs sdk-21b's installer at the new version and the worker reloads the new bundle over NOTIFY with no restart; the ledger's version column changes
- [ ] The new version's own migrations run against its schema and journal on reload; a failing migration leaves the plugin degraded with the statement in last_error, the previous version's directory intact, and public untouched
- [ ] The integration row records whether any migration ran on this upgrade, and the ledger reads 'rollback available' or 'rollback unsafe — restore from backup' from that record rather than from a guess
- [ ] SPACES_PLUGINS_AUTOUPDATE=compatible takes the newest satisfying version at boot and logs each take; unset or any other value takes nothing, and the required-env set is unchanged
- [ ] Upgrading twice keeps exactly one previous directory — the version before last is removed, asserted on disk
- [ ] lock.json matches the running version after every path (upgrade, failed upgrade, autoupdate), asserted by reading it back
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Serve a fixture registry carrying v1.1 of an installed plugin: the ledger shows the badge, one click upgrades it, the worker log shows the new bundle loading and its migration running, and the row then reads 'rollback unsafe — restore from backup'.

**Spec** — docs/spec-plugin-sdk.md §9 — update badge → one click; docs/spec-plugin-sdk.md §10 — Plugin upgrade, independent; rollback of either = restore

#### `ship-9` · afk · M — Changesets and the plugin tag — how a plugin reaches the registry

**Blocked by:** `sdk-21a`, `ship-8`

**What to build**

The spec's versioning line is the only thing that makes a plugin ecosystem reachable: 'changesets; core and each plugin version independently. CI builds the image on core@x tags and a plugin release on plugin-<id>@x tags.' ship-8 consumes the core half; this slice creates the tags and builds the plugin half. Install changesets at the root with independent versioning, so a change to plugins/apollo never bumps core and vice versa. A `plugin-<id>@x.y.z` tag runs the plugin's own tests, then invokes sdk-21a's packer — which owns the tarball, sha256 and signature format; this slice only calls it — attaches the artifact to a GitHub release, and updates that plugin's entry in the committed registry.json. The invariant worth a test: the registry.json snapshot baked into the image and the published registry entry must be the same bytes, or the loader's 'fix named from the bundled registry snapshot' points at something that does not exist. Ship a dry-run mode so the first real plugin release is not the first execution of this path.

**Acceptance criteria**

- [ ] changesets is installed at the root with independent versioning; a changeset touching only plugins/apollo bumps only that package, and a core changeset bumps only core
- [ ] Merging a release PR produces a `core@x.y.z` tag that ship-8's workflow consumes unchanged, and `plugin-<id>@x.y.z` tags for any plugin that had a changeset
- [ ] A plugin tag runs that plugin's tests first and never packs a failing plugin
- [ ] The plugin job invokes sdk-21a's packer for the tarball, sha256 and signature — this slice defines none of that format — attaches the artifact to a GitHub release, and updates the plugin's registry.json entry in one commit
- [ ] A test diffs the registry.json snapshot copied into the image against the published registry entries, so a plugin release cannot drift from what the image knows how to find
- [ ] `--no-push` dry run produces the tarball, the signature and the registry diff locally, and is exercised in this PR before any real tag exists
- [ ] CONTEXT.md gains the release procedure in five lines: changeset → merge → tag → image → registry
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Add a changeset to plugins/apollo, merge the release PR, and watch a `plugin-apollo@1.0.1` tag build, test, pack, sign and publish it — with core's version untouched and registry.json's committed entry updated in the same commit.

**Spec** — docs/spec-plugin-sdk.md §2 ('Versioning: changesets; CI builds the image on core@x tags and a plugin release on plugin-<id>@x tags'); docs/spec-plugin-sdk.md §9–§10 (registry.json, the bundled snapshot, plugin upgrade); sdk-21a (pack and verify — owns the signing scheme and registry.json format)

### ▸ Webhooks and plugin schemas

_A signed payload returns 200 in milliseconds with the raw body retained and claims landing a moment later — on a raw route outside the versioned API namespace, because HMAC is computed over the exact bytes; a flipped byte is 401 and a disabled plugin is 404. A plugin owns tables in its own Postgres schema under a role that cannot write public, proven by a real RSS poller._

#### `sdk-23` · afk · M — Webhook ingress — verify in web, store, enqueue, return in milliseconds

**Blocked by:** `clean-2c`, `sdk-12b`, `sdk-20b`

**What to build**

The inbound door for call recorders and anything that pushes. A route under the API namespace is mounted for enabled integrations whose manifest (read from integration.manifest, not from disk) declares ingress; web verifies the manifest-declared HMAC-SHA256 signature generically, with no plugin code in the web process, stores the raw payload, enqueues plugin.<id>.ingest and returns 200 immediately. The raw payload needs a home and none exists, so this slice adds an ingress_payload table — a claim that it 'stores the raw payload' without one is where the draft was hand-waving. The shared secret also needs a home: credential.kind is an enum of llm|enrichment|search with no webhook value, and a plugin needing a shared enum edited is exactly what the doctrine forbids, so this waits on the clean area opening that column. Disabled or uninstalled means 404, not a 500 and not a silently accepted payload.

**Acceptance criteria**

- [ ] Route file src/routes/api/webhooks/$id.ts exists; pnpm generate-routes is run and routeTree.gen.ts is committed
- [ ] Migration adds ingress_payload(id, integration_id, received_at, headers jsonb, body) via pnpm db:generate --name ingress_payload, SQL hand-inspected; it holds no entity FK so entity-refs.test.ts is unaffected
- [ ] A correctly signed fixture payload returns 200 in under 50ms locally, stores the raw body, and produces a job_run for plugin.<id>.ingest whose claims land
- [ ] A wrong signature returns 401 and enqueues nothing; a missing signature header on a manifest declaring hmac-sha256 also returns 401
- [ ] The route returns 404 for a plugin that is disabled, degraded or not installed, and that 404 is indistinguishable from an unknown id so the endpoint cannot be enumerated
- [ ] Signature verification is constant-time and reads the shared secret from the vault, never from the manifest or the request
- [ ] A payload above the configured size limit is rejected before it is stored, and stored payloads are pruned on a documented retention
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — curl a signed fixture payload at the webhook URL with the plugin enabled: 200 returns immediately, the ingress_payload row is there, and the claims appear a moment later. Flip one byte of the signature: 401 and nothing enqueued. Disable the plugin: 404.

**Spec** — docs/spec-plugin-sdk.md §11 (Ingress); docs/spec-plugin-sdk.md §3 (manifest ingress)

#### `sdk-24a` · hitl · M — PluginDb — own schema, own journal, and a role that cannot touch public

**Blocked by:** `mono-4`, `mono-5`, `sdk-12a`

**What to build**

Loader step five. A plugin's migrations run in Postgres schema plugin_<id> against its own journal table, entirely separate from the core drizzle journal in /drizzle — a shared journal is exactly the mistake the monorepo extraction also has to avoid. The human call is enforcement: pinning search_path does not stop a plugin writing 'insert into public.entity', so containment needs a dedicated Postgres role with no write grants on public, created at migrate time and entered with SET ROLE on the plugin's connection. That is a real deployment decision on a box whose only required env is DATABASE_URL (the role must be created by the migration runner as the owning user, and the connection reused rather than a second URL). FKs from a plugin schema to public.entity.id are allowed because the plugin depends on core; the reverse is forbidden because core must never depend on a plugin.

**Acceptance criteria**

- [ ] The containment mechanism is decided and recorded in CONTEXT.md: a plugin_runtime role created by the migration runner, entered with SET ROLE, with no write privileges on public
- [ ] A fixture plugin with two migrations creates plugin_<id> tables on first load; rebooting runs nothing new and its own journal shows two applied rows
- [ ] A migration attempting DDL in public (create table public.x, or altering a shared enum) fails, rolls back, and degrades that plugin with the offending statement in last_error — public is unchanged
- [ ] PluginDb resolves unqualified names inside plugin_<id>; a read of public.entity works and a write to public.entity through PluginDb is refused by the role, asserted against a real database
- [ ] A plugin schema may declare an FK to public.entity(id); a test asserts no FK exists in any public.* table pointing into a plugin schema
- [ ] Dropping a plugin schema (DROP SCHEMA plugin_<id> CASCADE) is wired to uninstall's drop-data option; without it the schema survives and reinstalling finds its data and journal intact
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Enable the fixture and inspect psql: plugin_<id> tables exist with their own journal, and rebooting re-runs nothing. Enable a fixture whose migration touches public and watch it degrade with public untouched and the statement in last_error.

**Spec** — docs/spec-plugin-sdk.md §8 (plugin schemas); docs/spec-plugin-sdk.md §7 step 5; docs/spec-plugin-sdk.md §14 step 6

#### `sdk-24b` · afk · M — plugins/rss — the first real PluginDb tenant, and the first poller

**Blocked by:** `sdk-20b`, `sdk-24a`, `sdk-7b`

**What to build**

PluginDb without a real plugin is a feature with a fixture for a customer, and the spec sequences it behind 'the first plugin that needs tables (RSS)'. This is that plugin: a poller declaring a schedule, storing seen-item ids in plugin_rss.feed_item so a re-poll does not re-emit, and emitting content claims through the signal lane. It is also the first non-enricher kind to run for real, which is what proves the kind-to-ports table means something outside a test: a poller has no Facts and no Identity, so an RSS item becomes a signal on an entity resolved by the feed's configured record, never a new company. Feeds are configured through manifest settings, so the Integrations page renders them with no special-casing. Fixture feeds are committed XML served from disk; no network in CI.

**Acceptance criteria**

- [ ] plugins/rss builds to bundle.mjs plus manifest.json plus migrations, imports @spaces/sdk only, and declares kind poller with a schedule
- [ ] Its migrations create plugin_rss.feed_item on first load; polling the same fixture feed twice emits signals once, asserted by row count
- [ ] Signals land on the entity named in the feed's settings with source naming the integration; no entity is created by the poll, asserted by an entity-count assertion around the run
- [ ] The job reads and writes only through PluginDb, Http, Content, Config and Log; a build-time or runtime assertion shows Facts and Identity are absent
- [ ] Feeds are configured through manifest settings and render on the Integrations page with no rss-specific code in web
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Install rss, point it at a committed fixture feed and a company record, let the schedule fire: signals appear on that record's timeline. Fire it again: no duplicates, and plugin_rss.feed_item shows why.

**Spec** — docs/spec-plugin-sdk.md §5 (poller); docs/spec-plugin-sdk.md §14 step 6; CONTEXT.md — Plugin architecture

### ▸ A plugin passes or does not ship

_Provider fakes and the chaos suite: with no API keys anywhere and the network off, SPACES_FAKE_PROVIDERS=1 gives a clickable Enrich with plausible data, and the chaos suite runs green._

#### `sdk-25` · afk · M — Provider fakes and the chaos suite — a plugin passes or does not ship

**Blocked by:** `mono-4`, `mono-5`, `sdk-15`, `sdk-23`

**What to build**

Most of the testing value never touches a provider. Two pieces: in-repo fakes behind SPACES_FAKE_PROVIDERS=1 (recorded cassettes for stateless APIs like Apollo; a small mutable fake for anything with state), which double as the demo environment — a working Apollo with no key; and the chaos list from the spec run against them, which is the part that finds real bugs: 429 with Retry-After, credential revoked mid-run, half a batch failing, webhook delivered twice. A shared conformance file per port is parameterised over implementations so a second enricher is one array entry rather than a new test file — with one implementation each today, that is scaffolding, not coverage, and the slice should not pretend otherwise. The pipeline half writes rows, so it needs the isolated test database rather than the shared dev one.

**Acceptance criteria**

- [ ] SPACES_FAKE_PROVIDERS=1 pnpm dev gives a working Apollo enrich with no key configured, and the fake is unreachable when the flag is unset
- [ ] One conformance file per implemented port, parameterised over an array of implementations, currently one each; adding a second enricher means adding an array entry
- [ ] The chaos cases pass against the fakes: 429 with Retry-After honoured, a mid-run revoked credential failing typed rather than hanging, half a failing batch leaving the successful half written, a webhook delivered twice producing one set of claims
- [ ] The whole suite runs with no network access, asserted in CI by running it with outbound requests blocked
- [ ] The suite runs against an isolated test database rather than the dev database and leaves it clean
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With no API keys anywhere and the network off, SPACES_FAKE_PROVIDERS=1 pnpm dev lets you click Enrich and get plausible data; pnpm test runs the chaos suite green.

**Spec** — docs/spec-plugin-sdk.md §13; CONTEXT.md — Plugin architecture (testing)

---

## 20. Storage sources — connect an account, attach a file

_Extensibility · 11 slices_

The provider registry, the consent dance split at the redirect boundary, token custody, the StorageSource read port with its fake and chaos list, the Drive plugin's read side, and attach-from-Drive. Needs the TLS overlay from project 1: Google and Box reject non-localhost http redirect URIs, so the dance cannot be proven without a real https origin.

### ▸ Connect an account

_Register the Google app once without clobbering an existing Gemini key (credential.kind opened in project 3), click Connect and land on Google's own consent screen listing exactly the scopes asked for at the redirect URI Settings printed, then watch one encrypted grant row appear with its scopes and expiries. Scopes grow without a second account row, tokens refresh once under a cross-process lock so a rotating refresh token is never spent twice, and a revoked grant shows the provider's own reason._

#### `storage-1` · hitl · M — Provider registry — one OAuth app per provider, in the vault

**Blocked by:** none

**What to build**

The operator half of a provider. A code-level PROVIDERS registry (google, box) carrying authorize/token/revoke/userinfo URLs and the scope vocabulary, a credential_kind 'oauth_client' row holding client id (meta) + client secret (encrypted, AAD stays scope:provider so existing rows still decrypt), and an admin-only Settings → Providers section showing configured/not, the redirect URI derived from APP_URL, and a write-only secret field using redact(). Two code facts force work the draft missed: credential's unique index is (scope, provider, user_id) and storeCredential's onConflictDoUpdate targets exactly those three columns, so saving a Google oauth_client would silently overwrite a Gemini llm key on provider 'google' — index and conflict target must gain kind. CredentialInput['kind'] is a closed union and must widen. The scope vocabulary records the decision: drive.file for the picker, drive.readonly for folder bindings, requested incrementally.

**Acceptance criteria**

- [ ] pnpm db:generate --name oauth_client_credential produces ALTER TYPE credential_kind ADD VALUE 'oauth_client' plus the rebuilt unique index credential_user_unique on (scope, provider, kind, user_id); SQL hand-inspected and committed
- [ ] the ADD VALUE statement sits in its own migration file ahead of anything that USES the value — Postgres allows the statement in a transaction but forbids using the new label in that same transaction; pnpm db:migrate:run is clean against the dev DB
- [ ] storeCredential's onConflictDoUpdate target includes kind, and a test stores an llm credential and an oauth_client credential for provider 'google' and reads both back unchanged (today the second overwrites the first)
- [ ] PROVIDERS exports google and box with authUrl, tokenUrl, revokeUrl, userinfoUrl and scopes[] (value + label + which plugin needs it + whether the provider treats it as restricted); a unit test asserts every scope any shipped manifest requests appears in its provider's vocabulary
- [ ] setProviderApp / getProviderApps are requireAdmin()-gated — a member calling either gets 'Admins only'
- [ ] the redirect URI rendered is exactly <APP_URL without trailing slash>/api/connections/<provider>/callback; changing APP_URL in .env.local changes the displayed value with no code edit
- [ ] getProviderApps returns { provider, configured, clientId, secretDisplay } with secretDisplay from redact(); a test asserts the plaintext client secret appears in no server-fn response
- [ ] docs record the Google Internal-vs-Testing consequence (CONTEXT 'Email / calendar ingestion') and the Box enterprise-SSO admin consent requirement next to the redirect-URI instructions
- [ ] Gate 5 on the new settings section: text-graphite / border-rule / bg-bone / text-label / rounded-md only
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Providers shows Google as 'not configured' and prints its redirect URI; paste a client id/secret from a throwaway Google Cloud project and the row flips to 'configured', with the secret shown only as a redacted tail after reload. A pre-existing Gemini key on provider 'google' is still readable afterwards.

**Spec** — docs/spec-storage-sources.md §1; docs/spec-plugin-sdk.md §12; CONTEXT.md — BYOK — one framework, all providers; src/db/schema/vault.ts — credential_user_unique; src/lib/vault/index.ts — storeCredential

#### `storage-2a` · hitl · M — The outbound leg — PKCE, a signed state, and the provider's own screen

**Blocked by:** `storage-1`

**What to build**

The half of the dance that happens before the browser leaves, and the custody decision the rest of the area inherits. One file route /api/connections/$provider/start builds the authorize URL from storage-1's PROVIDERS registry: PKCE S256 (fresh verifier, challenge sent), the requested scopes, the redirect URI derived from APP_URL, and a state signed off the master key through the existing vault crypto, binding the session user, the requested scopes and a return path, with a ten-minute life. The open call this slice makes and records: where the code_verifier lives between the two legs — inside the signed state, an httpOnly cookie, or a short-lived row — which storage-2a2, storage-2b and every later provider then take as given. Settings → Providers (storage-1's section) gains the Connect control, which is the other reason a human looks: a new control in a shipped section, judged against DESIGN.md, gate 5 applying. Connecting a provider with no oauth_client row is a typed ProviderUnconfigured naming Settings → Providers, never a blank redirect to a half-built URL. An in-repo fake IdP (a node http server the test starts; no container, so the suite stays network-free) lands here with its authorize endpoint; storage-2a2 grows its token and userinfo endpoints. better-auth is not touched — a data grant is never a login.

**Acceptance criteria**

- [ ] /api/connections/$provider/start lands under src/routes/api/connections/ following the createFileRoute + server.handlers pattern in src/routes/api/blob/$key.ts, and pnpm generate-routes is re-run and committed
- [ ] the authorize URL carries code_challenge_method=S256 with a challenge derived from a fresh verifier, exactly the scopes asked for, and the redirect URI <APP_URL without trailing slash>/api/connections/<provider>/callback — asserted against the fake IdP's recorded authorize request
- [ ] state is signed off the master key and carries the session user, the requested scopes and the return path; a sign/verify unit round trip covers the happy path, a tampered payload, a state past its ten-minute life and one issued to a different user — this is the verifier storage-2a2's callback consumes
- [ ] the code_verifier's custody between the two legs is decided, implemented once and recorded in docs/spec-storage-sources.md §1, so no later provider re-decides it
- [ ] connecting when the provider has no oauth_client row returns ProviderUnconfigured with a message naming Settings → Providers, never a blank redirect
- [ ] the start leg is Effect-first v4 with typed failures (ProviderUnconfigured); the route handler runs it through effectFn() and no Effect type reaches React
- [ ] better-auth stays emailAndPassword-only — the diff adds no socialProviders entry, asserted by a grep test; a data grant is never a login
- [ ] Gate 5 on the Connect control: text-graphite / border-rule / bg-bone / text-label / rounded-md only
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Settings → Providers shows Google configured; click Connect and land on Google's own consent screen listing exactly the scopes asked for, at the redirect URI Settings printed. Delete the oauth_client row and the same click returns ProviderUnconfigured naming Settings → Providers. Against the fake IdP, the recorded authorize request shows the S256 challenge and the signed state.

**Spec** — docs/spec-storage-sources.md §1; docs/spec-plugin-sdk.md §12; CONTEXT.md — Email / calendar ingestion; src/lib/vault/crypto.ts — master key, AAD; src/routes/api/blob/$key.ts — file-route pattern

#### `storage-2a2` · afk · M — The grant row — code exchange, provider identity, one encrypted bundle

**Blocked by:** `storage-2a`

**What to build**

The inbound half: what the provider hands back becomes one encrypted row. /api/connections/$provider/callback verifies the state storage-2a signed (tamper, age, session user), exchanges the code with the client credential from storage-1 sending the code_verifier, reads the provider account identity from the registry's userinfo URL, and upserts account_connection. The table exists with userId/provider/externalEmail/tokensEnc/status and nothing writes it; it gains scopes text[], expires_at, external_account_id and refresh_token_expires_at (Box grants lapse after 60 days; a Google Testing-mode refresh token dies in 7). Token bundles encrypt through new vault helpers with AAD connection:<userId>:<provider> — src/lib/vault/index.ts has credential helpers only and its AAD is scope:provider, so these are new functions over the existing encryptSecret/decryptSecret, never a second crypto. The fake IdP grows its token and userinfo endpoints, including the mode that rejects an exchange carrying no code_verifier. Nothing here is a judgement call: storage-2a pinned the state format and verifier custody, storage-1 pinned the registry and the redirect URI, the existing unique index pins the conflict target — so it merges unattended.

**Acceptance criteria**

- [ ] migration adds scopes text[] not null default '{}', expires_at timestamptz, refresh_token_expires_at timestamptz, external_account_id text; the existing (user_id, provider, external_email) unique index is untouched; SQL hand-inspected
- [ ] /api/connections/$provider/callback lands beside the start route under src/routes/api/connections/, same createFileRoute + server.handlers pattern, and pnpm generate-routes is re-run and committed
- [ ] a callback with a tampered state, a state older than 10 minutes, or a state issued to a different session user returns 400 and writes no row (three tests)
- [ ] the token exchange sends code_verifier; the fake IdP rejects the exchange when it is omitted and the test asserts that path
- [ ] a token bundle decrypted with AAD connection:<another user>:google fails the GCM auth tag rather than returning plaintext
- [ ] a successful callback upserts exactly one account_connection row carrying scopes, expires_at, refresh_token_expires_at and external_account_id, then redirects to the return path the state carried
- [ ] the return leg is Effect-first v4 with typed failures (StateInvalid, ExchangeFailed); the route handler runs it through effectFn() and no Effect type reaches React
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the fake IdP running in a scratch env, click Connect on Google, approve, then `select provider, scopes, expires_at, external_account_id from account_connection` shows one row; repeat against a real Google project in dev for the same result.

**Spec** — docs/spec-storage-sources.md §1; docs/spec-plugin-sdk.md §12; CONTEXT.md — Email / calendar ingestion; src/db/schema/vault.ts — accountConnection; src/lib/vault/index.ts

#### `storage-2b` · afk · S — Incremental scopes — consenting to Drive never re-grants Calendar

**Blocked by:** `storage-2a`

**What to build**

Scope growth on an existing connection, the mechanism the picker and folder bindings both need. The start route accepts an added scope set; when a connection already exists for (user, provider) the authorize URL carries include_granted_scopes and the callback unions the granted scopes onto the row rather than replacing them. The scope check the rest of the area calls — hasScopes(connectionId, scopes[]) — lands here and answers 'connected but needs more', which is how the picker asks for drive.file and a folder binding later asks for drive.readonly without a second account row. Fully pinned by spec-plugin-sdk §12 ('scopes[] grow incrementally; connecting Calendar never grants Gmail'), so nothing is left to judgement: afk.

**Acceptance criteria**

- [ ] consenting to drive.readonly on a connection already holding calendar.readonly leaves exactly one row whose scopes is the union of both, and the refresh token is replaced with the newly issued one
- [ ] hasScopes returns 'missing' listing exactly the scopes not yet granted, and the start route round-trips the caller back to the return path encoded in the state
- [ ] a provider that returns fewer scopes than asked (user unticked one) stores what was actually granted, never what was requested — asserted against the fake IdP's partial-grant mode
- [ ] re-consent never creates a second account_connection row for the same (user, provider, external_email)
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect Google with calendar.readonly against the fake IdP, then hit the start route asking for drive.file: one row comes back with both scopes and a fresh refresh token.

**Spec** — docs/spec-plugin-sdk.md §12; docs/spec-storage-sources.md §1

#### `storage-3a` · afk · M — Token custody — refresh under a row lock, revoke, one accessor

**Blocked by:** `storage-2a`

**What to build**

accessTokenFor(connectionId) is the one accessor every job uses: it decrypts, refreshes when expires_at is inside 60 seconds, writes the new bundle back, and marks the row error when the provider says the grant is gone. The draft's in-process single-flight is not enough — web and worker are separate processes, and Box rotates its refresh token on every use (Google does under some flows), so two processes refreshing concurrently permanently break the connection. The refresh takes a pg advisory lock keyed on the connection id (or SELECT … FOR UPDATE on the row) and re-reads before deciding, so the loser of the race picks up the winner's bundle instead of spending a dead refresh token. revokeConnection posts the registry's revoke URL. This is the function the SDK's Secrets.accessToken() will delegate to, so no plugin ever holds a refresh token or a client secret.

**Acceptance criteria**

- [ ] a connection whose expires_at is in the past is refreshed on first use and the new bundle persisted; ten concurrent accessTokenFor calls across two db clients produce exactly one token request against the fake IdP and one surviving refresh token
- [ ] a refresh the IdP answers invalid_grant sets status 'error', stores the provider reason, and leaves the row and its scopes in place
- [ ] revokeConnection posts the revoke URL and reports success; a revoke answering 4xx is logged and reported as already-revoked rather than thrown
- [ ] the accessor is Effect-first with typed failures (AuthExpired, ProviderUnavailable) and never returns a token for a connection whose status is error
- [ ] the accessor takes no user and is worker-callable; its one server-fn caller asserts ownership, tested
- [ ] the DB-touching tests follow the existing describe.skipIf(!hasDb) pattern from src/lib/entities/resolve.test.ts with unique names per run and cleanup in afterAll
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect against the fake IdP, push expires_at back an hour with SQL, then run the two-client concurrent test: one refresh lands at the fake, one bundle is persisted, and `select expires_at from account_connection` has moved forward.

**Spec** — docs/spec-plugin-sdk.md §12; docs/spec-storage-sources.md §5.5; docs/spec-storage-sources.md §8

#### `storage-3b` · hitl · M — Settings → Connections — whose account, which scopes, disconnect

**Blocked by:** `storage-2b`, `storage-3a`

**What to build**

The per-user surface. Settings → Connections lists this user's account_connection rows (provider, account email, granted scopes, status with the stored provider reason, last sync) with Connect and Disconnect, reusing the SettingsSection pattern the route already defines. Disconnect calls storage-3a's revoke before deleting the row. One schema honesty note the draft missed: account_connection carries last_sync_at only, so the column shown is 'last sync', not 'last used' — no new column is invented for a number nothing writes yet. Connect routes into the storage-2a start route with the provider's base scope set; a provider with no oauth_client row renders 'Ask an admin to configure Google' rather than a dead button. hitl: a new settings surface whose status and scope chips must be judged against DESIGN.md.

**Acceptance criteria**

- [ ] a member sees only their own connections — another user's rows never load through the server fn (test)
- [ ] Disconnect revokes then deletes; a revoke answering 4xx still deletes locally and logs, so a provider that already forgot the grant cannot strand the row
- [ ] a connection in status error renders the stored provider reason inline, not a generic failure
- [ ] a provider with no oauth_client row renders the not-configured state, and an admin viewing it gets a link to Settings → Providers
- [ ] Gate 5 on the new section: text-graphite / border-rule / bg-bone / text-label / rounded-md only, no v1 tokens
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect Google against the fake IdP from Settings → Connections; the row shows the account email and both granted scopes. Revoke at the IdP, force a refresh, and the row turns error with the provider's reason; Disconnect removes it.

**Spec** — docs/spec-storage-sources.md §12; docs/spec-plugin-sdk.md §12; src/routes/_app/settings.tsx — SettingsSection

### ▸ The port and its fake

_A read conformance suite green against an in-process fake Drive, plus the chaos list — 429, vanished files, expired cursors, a 200 MB scan — with the assertions proven real by flipping the fake's toggles. The reason Box later is one array entry rather than a project._

#### `storage-4a` · afk · M — The StorageSource read port — a fake Drive and its conformance suite

**Blocked by:** `mono-7`, `sdk-3`

**What to build**

The read half of the storage-source kind in the SDK — resolveLink, listFolder(folderId, cursor?), getFile(fileId), changes(cursor), pickerConfig() — with typed failures (NotFound, CursorExpired, RateLimited, AuthExpired) rather than thrown errors, plus an in-repo fake Drive over a seeded, mutable data-room tree, plus the happy-path conformance suite the SDK testing kit exports. One method the draft omitted that two later slices cannot be built without: getFolder(folderId) → { id, name, parents[] }. The binding nesting guard and change-subtree filtering both need ancestry, and neither listFolder nor resolveLink returns a parent. Bytes are hashed by us on arrival; no provider hash is ever trusted across providers. SPACES_FAKE_PROVIDERS=1 points the registry at the fake, making it the dev and demo environment.

**Acceptance criteria**

- [ ] listFolder paginated at a page size of 2 returns every seeded entry exactly once across cursors — the suite asserts no duplicate and no omission
- [ ] getFile on the seeded native Doc yields exported bytes plus a mime, and the suite hashes those bytes itself; a provider-supplied hash is never reported as ours
- [ ] getFolder returns the ancestor chain up to the drive root, asserted against the seeded tree
- [ ] pickerConfig returns a serialisable shape with no secret in it — a test asserts no client secret or refresh token is reachable from the value
- [ ] the suite runs green under pnpm vitest run with no network and no Postgres, so it does not inherit the test-db harness debt
- [ ] the SDK kind registration grants a storage-source plugin no Facts and no Ai port, cross-checked against the sdk area's port-grant table
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — pnpm vitest run prints the read conformance suite green against the in-process fake Drive; deleting a seeded entry from the fixture makes the suite fail loudly rather than skip.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-plugin-sdk.md §5; docs/spec-plugin-sdk.md §13

#### `storage-4b` · afk · S — The chaos list — 429, vanished files, expired cursors, a 200 MB scan

**Blocked by:** `storage-4a`

**What to build**

The failure half of the port's proof, as fake toggles plus conformance cases, so every provider plugin is measured against the same bad days. §13's chaos list, each an explicit typed failure rather than a rejected promise: a 429 with Retry-After surfacing RateLimited carrying the hint, a file deleted between list and get surfacing NotFound, a cursor the fake has forgotten surfacing CursorExpired, half a batch failing without losing the good half, the same change page delivered twice, and a 200 MB file streamed rather than buffered. Kept out of storage-4a so plugin work can start against a green happy path and so the error taxonomy lands as one reviewable diff rather than scattered edge cases.

**Acceptance criteria**

- [ ] a seeded 429 with Retry-After: 1 surfaces RateLimited carrying the retry hint, and the suite asserts the caller can honour it
- [ ] a file deleted between list and get surfaces NotFound as a typed failure, not a rejected promise
- [ ] a cursor the fake has evicted surfaces CursorExpired, not a generic error
- [ ] a 200 MB seeded file is read through getFile without the suite's peak RSS exceeding a stated bound — the stream is never buffered whole
- [ ] a page of changes replayed verbatim produces the same typed result both times (the idempotency the poll leans on)
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — pnpm vitest run shows the chaos cases green against the fake; flipping the fake's rate-limit toggle off makes the RateLimited case fail, proving the assertion is real.

**Spec** — docs/spec-plugin-sdk.md §13; docs/spec-storage-sources.md §13

### ▸ A file arrives from Drive

_Paste a Drive URL or open the picker on a record: the file streams through the one intake module into our blob, is extracted, is searchable in Cmd-K, shows the folder path it came from and opens back in Drive — with the gone state and the Open-in-source action decided here, by the slice that first produces one._

#### `storage-5` · afk · M — Google Drive plugin, read side — a bytes pipe with hints

**Blocked by:** `sdk-1`, `sdk-11`, `storage-3a`, `storage-4a`

**What to build**

plugins/google-drive implementing the read port against the real API and nothing else: resolveLink for /file/d/<id>, /drive/folders/<id>, /open?id=, and the editor forms /document/d/, /spreadsheets/d/, /presentation/d/ that people actually paste, including shared drives; listFolder over files.list with pageToken, supportsAllDrives and includeItemsFromAllDrives; getFolder over files.get(fields=parents); getFile exporting native Docs/Sheets/Slides to docx/xlsx/pdf and streaming everything else; changes over changes.list from a start page token, with driveId set for a shared drive and omitted for My Drive. One correction to the draft's hedge: a Docs export is not byte-stable — the docx zip carries timestamps, so re-exporting an unchanged Doc yields a different sha. The plugin reports the provider's version/modifiedTime as the change identity and never asks core to treat a new export sha as a new revision.

**Acceptance criteria**

- [ ] the storage-4a and storage-4b conformance suites pass against the plugin pointed at the fake
- [ ] resolveLink handles all six URL forms and returns null rather than a guess for a Dropbox or arbitrary URL (table-driven test)
- [ ] a Google Doc comes back as docx with a sha computed from the exported bytes, and the entry carries the provider's version/modifiedTime as changeToken — a test exports the same unchanged Doc twice, asserts the shas differ and the changeToken does not
- [ ] changes.list for a shared drive sends driveId + includeItemsFromAllDrives + supportsAllDrives; for My Drive it sends neither driveId nor a widening corpora, asserted on the recorded request
- [ ] a 410 from changes.list surfaces CursorExpired
- [ ] the plugin's import graph resolves to @spaces/sdk only — the no-restricted-imports rule fails the build if it reaches for core or db
- [ ] a real-sandbox run exists as an opt-in nightly script the plugin ships; wiring it into CI belongs to the mono area and is not in this diff
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With a real Drive connected in dev, enqueue the plugin's list job on a data-room folder id and watch it log the entries with paths; the same job under SPACES_FAKE_PROVIDERS=1 lists the seeded tree.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-plugin-sdk.md §4; docs/spec-plugin-sdk.md §7

#### `storage-6b` · hitl · M — Arrival from a link — paste a Drive URL, get the file and its path

**Blocked by:** `clean-2a`, `storage-3a`, `storage-5`, `storage-6a1`

**What to build**

The first Drive byte to land, on the path storage-6a built. attachFromLink({ url, attachTo }) resolves a pasted Drive URL through the enabled storage-source integration, fetches as a worker job (a plugin invocation is always a job, spec-plugin-sdk §11), and files the result with external_id, external_url, connection_id and source_path. The Files tab accepts a pasted URL in its drop box, and rows gain 'Open in Drive' plus their verbatim source path. hitl: a pasted-URL affordance inside an existing drop box and a new provenance line on the row are both new visual language to judge against DESIGN.md, and the pending state of a fetch that takes seconds is not the pending state of a browser upload.

**Acceptance criteria**

- [ ] pasting the same Drive link twice on the same record returns the existing document and performs no second download — asserted as exactly one getFile call
- [ ] a link the user's connection cannot read surfaces the provider's reason on the row, not a blank failure; a link for a provider with no connection offers Connect
- [ ] a Drive file larger than MAX_UPLOAD_BYTES is refused before the blob is written, using storage-6a's streaming guard
- [ ] the row renders 'from Data room / Legal' and offers 'Open in Drive' only when external_url is set
- [ ] Cmd-K finds a phrase from inside the arrived PDF once extraction completes
- [ ] Gate 5 on record-files.tsx and any new component
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Paste a Drive file URL into a deal's Files tab: the row appears with its Drive path, extraction completes, Cmd-K finds a phrase from inside the PDF, and 'Open in Drive' opens the original.

**Spec** — docs/spec-storage-sources.md §3.1; docs/spec-storage-sources.md §7; docs/spec-storage-sources.md §12

#### `storage-7` · hitl · M — The provider picker — attach from Drive without leaving the record

**Blocked by:** `storage-2b`, `storage-6b`

**What to build**

pickerConfig() rendered by a generic picker host in web: the config names the script URL, the app id and the scopes; web loads the script at runtime and mints an access token for that call, so no provider SDK is bundled and apps/web still imports zero plugin code. Picking n files enqueues n arrivals through the storage-6a path. The security detail the draft skipped: handing the browser a raw access token hands it every scope on that connection — a drive.readonly token in a browser is a whole-drive read credential for an hour. The picker therefore mints only from a connection whose granted scopes are the picker set (drive.file), asking for that scope through storage-2b when it is missing, and refuses rather than downgrading if the check fails. This is also why drive.file is the picker's scope and drive.readonly is requested later, at bind time.

**Acceptance criteria**

- [ ] the built web bundle contains no provider SDK — the picker script is fetched at runtime from pickerConfig(), asserted by grepping the build output
- [ ] the token minted for the picker carries only the picker scope set; a test stubbing a connection that holds drive.readonly plus more asserts the mint throws rather than handing the broader token to the browser
- [ ] the token is minted per call and is never written to localStorage or a logged query string
- [ ] picking three files produces three pending rows and three documents with distinct external_ids
- [ ] cancelling the picker creates no rows and leaves no pending state behind
- [ ] a user with no connection for that provider sees Connect, and one missing only drive.file sees a re-consent prompt rather than a dead button
- [ ] Gate 5 on the picker host and the Files-tab button
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — On a deal's Files tab, 'Attach from Drive' opens the picker (the fake picker under SPACES_FAKE_PROVIDERS=1); pick two decks and both file with their Drive paths visible on the rows.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §12

---

## 21. A bound data room

_Extensibility · 9 slices_

storage_binding, first sync, resolveItem's match-only filing, the change poll, revisions, and the change table split one row per failure mode — renames and moves, gone pointers, tombstones and the expired-cursor re-list.

### ▸ Bind a folder

_Link a Drive folder to a deal, company or space with overlap refused by name; the Files tab fills with 14 documents carrying their Drive paths, and re-running keeps the count at 14. Kind folders become kinds, company folders resolve through a match-only lookup that creates nothing, and a typo lands as a suggestion rather than as a company._

#### `storage-8a` · hitl · M — storage_binding — one folder, one owner node, guarded at bind time

**Blocked by:** `docsurf-1a`, `storage-4a`, `storage-7`

**What to build**

The table of §5.1 plus the guards and the surface that create it, without the sync. Create a binding from a record's Files tab or a space page: provider picker → folder → options (map_subfolders, retain, direction, sensitivity). The row stores ancestor_ids text[] captured from getFolder at bind time, because the nesting guard is otherwise unimplementable: nothing in listFolder or resolveLink says who a folder's parents are, and walking descendants to detect 'this is a parent of a bound folder' is unaffordable. Containment is then an id-prefix test in both directions. Also decided against the draft: uniqueness is (provider, folder_id) workspace-wide, not (connection_id, folder_id) — two users binding the same data room on their own connections is exactly the duplicate-document machine §5.6 refuses. document.binding_id lands in this migration so 'which binding produced this' survives a re-bind, leaving source_ref for integration.id per spec-plugin-sdk §8.

**Acceptance criteria**

- [ ] migration creates storage_binding with every §5.1 column plus ancestor_ids text[], a unique index on (provider, folder_id), and a unique index on (is_mirror_root) WHERE is_mirror_root so at most one mirror root exists in the singleton workspace; document.binding_id → storage_binding.id lands in the same migration; SQL hand-inspected
- [ ] ENTITY_REFS gains storage_binding.target with merge { kind: 'repoint' } and context null, the null carrying its comment; removing the entry makes entity-refs.test.ts fail naming the column, verified once by hand
- [ ] document.binding_id references storage_binding, not entity, so entity-refs.test.ts stays green without a second entry
- [ ] binding Ohmium/Data room while Ohmium is bound is refused with a message naming the existing binding and its target; binding a parent of a bound folder is refused the same way, both via ancestor_ids
- [ ] binding a folder already bound on another user's connection is refused with the existing binder named
- [ ] requesting drive.readonly happens at bind time through storage-2b when the connection holds only drive.file
- [ ] the Files tab and space page render the bound state with an empty 'never synced' line, and a binding can be deleted
- [ ] Gate 5 on the bind dialog and the Files-tab binding line
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — On a deal, 'Link a Drive folder', pick the seeded data room: a binding row appears with its options and 'never synced'. Try to bind its parent, and the refusal names the existing binding and its target.

**Spec** — docs/spec-storage-sources.md §5.1; docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §5.6; CLAUDE.md — ENTITY_REFS rule

#### `storage-8b` · afk · M — First sync — a bound data room fills the Files tab, twice with the same count

**Blocked by:** `storage-5`, `storage-6a1`, `storage-8a`

**What to build**

The walk that makes a binding mean something. A worker job walks listFolder from the bound folder and files every file through the storage-6a arrival path onto the bound target, with map_subfolders off as the default path (subfolder mapping is storage-9), recording external_id, external_status 'linked', source_path and binding_id. Re-running is idempotent on (binding_id, external_id), so a re-sync after a partial failure creates nothing twice. Status, last_synced_at and the provider's message on failure are written to the binding, and the Files tab's line fills in with 'Synced from Drive · 14 files · 2m ago'. Nothing about the look is new — storage-8a already placed the line — so this is mechanical and spec-pinned: afk.

**Acceptance criteria**

- [ ] a first sync of the seeded fake data room files every file on the bound deal with external_id, external_status 'linked', source_path and binding_id; re-running creates zero new rows
- [ ] a sync interrupted halfway and re-run completes the remainder and duplicates nothing (idempotent on (binding_id, external_id))
- [ ] a sync whose token has died sets status 'error' with the provider message, deletes nothing already copied, and increments the plugin's breaker rather than killing the worker
- [ ] an empty folder produces no documents and no error
- [ ] a file whose sha already exists on the target attaches rather than duplicating, reusing the arrival module's dedupe
- [ ] the queue name is core-owned (core.storage.sync) and the provider fetch inside it is the plugin's job, keeping the filing decision in core per §4
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Bind the seeded data room to a deal and run the sync: the Files tab fills with 14 documents carrying their Drive paths and the line reads 'Synced from Drive · 14 files · just now'. Run it again and the count stays 14.

**Spec** — docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §5.6; docs/spec-plugin-sdk.md §11

#### `storage-9` · afk · M — resolveItem — folder names are hints, never identity

**Blocked by:** `ai-5`, `ai-8a`, `clean-3`, `docsurf-1a`, `docsurf-2`, `storage-8b`

**What to build**

The mapping algorithm core owns, wired into the sync walk with `map_subfolders` on. A pure `resolveItem(item, parentTarget)` implements §5.3's six rows. Two corrections to §5.3 as written, both discovered against the code.

**1. `resolveEntity(company, {name})` cannot be called as the spec writes it.** `src/lib/entities/resolve.ts` always creates when no identity key matches — the fuzzy sweep runs _after_ the insert and writes `duplicate_candidate` rows — so calling it per folder would create a company for every folder, typos included. This slice adds the match-only seam the spec implies: `resolveEntity` gains `{ createIfMissing: false }` returning `{ action: 'attached' | 'fuzzy' | 'no_match', candidates }`, with the create path untouched. Deal matching under a company is exact-normalised only, never fuzzy — a fuzzy deal match misfiles silently. Because this changes `resolveEntity`'s signature it sits behind clean-3, which rewrites the same function's source branch, for the same reason objects-7 already does.

**2. `resolveItem` never calls the classify lane.** §5.3's file branch reads `kind: folder rule → else classify lane → else 'other'` and §5.4 makes the lane the dictionary's fallback. spec-ai-substrate §11 already settles the seam the other way — "Storage-source plugins never call `Ai`; they deliver bytes and core's `document.extracted` event fires core features" — and a `resolveItem` specified as pure and snapshot-tested cannot make a model call anyway. The kind ladder is therefore wholly deterministic at filing time: `guessKindFromFolder(folder.name) ?? guessDocumentKind(file.name) ?? 'other'`. §5.4's dictionary joins the already-shipping `guessDocumentKind` in `src/lib/documents/index.ts` — one vocabulary, one pure client-safe file, the module docsurf-2 already tests — rather than a second copy inside the sync walk. Whatever is still `other` after extraction is ai-14's classify suggestion, arriving in /inbox exactly as it does for a browser upload, with no coupling in either direction. Correct §5.3 and §5.4 in the same PR so the next reader does not rebuild the call.

**Acceptance criteria**

- [ ] a table-driven test covers all six rows of §5.3 against the seeded tree and snapshots the filing decisions, produced with no AI provider configured at all
- [ ] `resolveEntity` with `createIfMissing: false` inserts nothing on a fuzzy-only or no-match name — asserted by a row count before and after — and the existing `resolve.test.ts` stays green unchanged
- [ ] a folder named 'Ohium' (typo) under a bound space creates no company: the files stay on the space via `entity_space` and one suggestion carries the fuzzy candidate
- [ ] `guessKindFromFolder` lives beside `guessDocumentKind` in `src/lib/documents/index.ts`, stays pure and client-safe (no db, no server, no ai import), and matches whole names case-insensitively: 'Data Room', 'data room' and 'DATA ROOM' all map to `dd` while 'Ohmium Data Room' does not
- [ ] the ladder is folder, then filename, then `other`: `Documents/Ohmium Pitch Deck.pdf` under a bound deal lands as `deck` from its filename though its folder names no kind, and `Data room/notes.txt` lands as `dd` from its folder though its filename names nothing
- [ ] `resolveItem` and the sync walk import nothing under the ai namespace — a grep test in the shape of CLAUDE.md gate 5 asserts it
- [ ] §5.3's `→ else classify lane` and §5.4's 'Fallback: the `classify` lane on the first 2k chars' are edited in `docs/spec-storage-sources.md` to name the post-extraction suggestion instead, citing spec-ai-substrate §11
- [ ] the dictionary's vocabulary is `DOCUMENT_KINDS` with no special cases — docsurf-2 has already removed `memo`, so no exclusion branch is written here
- [ ] a folder under a company matching a deal name maps to that deal only on an exact normalised match; a near-miss falls through to the kind rules
- [ ] an empty folder creates no entity and no document
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With no AI provider configured at all, bind the seeded Research/Hydrogen folder to a space with `map_subfolders` on: files under Ohmium/ land on the existing Ohmium company, files under Ohium/ stay on the space with a suggestion, Ohmium/Data room/* arrive as kind `dd` from the folder, and Ohmium/Documents/Ohmium Deck.pdf arrives as kind `deck` from its filename.

**Spec** — docs/spec-storage-sources.md §5.3; docs/spec-storage-sources.md §5.4; docs/spec-ai-substrate.md §11 (storage sources never call Ai; the extraction event fires core features); CONTEXT.md — Entity resolution & merge; src/lib/entities/resolve.ts; src/lib/documents/index.ts (guessDocumentKind, the existing deterministic guesser)

### ▸ The change poll

_A cursor per drive and a filter per binding: new files inside the bound subtree arrive and files outside it do not, and edits become revisions keyed on the provider's revision id with the prior sha kept._

#### `storage-10a` · afk · M — The change poll — a cursor per drive, a filter per binding

**Blocked by:** `storage-4b`, `storage-8b`, `storage-9`

**What to build**

The scheduled delta loop, and the scoping decision the draft skipped. Drive's changes.list is per-drive, not per-folder: a per-binding cursor would poll the whole drive once per binding and still have to decide whether a changed file is inside the bound subtree. So the cursor lives on (connection, drive) and each poll fans the page out to the bindings it touches by walking the changed file's parents through getFolder against ancestor_ids, caching ancestry per poll. Cadence is pinned here rather than left open: one core scheduled job every 15 minutes via boss.schedule, a per-binding minimum interval, and no push channels — Drive webhooks need a publicly reachable APP_URL and expire weekly, which a self-hosted box behind a router cannot promise. This slice handles §8's first row only: a new file in a bound folder becomes a document through storage-9.

**Acceptance criteria**

- [ ] the cursor is persisted per (connection, drive) and a poll that fails mid-page leaves the old cursor, so no change is skipped and the replay is idempotent
- [ ] a new file dropped into the seeded bound folder appears as a document on the next poll with source_path and external_id; a new file outside every bound subtree produces nothing
- [ ] two bindings on the same drive share one changes.list pass — asserted as one request per poll against the fake, not two
- [ ] the ancestry walk is cached per poll: a page of ten changes in one folder issues one getFolder chain, not ten
- [ ] the schedule registers through boss.schedule at boot and is idempotent across worker restarts
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Add a file to the seeded fake data room, trigger the poll, and it appears on the bound deal's Files tab; add one outside the bound folder and nothing arrives.

**Spec** — docs/spec-storage-sources.md §8; docs/spec-storage-sources.md §5.1; docs/spec-plugin-sdk.md §11

#### `storage-10b` · afk · M — Modified files — the row advances, the prior sha becomes a revision

**Blocked by:** `storage-10a`

**What to build**

§8's modified row, end to end: new bytes → new blob → the document row advances to the new sha, the prior sha lands in document_revision(document_id, blob_sha, external_revision_id, at), the old blob is GC'd unless something still shares it, extraction re-runs. Two corrections to the draft. Revision identity is the provider's revision id, not our sha, because a Google Docs export is not byte-stable (storage-5) — keying on sha would churn a revision on every poll of an unchanged Doc. And the blob GC in deleteDocument counts document rows sharing a sha only; once revisions hold shas it must count document_revision too, or deleting a document silently deletes bytes another document's history points at. Loop prevention lives here: a change whose external_id matches something we exported is a no-op, so storage-14's exporter has nothing to unwind.

**Acceptance criteria**

- [ ] document_revision migration plus an ENTITY_REFS entry with merge { kind: 'none', why: 'document kind is not mergeable' } and context null, following the document_chunk.document precedent; SQL hand-inspected
- [ ] editing the seeded Sheet twice in the fake and polling once produces two revisions in order, one current sha, and one extraction re-run per advance
- [ ] polling an unchanged native Doc produces no revision even though a fresh export hashes differently — the regression test for the export-stability trap
- [ ] replaying the same change page produces one revision, not two — idempotent on (document_id, external_revision_id)
- [ ] deleteDocument's GC counts document and document_revision rows sharing the sha; a test deletes a document whose prior sha is still referenced by another document's revision and asserts the blob survives
- [ ] a change whose external_id matches a document we exported is a no-op (no revision, no re-extract)
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Change a file in the fake data room, run the poll, and the document row shows rev 2 with the new text in search while the revision list holds both shas; poll an untouched Doc and nothing moves.

**Spec** — docs/spec-storage-sources.md §8; docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §11

### ▸ The rest of the change table, one failure mode at a time

_A rename advances the path and a move across companies proposes rather than repoints; a provider-side delete and a file leaving the binding both mark the pointer gone with the same badge and propose nothing; an app-side delete leaves a tombstone and an expired cursor re-lists the whole bound subtree without resurrecting it — the two halves tested against each other, which is the only way either is proven._

#### `storage-11` · afk · M — Renames and moves — the path advances, a crossing move is a suggestion

**Blocked by:** `ai-5`, `objects-3`, `storage-10b`

**What to build**

§8's renamed/moved row, and the one case where a move is more than a path. The poll's change dispatcher learns that a file whose ancestry changed inside the bound subtree keeps its filing and only advances source_path — no re-file, no new document, no re-extraction. When the new ancestry crosses a different company or deal folder, resolveItem (storage-9) says the file now belongs somewhere else and the outcome is a re-file suggestion naming both targets, never a silent re-file: §5.6 is explicit and CONTEXT's doctrine is that machine writes are proposals a human accepts. Two rows of the table, one branch — the reason these two stay together while the other three behaviours leave.

**Acceptance criteria**

- [ ] one test per §8 row covered here — renamed inside the subtree, moved inside the subtree, moved across a company folder — each named after the row it covers, against the mutable fake
- [ ] renaming a file inside the bound subtree updates source_path and changes no edge, no document row and no extraction, asserted by a before/after edge snapshot
- [ ] moving deck.pdf from Ohmium/ to Ohium/ writes a suggestion naming both targets and changes no edge until it is accepted
- [ ] a move that stays under the same owner node updates source_path only and writes no suggestion — the regression test against a suggestion storm on a folder reorganisation
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — In the fake data room rename one file and move a second across company folders, then poll once: the first row's path advances in place, the second produces one suggestion in /inbox naming both companies, and the Files tab shows no re-filing until you accept it.

**Spec** — docs/spec-storage-sources.md §8; docs/spec-storage-sources.md §5.6; docs/spec-storage-sources.md §5.3

#### `storage-11b` · afk · S — Gone pointers — deleted at the provider, or moved out of the binding

**Blocked by:** `storage-11`

**What to build**

The two ways a pointer stops being a pointer, and the first real writer of docsurf-11's external_status — the column the audit flags as reachable only from psql until something populates it. A provider-side delete keeps ours: the blob and the document survive, external_status becomes 'gone', the Files row renders the stale-pointer state, and we never delete theirs. A move out of the bound subtree entirely is the case §8 does not cover, and it is decided here as the same outcome — external_status 'gone' with the copy kept — because the alternative is a file that silently stops tracking while its row still claims to be synced. Neither case proposes anything: there is no new home to offer, so this slice touches no suggestion path and needs neither ai-5 nor the inbox.

**Acceptance criteria**

- [ ] one test per §8 row covered here — deleted in Drive, and moved out of the bound subtree (the row §8 leaves undefined, decided here) — each named after the row it covers, against the mutable fake
- [ ] a provider-side delete leaves the blob and the document, sets external_status 'gone', and the Files row renders the stale-pointer state
- [ ] a move out of the bound subtree sets external_status 'gone' and stops tracking without deleting anything
- [ ] a gone row is never flipped back to linked by a later page mentioning the same external_id, and it stays searchable and previewable from our copy
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — In the fake data room delete one file and drag a second out of the bound folder, then poll once: both rows carry the gone badge on the Files tab, both still open and preview from our copy, and nothing was deleted at the provider.

**Spec** — docs/spec-storage-sources.md §8; docs/spec-storage-sources.md §5.5; docs/spec-storage-sources.md §11

#### `storage-11c` · afk · M — The resurrection guard — a tombstone on app-side delete, and a clean re-list

**Blocked by:** `storage-11b`

**What to build**

The gap the draft inherited from §6 and §8 contradicting each other: §6 says deleting in the app 'marks the pointer stale', §8 says it deletes ours — and deleting ours leaves nothing to mark, so the next poll re-imports the file as new. A storage_tombstone(binding_id, external_id, at) settles it: deleting in the app removes our row and writes a tombstone, the poll skips tombstoned ids, and re-binding the folder clears them so a deliberate re-bind is still the way back. The same guard is what makes cursor recovery honest: a Drive 410 re-lists the whole bound subtree, the loudest resurrection vector there is, so the re-list is idempotent on external_id and honours both tombstones and storage-11b's gone rows. Tombstone and re-list ship together because neither is proven without the other.

**Acceptance criteria**

- [ ] one test per §8 row covered here — deleted in app, and cursor expired (Drive 410) — each named after the row it covers, against the mutable fake
- [ ] deleting a synced document in the app leaves the provider file untouched and writes a tombstone; the next poll does not resurrect it — the regression test for the delete-then-reimport loop
- [ ] a forced 410 re-lists the subtree and creates zero duplicate documents
- [ ] the re-list honours tombstones and leaves storage-11b's gone rows gone — a full replay resurrects nothing
- [ ] re-binding the folder clears its tombstones and the next poll re-imports the deleted file as new — the deliberate way back
- [ ] storage_tombstone references storage_binding, not entity, so entity-refs.test.ts stays green; migration SQL hand-inspected
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Delete a synced document in the app, then expire the cursor and force a full re-list: the file does not come back, no other document is duplicated, and the gone rows stay gone. Unbind and re-bind the folder and the deleted file returns as new.

**Spec** — docs/spec-storage-sources.md §8; docs/spec-storage-sources.md §6; docs/spec-storage-sources.md §5.1

### ▸ Retain per binding

_retain: text makes a 40 GB data room searchable without holding its bytes — ./data/blobs grows by nothing while Cmd-K hits the contents and preview streams from the provider — with the policy stated for the derived layers and the import payload too, not only for blobs. Flip to full and watch the backfill fill the disk._

#### `storage-12` · hitl · M — Retain policy — full keeps the bytes, text keeps the meaning

**Blocked by:** `storage-8b`

**What to build**

retain on the binding becomes real, and the question the draft left dangling is closed inside the slice that needs it: document.bytes_state (stored | remote) records whether the sha is held, because blob_sha stays set either way and the preview route, the download server fn, the GC in deleteDocument and any future re-embed all need to tell held from discarded. full (the default) is today's behaviour. text derives everything — extraction, chunks, later embeddings — then discards the bytes, keeping the sha, the derived layers and the pointer; preview and download fetch live through the binder's connection, so losing Drive loses the preview and never the search. Flipping text → full enqueues a backfill. Boundary, so no second author re-decides it: storage-8a owns the binding-options dialog and already ships all four §5.1 options, so retain and sensitivity are two independent stored values this slice and storage-18 respectively make mean something — nothing here touches `entity.sensitive`, `chunk.sensitive` or the resolver. The one real interaction is worth naming in a comment: under retain 'text' the derived rows are the only local copy, so sensitivity still travels correctly (it lives on rows, not bytes), while the vision lane — which needs bytes — has nothing to rasterize and must refuse rather than re-fetch a sensitive file. hitl: the remote-preview and preview-unavailable states are new surfaces, and the GC query change is load-bearing enough to want eyes on it.

**Acceptance criteria**

- [ ] migration adds document.bytes_state with default 'stored' and backfills existing rows; SQL hand-inspected
- [ ] a binding with retain 'text' leaves no blob on disk after extraction (storage().exists(sha) is false) while extracted_text and the tsv are populated and Cmd-K finds the file
- [ ] the GC in deleteDocument never deletes a blob still referenced by a stored-state row or a revision, and never tries to delete one already remote
- [ ] a sha shared with a document from a full binding is never discarded by a text binding (test)
- [ ] opening the preview on a remote document fetches through the connection and renders; with the connection in error the preview says why rather than failing blank
- [ ] flipping to full enqueues one backfill job per document and afterwards every sha exists locally with bytes_state 'stored'
- [ ] no sensitivity column, stamp or resolver is touched: a comment in the binding options component names storage-18 as the owner of the sensitivity option's behaviour and this slice as the owner of retain's, so the shared dialog has one line per owner
- [ ] Gate 5 on the preview and the binding options
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Bind the seeded data room with retain: text and sync — ./data/blobs grows by nothing while Cmd-K hits the contents; open one and the preview streams from the fake; flip to full and watch the backfill fill the disk.

**Spec** — docs/spec-storage-sources.md §5.1; docs/spec-storage-sources.md §7; docs/spec-storage-sources.md §9; CONTEXT.md — Storage

---

## 22. Drive as the archive, Box on the same port

_Extensibility · 9 slices_

The write half of the port, write-through, the mirror root, live files proposing ledger events through the correction door, binding health, sensitivity riding the filing, and Box proved by a diff that shows no core file changed. Half of this is speculative until a real user asks — treat it as a backlog with an order.

### ▸ Write-through and the mirror root

_ensureFolder, putFile, move and rename pass the extended conformance suite including the concurrent case. An upload on a bound record lands in Drive too with no duplicate row on the poll that sees it, and a mirror root fills Drive with the Space/Company/Deal/Kind tree the fund would have built by hand — lazily, sanitised, no empty folders._

#### `storage-13` · afk · M — The write half of the port — ensureFolder, putFile, move, rename

**Blocked by:** `storage-4b`, `storage-5`

**What to build**

The port's write methods, the fake's write endpoints, and the conformance suite extended over them: ensureFolder(path) creating lazily and returning the same id for a path that already exists, putFile(folderId, name, stream) returning { fileId, revisionId }, move and rename. Collision policy belongs to the port, not its caller: the same name with the same sha becomes a provider revision, a different sha becomes a (2) suffix. The concurrency case the draft omitted and Drive punishes: Drive permits duplicate folder names, so two export jobs calling ensureFolder('Legal') at once create two Legal folders and the tree forks. ensureFolder must be safe under concurrency — create-then-resolve-to-the-lowest-id, or a lock keyed on (binding, path). google-drive implements them; nothing in core calls them yet, so storage-14 and storage-15 stay pure core work.

**Acceptance criteria**

- [ ] conformance: ensureFolder('A/B/C') twice yields one chain of folders and the same id both times
- [ ] conformance: four concurrent ensureFolder('A/B') calls yield exactly one B folder and one id — the duplicate-name trap
- [ ] putFile of identical bytes under an existing name produces a second revision of that file, not a second file
- [ ] putFile of different bytes under an existing name produces 'name (2).ext' and reports the name it used
- [ ] move and rename are idempotent — replaying the same call is a no-op, not an error
- [ ] putFile never converts an uploaded docx into a native Google Doc, asserted on the resulting mime
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — SPACES_FAKE_PROVIDERS=1 pnpm vitest run shows the extended conformance suite green for google-drive, including the concurrent ensureFolder case, and the fake's tree shows one lazily created chain.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-storage-sources.md §6; docs/spec-storage-sources.md §5.6

#### `storage-14` · afk · M — Write-through — an upload on a bound record lands in Drive too

**Blocked by:** `storage-10b`, `storage-11`, `storage-13`

**What to build**

Uploads on a record whose binding is push or both fan out: the blob is ours as always, then a core-owned export job calls ensureFolder on the binding's folder and putFile, recording external_id on the document. Loop prevention is the external_id match from storage-10b, so the next poll sees our own write and no-ops. Re-filing a document to another record moves it; renaming renames it; deleting in the app never deletes theirs and writes the storage-11 tombstone so the poll cannot re-import what we just removed. With no usable connection the export job queues and retries with backoff, and Today says '3 files waiting for a Drive connection' rather than dropping them. Scoped deliberately to in-app uploads: whether an email attachment or a URL clip also exports is the open ping-pong question, and this slice exports nothing it has not been told to.

**Acceptance criteria**

- [ ] uploading deck.pdf on a deal bound push produces the file in the bound folder and records external_id; the next changes poll creates no second document
- [ ] deleting that document in the app leaves the provider file intact and writes a tombstone, so no poll re-imports it
- [ ] with the connection revoked the export job stays queued with backoff and the waiting count is queryable; reconnecting drains it
- [ ] a record whose binding is pull-only exports nothing
- [ ] notes and memos never export; a memo's exported PDF, being a document, does
- [ ] only arrivals whose source_class is upload export — an integration arrival on a bound record does not, pending the ping-pong decision, and the test pins that
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Upload a deck on a deal bound both: it appears in the fake Drive folder within one poll, the poll that sees it creates no duplicate row, and deleting it in the app leaves the Drive file alone and does not bring it back.

**Spec** — docs/spec-storage-sources.md §6; docs/spec-storage-sources.md §8; docs/spec-plugin-sdk.md §11

#### `storage-15` · hitl · M — Mirror root — Drive fills itself with the tree you'd have built

**Blocked by:** `storage-14`

**What to build**

One workspace-level binding with is_mirror_root, and every upload anywhere projects to 'Space path / Company / Deal / Kind / filename' beneath it — no per-record binding at all. The projection is a pure function of the document's filing (the space's display names walked from its ltree path, the record it is tagged into, its kind); folders are created lazily on the first file so no empty sprawl appears; re-filing moves the file. The projection must sanitise: an entity named with a slash or a 200-character name cannot be a path segment, and two records with the same name at the same level need a deterministic tie-break or the mirror forks. Whose token: the uploader's connection for that provider, else the mirror owner's, else the job queues. Setting a mirror root is admin-only and exclusive by the index storage-8a created.

**Acceptance criteria**

- [ ] the projection is unit-tested from filing alone: a deck on a deal under the energy.hydrogen space lands at Energy/Hydrogen/Ohmium/Series B/Deck/ohmium-deck.pdf, using display names rather than ltree labels
- [ ] a name containing '/' or exceeding the provider's segment limit is sanitised deterministically, and two same-named records at the same level resolve to distinct, stable segments (test)
- [ ] an unfiled document lands in a single Unfiled/ folder, never at the root
- [ ] no folder is created for a company or deal until its first document exists — asserted against the fake's tree after creating a deal with no files
- [ ] re-filing a document from a company to a deal issues one move, not a delete plus a put
- [ ] an uploader with no Google connection exports under the mirror owner's connection; with neither, the job queues and the waiting count surfaces
- [ ] a second is_mirror_root is refused by the index
- [ ] Gate 5 on the mirror-root settings surface
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Set a fake-Drive folder as the mirror root, upload three files on three different records, and the fake's tree shows exactly the three projected paths and no empty folders.

**Spec** — docs/spec-storage-sources.md §6; docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §13

### ▸ Live files propose ledger events

_Follow a cap table and watch its revisions accumulate as an append-only ledger; change it in Drive and /inbox offers 'ownership moved 12.4% → 9.8%, propose a mark'. Accept and the holding's ledger gains one append-only row — through the same programs the import commit uses, so the append-only tables keep exactly one writer each._

#### `storage-16` · hitl · M — Live files — follow a Sheet, keep its revisions

**Blocked by:** `storage-10b`, `storage-8a`

**What to build**

The file-grain binding: 'Link and follow' on a Sheet, a shared Excel or any file creates a storage_binding with grain 'file' and direction 'pull'. Each provider revision advances the document and appends to document_revision — the machinery from storage-10b, triggered per file rather than per folder, and sharing the same (connection, drive) cursor so following ten files does not mean ten polls. The document's preview gains a revision ledger in the append-only pattern the portfolio surfaces already use: rows on rules, a mono timestamp lane, the provider revision id, the current revision marked, and no edit affordance anywhere. One direction only — editing happens where the editor is.

**Acceptance criteria**

- [ ] following a file that is already filed attaches the binding to the existing document rather than creating a second one
- [ ] three edits in the fake produce three revisions carrying the provider's revision ids and one current sha
- [ ] following ten files on one drive adds no additional changes.list passes per poll
- [ ] the ledger exposes no edit or delete control, matching the append-only event surfaces
- [ ] unfollowing stops polling and keeps every revision
- [ ] a followed file deleted at the provider marks the pointer gone and stops the binding without deleting our revisions
- [ ] Gate 5 on the revision ledger
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Follow the seeded Sheet from a holding's Files tab, edit it twice in the fake, and the document reads rev 3 with a two-row history beneath it.

**Spec** — docs/spec-storage-sources.md §5.2; docs/spec-storage-sources.md §10; docs/spec-storage-sources.md §13

#### `ai-22` · hitl · M — Live-file revisions propose ledger events — the append-only tables' one door

**Blocked by:** `ai-8a`, `storage-10b`

**What to build**

§11's cap_table row, real only once storage sources deliver revisions. A new revision of a bound cap table calls `complete('extract', schema = round/ownership)` and writes `suggestion(kind: ledger_event)` showing the diff against the current holding; accepting performs the append-only insert into `round` or `mark` through the existing portfolio write path (src/lib/server/portfolio.ts already inserts both) with the accepter as actor. CLAUDE.md is explicit that the portfolio event tables are append-only by design with no edit or delete path, and that the correction policy is an open decision — so this slice adds no mutation path, only a proposal path, and the suggestion queue is the only door. `accept()` gains its `ledger_event` branch.

**Acceptance criteria**

- [ ] A new revision of a bound cap table enqueues exactly one extract and produces one ledger_event suggestion
- [ ] The suggestion renders the diff against the current holding (before → proposed) rather than a bare number
- [ ] Accepting inserts exactly one row into `round` or `mark` with the accepter as actor and the suggestion id as provenance; nothing is updated or deleted, asserted by a test that counts rows before and after
- [ ] A proposal whose numbers fail the existing portfolio validators is refused at accept time with the validator's message, leaving the suggestion open
- [ ] Rejecting writes nothing to any portfolio table
- [ ] The diff view is reviewed against DESIGN.md; new .tsx passes gate 5
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Change a bound cap table in Drive; the revision arrives, /inbox shows "ownership moved 12.4% → 9.8%, propose a mark", accept, and the holding's ledger gains one append-only row.

**Spec** — docs/spec-ai-substrate.md §11; docs/spec-storage-sources.md; CLAUDE.md — append-only portfolio tables

### ▸ Safe hands

_A revoked token or a departed binder surfaces on Today and on Connections and can be re-bound by another user whose access is checked first, resuming with no duplicates. Sensitivity is decided at ingest and rides from the binding down to the chunk, into the local embedding slot that has been waiting for it since project 11._

#### `storage-17` · hitl · M — Binding health — the binder left, the token died

**Blocked by:** `storage-14`, `storage-3b`, `storage-8b`

**What to build**

The failure surfaces §5.5 promises, which today have nowhere to appear. Settings → Connections lists each connection's bindings with status, last sync and last error; Today carries binding errors and the waiting-export count as ledger rows; a paused or errored binding can be re-bound to another user's connection for the same provider, resuming with a full re-list rather than a stale cursor — the cursor belongs to (connection, drive), so it cannot survive the move. Re-binding validates first: the new connection must hold the required scopes and must actually be able to read the folder, because the folder may simply not be shared with that user, and a re-bind that silently starts failing is worse than a refusal. Disconnecting a connection that owns bindings warns with the count, pauses them, and never deletes copied documents.

**Acceptance criteria**

- [ ] revoking the connection at the provider turns every binding on it error at the next poll with the provider message stored, and touches no document
- [ ] 'Re-bind with my connection' calls getFolder on the new connection first and refuses with the provider's message when the folder is unreadable or a scope is missing
- [ ] a successful re-bind repoints connection_id, clears the cursor, sets status active, and the next sync creates zero duplicate documents
- [ ] Today shows one row per errored binding and one row for files waiting to export, and both disappear when resolved
- [ ] disconnecting a connection with bindings shows the count and, on confirm, pauses them rather than deleting anything
- [ ] Gate 5 on the Today rows and the bindings list
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Revoke the grant at the fake IdP: Today shows the binding error and Settings → Connections shows the reason; re-bind as a second user who can read the folder and the sync resumes with no duplicates, while a second user who cannot read it is refused by name.

**Spec** — docs/spec-storage-sources.md §5.5; docs/spec-storage-sources.md §7; docs/spec-storage-sources.md §12

#### `storage-18` · afk · M — The sensitivity stamp — one writer, raised in the transaction, lowered by a job

_Amended 2026-10-02: the half that needs no storage binding (raising on a record or space flag and on filing, lowering by a job) moved to `sensitivity-1` in Unplaced. What remains here is the binding input._

**Blocked by:** `ai-10b`, `ai-12a`, `ai-26`, `storage-8b`

**What to build**

The cache the resolver cannot be, and the one writer that keeps it honest. Retrieval filters chunks inside SQL 'before scoring' (§9), which cannot call a resolver per row, so `chunk.sensitive` — the column ai-12a created and nobody wrote — becomes real here. It is the only denormalized copy in the design: there is deliberately no `document.sensitive`, because `document`'s primary key IS `entity.id`, so a derived flag there would sit on the same row identity as the authored `entity.sensitive` and the two would be indistinguishable at a call site. One writer, `stampSensitivity(scope)`, and the staleness that normally kills a denormalized flag is disarmed by an asymmetry: **raising is synchronous, lowering is a job**. Flagging a space or a record, filing a record into a sensitive space, setting a binding sensitive, or flipping the workspace default each run one set-based UPDATE over the affected subtree inside the same transaction as the write, so a stamp is never stale in the leaking direction; clearing a flag enqueues a recompute, because false requires evaluating the whole OR and being late with that only over-protects. ai-10b's chunk writer is refactored onto the same function so the single-writer rule is real rather than aspirational. The consumer ships in the same slice: `assemble()` gains `excludeSensitive`, filtered in SQL and enforced by the existing ContextLeak invariant, set by the caller whenever the provider its lane resolves to is not local. That is a different guard from ai-26's: ai-26 stops a sensitive subject reaching a cloud model, this stops a non-sensitive subject carrying a neighbour's sensitive chunks into the same prompt. Binding options are storage-8a's surface and retain is storage-12's behaviour; nothing here adds UI.

**Acceptance criteria**

- [ ] `stampSensitivity` is the only function in `src/**` that writes `chunk.sensitive` — a grep-based test fails if a second writer appears, the pattern storage-6a used for document inserts — and ai-10b's chunk writer is refactored onto it in this slice
- [ ] No `document.sensitive` column is added; a comment names `document.entity_id = entity.id` as the reason and points at `sensitivityFor` for the per-document answer
- [ ] Raising is synchronous: flagging a space sensitive sets `sensitive` on every chunk of every document filed under it or under any descendant space, in one statement inside the same transaction as the toggle — tested over three ltree levels by reading chunk rows immediately after commit with no job having run
- [ ] The same synchronous raise covers the other four writes that can turn the answer sensitive: flagging a record, filing a record into a sensitive space, setting a binding sensitive, and flipping `workspace.settings.sensitivity_default`
- [ ] Lowering enqueues a recompute job: unflagging clears stamps only where nothing else keeps them — a document also filed under a second sensitive space keeps its stamps, one filed nowhere else loses them, both tested
- [ ] Agreement test over the seeded fixture: after both paths have run, every chunk's stamp equals `sensitivityFor` on its owner entity — the test that makes the cache checkable rather than trusted
- [ ] `assemble()` gains `excludeSensitive`: the chunk lane filters in SQL and the existing ContextLeak invariant gains a sensitive check, so a stale true cannot leave the assembler; with the option off the ai-1 snapshot is byte-identical
- [ ] The assembler's AI callers set `excludeSensitive` whenever the provider the lane resolves to is not local, tested with an injected route: a cloud-routed prompt about a non-sensitive company never carries a sensitive neighbour's chunk
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Flag the hydrogen space sensitive and watch every chunk beneath it flip on the click, no job run; assemble a company filed elsewhere that shares a deal's bound data room for a cloud-routed lane and watch those chunks drop out of the Context readout while the Ollama-routed assembly keeps them; unflag the space and watch the recompute clear the stamps.

**Spec** — docs/spec-storage-sources.md §9 — each chunk carries sensitive so retrieval filters before scoring; docs/spec-ai-substrate.md §7; docs/spec-ai-substrate.md §9; src/lib/context/assemble.ts — the chunk lane and the ContextLeak output invariant; src/lib/ai/sensitivity.ts — sensitivityFor (ai-26)

### ▸ A second provider, no core diff

_A Box-first fund gets the same connect, bind, filing and write-through — single-use refresh tokens and an eventless items API absorbed inside the plugin — and the proof is git diff --stat showing no core file changed._

#### `storage-19a` · afk · M — Box, read side — the same port, a second fake

**Blocked by:** `storage-11`, `storage-4b`

**What to build**

Box as a provider on the read half: the registry gains its authorize/token/revoke/userinfo URLs and scope vocabulary, plugins/box implements resolveLink, listFolder over folder/items, getFolder over path_collection, getFile with Box Notes export, and changes over the events stream, and a fake Box server backs the same read and chaos conformance suites. Two Box facts the plugin must encode: its refresh token is single-use and its grants lapse after 60 days of inactivity, which is precisely what storage-3a's row lock and refresh_token_expires_at exist for; and folder/items has no delta API, so changes falls back to the events stream with the same CursorExpired semantics. Split from the write half so a Box read path can be reviewed and merged before the no-core-diff claim is tested.

**Acceptance criteria**

- [ ] the read and chaos conformance suites pass against plugins/box on the fake Box
- [ ] connecting Box through the storage-2a dance stores a bundle whose refresh token rotates on every use, and two concurrent accessTokenFor calls still leave a working connection — the single-use trap, against the fake
- [ ] a Box Note exports to text and hashes to our own sha
- [ ] the events stream surfaces CursorExpired on a stale stream position, and the re-list path from storage-11 runs unchanged
- [ ] the plugin's import graph resolves to @spaces/sdk only
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the fake Box running, connect a Box account from Settings → Connections and run the read conformance suite green against plugins/box.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-storage-sources.md §13; docs/spec-plugin-sdk.md §13

#### `storage-19b` · afk · M — Box, bound and writing — the port measured by the diff

**Blocked by:** `storage-14`, `storage-19a`

**What to build**

The write half and the proof. plugins/box implements ensureFolder, putFile, move and rename against folders/files, the write conformance suite runs green on the fake Box, and a Box folder binds to a deal and files the same seeded documents through core's unchanged pipeline. The measure of the port is the changed-file list: core's resolveItem, the sync walk, the change poll and the exporter must not appear in it. Box's enterprise-SSO admin consent requirement is documented next to Google's Internal-versus-Testing note, because a Box-first fund discovers it at the worst moment otherwise.

**Acceptance criteria**

- [ ] the write conformance suite passes against plugins/box, including the concurrent ensureFolder case
- [ ] the PR's changed-file list touches only the provider registry, plugins/box, the fake, tests and docs — nothing under the sync walk, resolveItem, the change poll or the exporter
- [ ] binding a Box folder to a deal files the same seeded 14 documents with source_path, external_id and binding_id; re-running the sync changes the count by zero
- [ ] an upload on a Box-bound record with direction push lands in the bound folder and the next poll creates no duplicate
- [ ] docs state the Box enterprise-SSO admin consent requirement alongside the Google Internal/Testing limits
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the fake Box running, bind its data room to a second deal: the Files tab fills identically to Drive's with Box named where Drive was, and `git diff --stat` on the PR shows no core file.

**Spec** — docs/spec-storage-sources.md §4; docs/spec-storage-sources.md §6; docs/spec-storage-sources.md §13

---

## 23. Meetings and recorders

_Extensibility · 9 live slices and two struck · amended 2026-10-06, 2026-10-09 · split 2026-10-09_

_Split 2026-10-09: project 23 held four themes in one; its spaces, research and watch slices are now project 28 and its enrichment slices project 29. What stays is meetings: the interaction row learns D68's shape, Google Calendar syncs, recorders land (Granola first, D78), Today and the Meetings page show them, and Gmail syncs. Earlier amendments (D68, D78, D68 amended) are inline on each slice._

A meeting becomes one row that every source fills: the calendar event, the recorder's notes and transcript, the write-up. Placed after storage because each lane needs OAuth, the loader and the fakes.

### ▸ One meeting, one row

_Before any recorder lands, the interaction row learns what D68 needs: a per-kind `meta` jsonb, the artifact join with a `role` that replaces the planned `interaction.document_id`, the task `suggestion_kind`, and the writer's attach-or-create rule keyed on the calendar event. Then Today's Meetings section, the meeting dialog and Prep._

#### `interaction-1` · afk · M · migration — `interaction.meta`, the artifact join with `role`, the task suggestion kind — one migration (D68)

**Blocked by:** `arrival-2`, `notes-5`. **Label:** `migration` — runs alone on the migration lane.

**What to build**

Three schema changes D67 and D68 both lean on, in one migration so the journal takes one hit. `interaction` gains `meta` jsonb, `$type`d per kind through a discriminated union in `packages/db/src/schema/interactions.ts` and read through `@spaces/core/json`: the email shape is D67's headers (`from`, `to`, `cc`, `date`, and the MIME blob sha `email-1` fills); the meeting shape is `ends_at`, `status` (`scheduled` | `cancelled`), `conference_url`, `organizer`, `recurring_instance_id` and `rsvp` as a map from participant email to `accepted` | `declined` | `tentative` | `needs_action`; the call shape is `provider_event_id` and `duration_seconds`. A new table `interaction_document(interaction_id, document_id, role)` with `role` an enum `attachment` | `transcript` | `recording_link`, primary key on the pair, carries every artifact of an interaction — `arrival-6`'s planned `interaction.document_id` is never created, and its text is amended in this slice's PR to say so. `suggestion_kind` gains `task`, whose payload is `{title, due, entity_id}` and whose accept creates a task through the existing task writer, so action items from a recorder (`interaction-2`) and from Ask (`ask-6`) share one kind.

`ENTITY_REFS` gains `interaction_document.document` with an explicit merge strategy (`repoint`, the document is the entity side) and context role (`item`, hop 1 through the interaction's participants). Nothing reads `meta` yet beyond the writer's tests; the readers arrive with `arrival-5`'s rewrite, `email-1` and `arrival-11`.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name interaction_meta_artifacts`, SQL hand-inspected: `interaction.meta` jsonb nullable, `interaction_document` with its enum and pair primary key, `task` appended to `suggestion_kind`
- [ ] `interaction.meta` is `$type`d as a discriminated union keyed by `kind`; a reader in `@spaces/core/json` decodes it and refuses a meeting shape on an email row at the boundary
- [ ] `ENTITY_REFS` carries `interaction_document.document`; deleting the entry fails `entity-refs.test.ts` naming the column
- [ ] Merging two documents repoints `interaction_document` rows to the winner, asserted through the merge snapshot
- [ ] A `task` suggestion accepts into one task row with the accepter as creator and the suggestion closed; rejecting writes nothing
- [ ] `arrival-6`'s body in `docs/roadmap-backlog.md` and `docs/spec-storage-sources.md` §3.1 say the transcript edge is the artifact join, not a column, in the same PR
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Insert a meeting interaction with a cancelled status and two RSVPs through the writer's test, attach a transcript document with `role: transcript`, and read both back typed; merge the document into another and the join follows.

**Spec** — `docs/decisions-2026-09.md` D68 (events change, the row follows; one meeting, many artifacts; action items are task suggestions) and D67 (store the email; attachments are documents); `packages/db/src/entity-refs.ts`

#### `interaction-2` · afk · M — The writer attaches a recorder's payload to the calendar meeting, or births a `call` (D68)

**Blocked by:** `interaction-1`, `arrival-5`

_Amended 2026-10-09 (D78 amends D68): the per-integration `notesAreMine` switch and the `ai: true` manifest flag are dropped. Whether a recorder's note is shared is the member's folder choice (`arrival-6`), and what a note becomes — write-up, second note, task suggestions — is `arrival-7`'s; a provider summary is no longer a `note` suggestion. This slice keeps the match-or-birth rule, the artifacts and `Receipts`._

**What to build**

The one rule that makes "one meeting, one row" true, in the one writer every lane already calls: `packages/core/src/writes/interactions/write.ts`. `Content.logInteraction` gains optional match keys — `calendar_event_id`, `ical_uid`, else `starts_at` plus participant emails — and the writer decides. A key that matches an existing `meeting` row attaches: participants through the participants module are unioned onto `interaction_entity`, artifacts are added on `interaction_document` with their role, `meta` is merged, and no second row is born. A key that matches nothing births a `call` with the provider event id as `message_id`, so a webhook delivered twice is still one row through `interaction_message_id_unique`. The time-plus-participants fallback matches within a 30-minute window on `occurred_at` and requires every payload email to be among the meeting's participants; a looser match attaches a transcript to the wrong call, which is worse than a duplicate.

Two D68 lines land here too. A recording is an artifact `recording_link` pointing at a document whose blob is absent and whose `external_url` is the provider's — never copied. The raw payload goes to `Receipts`. The writer does not decide what a recorder's notes become: it returns the matched (or born) interaction id and `arrival-7` applies D78's landing rules.

**Acceptance criteria**

- [ ] `logInteraction` with an `ical_uid` that matches a synced meeting adds participants and artifacts to that row; `select count(*) from interaction` is unchanged
- [ ] The same payload with no match births one `call`; delivered twice, the second write conflicts on `message_id` and the job succeeds idempotently
- [ ] The time-and-participants fallback matches inside 30 minutes with every payload email present, and refuses when one is missing — both asserted
- [ ] A `recording_link` artifact creates a document row with no blob and an `external_url`; the Files tab lists it with the provider's mark and "Open in <provider>", and storage-6a's single-writer grep test still passes
- [ ] The writer writes no note and proposes no `note` suggestion for a payload's summary; it returns the interaction id for `arrival-7`
- [ ] Every payload is written to `Receipts` before any claim is applied
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Sync a calendar meeting, then post a recorder fixture naming its iCalUID: the meeting's row gains the transcript and the attendees' names resolve to the same people. Post one with no calendar match: a call appears instead. Replay both: nothing doubles.

**Spec** — D68 (recorders are plugins; the interaction writer decides); D78 (the folder is the share decision); `packages/core/src/writes/interactions/write.ts`; `packages/core/src/writes/ports/content.ts`

#### `arrival-11` · afk · M — Today's Meetings section with day navigation, the meeting dialog, and Prep on demand (D68)

**Blocked by:** `interaction-2`, `ai-15`

_Amended 2026-10-09 (D68 amended, D79, D80): the section is Today's Meetings section as D79 places it — one day with `‹ today ›` and a now-rule, **Prep** on upcoming rows — and its head gains **"all meetings ›"**, which opens the Meetings page (`arrival-12`). With no calendar connected the section is one line, "No calendar connected · Connect Google ›" (D80; a member sees who to ask instead of the link). Where the section sits among Today's parts is the Today slice's (project 27); this slice builds the section and the window._

**What to build**

The surface for meetings, on two sheets: **T1** (Surfaces › Today) for the section and **M2** (Surfaces › the meeting dialog) for the dialog. Today gains a Meetings section at the top of the spine: a 44px bone head "Meetings" with the mono count, day navigation as `‹ today ›` in the head's right lane, and one 40px row per external meeting that day — time, title, participants' names with the RSVP mark, the linked records as chips, and the artifact marks when a transcript or recording is on the row. Internal meetings are not stored, so nothing filters them here. The section is empty-state grey when no calendar is connected, with the one line C1 uses ("Connect Google Calendar").

The dialog opens from the row and from `?modal=meeting&id=` (D74): 48px bone head with the title and time, the conference link as the one action; the body in the dialog's section grammar — participants with RSVP shown and never editable, linked records with D49's pin to add one, the write-up (open the note, or "Write up" when `note_id` is null), artifacts by role, pending suggestions for this interaction with accept and reject inline, and **Prep**. Prep runs the assembler over the linked records through the synthesize lane on demand, streams into the dialog, is never stored, and offers "Save as note" which files it against the same records through `ai-15`'s writer. The sensitivity gate applies per call: a linked record under a sensitive space routes local or refuses, and the dialog says which in the same words Ask uses (Components › "Ask · states and cards", refused state).

**Acceptance criteria**

- [ ] Today shows a Meetings section for the chosen day, external meetings only, with day navigation that never leaves the route; the count in the head is the day's count and no readout repeats it
- [ ] The head carries "all meetings ›" to `/meetings` (`arrival-12`); with no calendar connected the section is the one D80 line, and a member's line names an admin instead of linking
- [ ] A row shows RSVP per participant from `meta.rsvp` and never offers to change it; "Open in Google" is the only write path
- [ ] The dialog opens from the row and from `?modal=meeting&id=`, with one close in the foot and no `esc` or `↵` printed
- [ ] Artifacts list by role; a `recording_link` opens the provider, a transcript opens the Files preview
- [ ] Prep streams on demand, is not persisted, and "Save as note" creates one note filed `tagged_in` on the linked records with the user as author; opening the dialog again shows no Prep until asked
- [ ] A linked record under a sensitive space makes Prep route local or refuse, and the dialog states which
- [ ] Gate 5 passes; the section and dialog follow T1 and M2 and the Separation Rule heights (44 head, 40 rows, 48 dialog head)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — With a calendar synced against the fake, Today lists tomorrow's two external meetings; open one, see who accepted, press Prep, read the brief, save it as a note, and find it on the company's Notes tab.

**Sheets** — Meetings + Granola — printed, sheet 01 (Today's Meetings section); Today — printed, sheets 00 and 01 (placement, the no-calendar line); Surfaces M2 (the meeting dialog, with Prep); Components "Ask · states and cards" (refused state). **Spec** — D68 and its 2026-10-09 amendment; D79; D80; D74 (deep links); `docs/design-contract.md` — a record, a ledger of a stream

#### `arrival-12` · afk · M — The Meetings page — upcoming by day with Prep, past with the unwritten first (D68 amended)

**Blocked by:** `arrival-11`

**What to build**

A list route, `/meetings`, for the two questions Today's one-day section cannot answer: what is coming this week and next, and which meetings nobody wrote up. A meeting stays an activity, never a record: the page is a read over `interaction` rows of kind `meeting` the reader can see, with no schema. It joins the chassis as one `NAV_ITEMS` row (Meetings, `G E` — `G M` is Mandate) in the work group; the collapsible **Library ▾** group that holds Notes, Meetings and Files is project 27's sidebar slice, and the row moves into it there with no edit here.

- **Head:** the plain title "Meetings", no readout strip, and the filter row **All · Upcoming · Past · No write-up · Mine** (Mine = meetings you attended).
- **Upcoming:** this week and next, grouped by day under a day head. A row: time, title, people with their RSVP mark, linked records as chips, and **Prep**, which opens the meeting window with Prep running (`arrival-11`).
- **Past:** newest first. Meetings with **no write-up** sort first and carry a **Write** button that opens the write-up through `notes-6`'s program; the rest show the write-up state (written, via Granola). A cancelled meeting stays, struck out.
- A row opens the same meeting window (`?modal=meeting&id=`). No count on the nav row: counts are on Tasks only.

**Acceptance criteria**

- [ ] `/meetings` lists the reader's visible meetings and nothing else; no migration, and the read goes through the shared statement in `@spaces/core/writes/read` with `canRead`
- [ ] Upcoming groups this week and next by day; Past sorts no-write-up rows first, then newest first; a cancelled meeting renders struck and stays in place
- [ ] Each filter narrows the list; "No write-up" shows past meetings with `note_id` null only; "Mine" shows meetings with the reader among the participants
- [ ] Write on a past row opens the write-up; Prep on an upcoming row opens the window with Prep streaming
- [ ] The nav row has `G E`, no count, and `nav-grammar.test.ts` passes with the new row
- [ ] Gate 5 passes; rows are 40px ledger rows, day heads follow the Separation Rule
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Meetings: next Tuesday's two founder calls sit under their day with Prep; filter No write-up and last week's three unwritten calls are first, each with Write.

**Sheets** — Meetings + Granola — printed, sheet 02 (the Meetings page, with the Library group). **Spec** — D68 amended 2026-10-09 (a Meetings list page; no schema); D74 (deep links); `docs/design-contract.md` — the nav grammar

#### `arrival-13` · afk · S — Notes filed from a tool are set in serif with "via"; the Notes tab gains "From meetings" (D78)

**Blocked by:** `arrival-7`

**What to build**

Two small surfaces D78 adds. **The typeface rule:** a note a person filed from their tool — a recorder note that landed through a ticked folder (`arrival-7`) — renders in serif like a hand-written note, with a mono **"via <tool>"** mark after the author ("via Granola · Anish"); an unchosen AI text stays sans (Exa's brief, an Ask answer, a summary nobody filed). The mark reads the note's provenance (`source_ref` to the integration), so no column is added. **The filter:** a record's Notes tab (D74) gains a filter row — **All · Filed here · From meetings · Mentions** — where "From meetings" lists the notes attached to the record's meetings (write-ups and `interaction_note` rows), "Filed here" the notes tagged on the record, and "Mentions" the notes that only mention it. The meeting stays the note's home in Interactions; the filter is a second door.

**Acceptance criteria**

- [ ] A recorder note renders in serif with "via Granola · <member>" in mono; a hand-written note shows no via mark; an Ask answer saved as a note keeps its own provenance and is unchanged
- [ ] The Notes tab's filter row narrows to the three sets; "From meetings" includes a meeting's write-up and its second notes, and a private typed note only for its author
- [ ] The tab head's count follows the filter
- [ ] Gate 5 passes; the filter row is the 36px second row the Interactions tab already uses
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On Flent's Notes tab, choose From meetings: two Granola notes in serif marked "via Granola · Anish" and "via Granola · Maya", and one write-up typed by hand.

**Sheets** — Meetings + Granola — printed, sheet 01 (the Notes tab filter). **Spec** — D78 (typeface; "From meetings"); D74 (the tabbed body)

### ▸ The first syncer

_Connect Google Calendar and let the schedule fire: this week's external meetings appear on the right companies' timelines with matched attendees, last week's do not, the internal standup never appears, and an expired sync token recovers without re-importing five years of history._

#### `arrival-5` · afk · M — plugins/google-calendar — the first syncer, forward-only from the connect date

**Blocked by:** `arrival-2`, `interaction-1`, `sdk-12b`, `sdk-25`, `sdk-4a`, `sdk-7b`, `storage-2b`, `storage-3a`

_Amended 2026-10-06 (D68): the event's `ends_at`, `status`, conference link, organizer, recurring instance id and each attendee's RSVP are written to `interaction.meta` (`interaction-1`) and updated in place on every pull, keyed by iCalUID; a cancelled event sets `meta.status: cancelled` and is never deleted. Two acceptance criteria below carry it._

**What to build**

sdk-4a ships the `syncer` interface (`pull(cursor) → {claims, nextCursor}`) with no tenant, and the entire OAuth substrate storage-1…3b builds exists to serve exactly this; spec-plugin-sdk §14 step 5 names it. The plugin lists `calendarId: 'primary'` with `singleEvents: true` and `showDeleted: true`, resumes from the stored `nextSyncToken`, and emits content claims through sdk-7b's interaction lane.

Three corrections to the surveyed implementation, each a gap the survey records. Twenty passes no `timeMin` and imports full history — forward-only is our decision, so the first pull starts at the connection's `created_at` and nothing older is ever fetched. Twenty dedupes per channel and never matches `iCalUid`, so one real meeting in two partners' calendars becomes two rows — here the interaction's `message_id` is the iCalUid, and the existing `interaction_message_id_unique` index enforces it for free. Twenty swallows HTTP 410 (expired sync token) into a silent full re-sync — here it maps to a typed cursor-invalid outcome that clears the cursor and restarts bounded by the same `timeMin`.

Attendees run through arrival-2's participant module so a calendar attendee and an email participant cannot drift apart, and `src/lib/arrival/noise.ts` gains the calendar rules beside the mail ones: an event where every attendee is a workspace member is internal traffic, and a cancelled or declined event is not a meeting that happened. The fake lives with the others behind `SPACES_FAKE_PROVIDERS=1`, which is why this waits on sdk-25 instead of inventing a second harness; the chaos cases that apply are 429 with Retry-After, token revoked mid-sync, and cursor expired.

**Acceptance criteria**

- [ ] plugins/google-calendar builds to bundle.mjs + manifest.json, imports @spaces/sdk only, and declares kind `syncer` with a schedule and `requires.connection: {provider:'google', scopes:['calendar.readonly']}`
- [ ] The first pull for a fresh connection requests `timeMin` = the connection's created_at and no earlier; a fixture calendar holding five-year-old events yields none of them, asserted by row count
- [ ] The same event on two connected calendars produces one interaction — `message_id` is the iCalUid and the second write conflicts rather than duplicating
- [ ] An expired sync token (410 from the fake) produces a typed cursor-invalid outcome: the cursor is cleared, the next run performs a bounded re-sync, and `job_run` records both — never a silent full-history import
- [ ] A cancelled event sets `meta.status: cancelled` rather than deleting the row, and re-running the pull does not resurrect it
- [ ] A changed event (time, attendees, RSVP) updates the same row's `occurred_at`, `meta` and participants in place, keyed by iCalUID; row count is unchanged
- [ ] Attendees resolve through `src/lib/arrival/participants.ts` with no calendar-specific copy of the policy — a test changes the policy fixture and sees both the mail and calendar lanes change
- [ ] An all-internal meeting creates no interaction; the rule lives in `src/lib/arrival/noise.ts` with the mail rules and is unit-tested with no database
- [ ] A runtime assertion shows the ports a `syncer` may not touch are absent from its Layer (Facts in particular), per the kind-to-ports table
- [ ] The suite runs against the in-repo fake with no network and no Google project; `SPACES_FAKE_PROVIDERS=1` is the only switch
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect Google Calendar from Settings → Connections against the fake IdP and let the schedule fire: this week's external meetings appear on the right companies' timelines with their attendees, last week's do not, and the internal standup never appears at all. Expire the sync token at the fake and the next run recovers without re-importing five years of history.

**Spec** — docs/spec-plugin-sdk.md §5 (syncer kind) and §14 build order step 5; docs/survey-twenty-calendar-sync.md §1 (per-channel dedup, iCalUid never matched) and §3 (no timeMin; HTTP 410 swallowed); CONTEXT.md — Email / calendar ingestion (forward-only; sync starts at connection date); docs/ARCHITECTURE.md §12 (integrations: Calendar → Gmail forward-only → Apollo/Exa); src/db/schema/interactions.ts (interaction_message_id_unique)

### ▸ The first ingress

_A member pastes a Granola key, ticks two folders, and the notes in them arrive on the right meetings within fifteen minutes: the enhanced note becomes the write-up, action items wait in Review as tasks, and a note in an unticked folder never reaches the box. A webhook recorder (Fathom, tl;dv) lands the same way through sdk-23's ingress (D78)._

#### `arrival-6` · afk · M · migration — The recorder contract — Granola on a `schedule`, a member's own key, the folders they tick (D78)

**Blocked by:** `arrival-2`, `interaction-2`, `notes-5`, `sdk-23`, `sdk-8`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-09 (D78): rewritten. The 2026-10-06 body was a webhook-only `plugins/recorder` for Fathom, tl;dv and Granola; Granola has no webhooks and a read-only API with a key per member, so the contract gains a `schedule` transport and a share decision by folder. Webhook recorders keep sdk-23's ingress under the same contract. The transcript edge stays `interaction-1`'s artifact join — an `interaction_document` row with `role: transcript` (a recording is `role: recording_link`) — never a column: `interaction.document_id` is never created._

**What to build**

One recorder contract with two transports. A recorder plugin hands the host a **recorded note** — provider note id, title, start time, attendee emails, the provider's `calendar_event_id` when it has one, the enhanced summary, the raw typed notes, the transcript, a `web_url`, the folder ids it sits in, and a `deleted_at` — and the host does the rest through `Content.logInteraction` and `interaction-2`'s match: `calendar_event_id`, else start time plus attendee emails inside the 30-minute window, else it births a `call`. Fathom and tl;dv deliver it by webhook through sdk-23's ingress (HMAC verified in web, `message_id` = the provider event id); **`plugins/granola`** delivers it from a `schedule` job about every 15 minutes, paging Granola's read-only notes endpoint from a cursor in the job's state. Notes still processing are not returned by Granola and are picked up on a later run.

**A recorder is a personal connection, keyed rather than granted.** The admin installs the plugin once; each member pastes their own Granola key on You → Meeting notes (D81). The key is an `account_connection` row — `provider: 'granola'`, `product: 'notes'`, the member's Granola email — whose `tokens_enc` bundle holds `{type: 'api_key', key}` under the same connection AAD, with no expiry and no refresh, so `accessTokenFor` returns it unchanged and the row lists beside the OAuth accounts. The migration carries the three columns and the one table D78 needs, so `arrival-7` runs without one:

- `account_connection.settings` jsonb, nullable: the per-connection choices a person makes — here the ticked folder ids and the two opt-ins (typed notes, transcript); the Email & calendar account page (D81: which calendars, labels to skip) is its second reader.
- `interaction_note(interaction_id, note_id, role)`, `role` an enum `recorder_note` | `typed_notes`, primary key on the pair: the notes a meeting carries beyond its one write-up (`interaction.note_id`). `ENTITY_REFS` gains `interaction_note.note` (`repoint` on merge, context role `item` through the interaction's participants).
- `document.visibility` (the existing `visibility` enum, default `shared`) and `document.author_id`, nullable: a transcript is a document private to the member who opted in, read through `canRead` exactly as a private note is.

Whether one member's key can read team-shared notes is not assumed: the job reads only what that key returns.

**The folder is the share decision.** The connection lists the member's Granola folders with a tick each. A note in a ticked folder is fetched and is shared with the workspace, like forwarded mail (D67); **a note outside every ticked folder is never fetched** — it does not exist in Spaces, privately or otherwise. A note that leaves every ticked folder, or comes back with `deleted_at`, removes Spaces' copy: the shared write-up or second note it became, its pending task suggestions, and its private artifacts. Unticking a folder does the same for the notes it held. What a fetched note becomes is `arrival-7`.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name recorder_contract`, SQL hand-inspected: `account_connection.settings` jsonb `$type`d through `@spaces/core/json`; `interaction_note` with its enum and pair key; `document.visibility` defaulting to `shared` and `document.author_id`; `ENTITY_REFS` carries `interaction_note.note` and `document.author_id` is not an entity ref (it points at `user`)
- [ ] A Granola key pasted on You → Meeting notes writes one `account_connection` row with an `api_key` bundle; `accessTokenFor` returns the key with no refresh call, and Disconnect deletes the row and its synced copies
- [ ] The connection lists the member's folders from the fake; ticking two writes their ids to `settings`, and the next run fetches notes from those folders only — a note in an unticked folder is never requested, asserted by the fake's request log
- [ ] A note moved out of every ticked folder, or returned with `deleted_at`, removes the write-up or second note it filled, its open task suggestions and its private artifacts on the next run
- [ ] A note with `calendar_event_id` attaches to the synced meeting; without it, start time plus attendee emails attach inside 30 minutes; with no match, a `call` is born — three fixtures through `interaction-2`'s writer
- [ ] The same recorded note delivered twice (two runs, or a webhook replayed) is one interaction and one set of artifacts — dedupe on the provider note id
- [ ] A webhook fixture for Fathom and one for tl;dv land through sdk-23's ingress under the same contract and the same assertions; `plugins/granola` declares a `schedule` job and imports `@spaces/sdk` only
- [ ] Fixture notes for all three providers are snapshot-tested through the SDK testing kit with no database and no network; `SPACES_FAKE_PROVIDERS=1` is the only switch for Granola's fake
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Paste a Granola key against the fake, tick "Deals" and "Portfolio": within one run, yesterday's two meetings in those folders gain their notes, the 1:1 in "Personal" never appears, and moving one note to "Personal" at the fake removes it on the next run.

**Sheets** — Meetings + Granola — printed, sheet 00 (the Granola connection); Settings — printed, sheet 05 (You → Meeting notes). **Spec** — D78 (recorders by folder; a recorder is a personal connection); D68 (one meeting, one row); D81 (You → Meeting notes); `docs/spec-plugin-sdk.md` §5 (`schedule` trigger) and §11 (ingress)

#### `arrival-7` · afk · M — What a recorded note becomes — the write-up or a second shared note, tasks from its action items, private extras (D78)

**Blocked by:** `arrival-6`, `ai-15`, `notes-6`

_Amended 2026-10-09 (D78): rewritten. The 2026-10-06 body made a recorder's summary a `note` suggestion to accept; D78 drops that (a card for every meeting is noise) — a note the member filed by folder lands directly, and only its action items wait in Review. Size grows S → M because the private transcript now goes through `canRead` on the document read paths._

**What to build**

The landing rules every recorder shares, in core beside `interaction-2`'s writer, run for each recorded note `arrival-6` fetches:

- **The enhanced note becomes the meeting's write-up** when `interaction.note_id` is empty: one shared note authored by the connection's member, rendered through `ai-15`'s markdown→BlockNote writer and set through `notes-6`'s program, so the row stops offering "Write up" and offers "Open note". When a write-up exists — written by hand or by another member's recorder — it lands as **a second shared note** on the meeting (`interaction_note`, role `recorder_note`) titled "Granola notes · <member>". It is never a Review suggestion, and a hand-written write-up is never overwritten.
- **Action items become `task` suggestions** (`interaction-1`'s kind). Granola sends them only inside the summary, so the Extract lane reads the summary and proposes one suggestion per item with the note as its ref; under the sensitivity gate a sensitive meeting extracts locally or proposes nothing.
- **The raw typed notes and the transcript are opt-in per connection** (`account_connection.settings`), both off by default and both **private to the member**: the typed notes as a private note (`visibility: private`, `interaction_note` role `typed_notes`), the transcript as a document on `interaction_document` with `role: transcript`, `visibility: private` and `author_id` the member. The document read paths — the Files tab, the preview route, chunk search and the context assembler — learn `canRead` for documents in this slice, so a private transcript is invisible to everyone else everywhere a private note already is. The transcript is still a document under the sensitivity gate. A recording stays a link (`recording_link`, D68).
- **`web_url` becomes "Open in Granola"** on the meeting window and the note's head.
- **Linked records** follow the attendees through the participants module, plus the matched company's open deal (D49).

The notes filed this way are set in serif with a "via Granola" mark (`arrival-13`).

**Acceptance criteria**

- [ ] A recorded note for a meeting with no write-up fills it: one note authored by the member, `interaction.note_id` set, `bodyJson` populated and `bodyMd` round-tripping
- [ ] A second recorded note (another member's, or after a hand-written write-up) lands as an `interaction_note` with role `recorder_note`; the write-up is unchanged and no suggestion row exists
- [ ] Two action items in a summary propose two `task` suggestions citing the note; a sensitive meeting with no local route proposes none — both asserted with the lane faked
- [ ] With both opt-ins off, no typed notes and no transcript are stored; with them on, the typed notes are a private note and the transcript a private document, and a second user is refused both on the Files tab, the preview route, Cmd-K and the assembler — each path asserted separately
- [ ] "Open in Granola" opens the note's `web_url`; linked records are the attendees' records plus the company's open deal
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — After a Granola sync, open yesterday's founder call: the write-up is Granola's enhanced note with "Open in Granola", two task cards wait in Review, and the transcript you opted into is on the Files tab for you and absent for your partner.

**Sheets** — Meetings + Granola — printed, sheet 00 (the meeting window: write-up via Granola, a second note, two task cards, the private transcript). **Spec** — D78 (what a synced note becomes); D68 (one meeting, many artifacts; recordings stay links); D49; `packages/core/src/read-policy.ts` (`canRead`)

### ▸ A mailbox that syncs itself

_Gmail's sync half only; the surface is project 25._

#### `arrival-10` · hitl · L — plugins/gmail — forward-only sync, and the privacy default finally decided

_Unchanged from the 2026-09-15 body below, with two amendments (2026-10-06): the privacy default this slice decides is D67's — synced mail private to the mailbox owner, forwarded mail shared, subject and participants always visible — so the first acceptance criterion records D67 rather than re-deciding it; and the message's headers are written to `interaction.meta` (`interaction-1`) rather than to columns of their own._

**Blocked by:** `arrival-2`, `arrival-3`, `arrival-5`, `sdk-25`, `storage-2b`, `storage-3a`

**What to build**

The last arrival channel, and the one CONTEXT gates on an explicit decision it has deliberately left open: "Privacy default (decide deliberately — get it wrong and partner #2 never connects their mailbox)." The forwarding mailbox sidesteps it, because forwarding is the consent; a connected mailbox does not. The survey is blunt that retrofitting redaction into a store that assumed share-everything is miserable, so per-connection visibility exists the day the first thread syncs or it never exists.

The sync itself is the smallest thing that works: kind `syncer`, one connection per user, `users.history.list` resumed from the stored historyId whose first value is derived from the newest message at connect time — no historical backfill, which is CONTEXT's forward-only decision and what turns the entity-creation flood into a trickle. Bodies come through the batch endpoint, participants run through arrival-2's module, attachments file through storage-6a's arrival module exactly as arrival-3's do, and `src/lib/arrival/noise.ts` gains the exclude list (domains and labels never synced) with a shipped default blocklist. Dedupe is the same RFC Message-ID index the forwarding lane uses, so a thread that was both forwarded and synced is one interaction. Deliberately not built: the per-channel message-association table Twenty uses to record "one message, two mailboxes" — with one mailbox it is an empty join, and it is named here as the thing mailbox #2 forces.

L, and it cannot split: the redaction layer cannot merge before the sync that makes it observable, and a sync that stores bodies before the redaction lands is precisely the retrofit the survey says never to do.

**Acceptance criteria**

- [ ] The privacy default is decided and recorded in CONTEXT.md §"Privacy default" in the same PR before a single body is stored: what is shared (metadata), what is not (bodies), whether the default is per-connection or workspace-wide, and the toggle that changes it
- [ ] The decision is enforced at read time, not at storage: a test asserts a non-owner cannot reach a restricted body through the record timeline, Cmd-K, the context assembler or the AI substrate — that list is the one that must be complete, and each path is asserted separately
- [ ] The first sync on a fresh connection derives its cursor from the newest message and imports nothing older; a fixture mailbox with a year of history yields no interactions from before the connect time
- [ ] A thread already present from the forwarding mailbox is not duplicated — the existing `interaction_message_id_unique` index is the dedupe, asserted with both lanes writing the same Message-ID
- [ ] An expired historyId maps to a typed cursor-invalid outcome that re-derives the cursor forward and never performs a full-history import
- [ ] An auth failure marks the connection `error` with the provider's reason and is never auto-retried; a transient failure backs off with Retry-After honoured and the work re-queued — the survey's taxonomy, shared with arrival-5
- [ ] The exclude list and a default blocklist ship in the plugin's settings; a message from an excluded domain is refused before any body is stored, and adding a domain later removes what it already synced
- [ ] Attachments file through storage-6a's arrival module and storage-6a's single-writer grep test still passes
- [ ] The suite runs against the in-repo Gmail fake behind SPACES_FAKE_PROVIDERS=1, with no Google project and no network
- [ ] The Google verification note (Internal for Workspace, Testing mode's 7-day refresh tokens) is in the connection UI copy, not only in CONTEXT.md
- [ ] Gate 5 passes on the visibility control wherever it renders
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect a mailbox against the fake and let the schedule fire: threads from after the connect time appear on the right companies with their participants and attachments, nothing older does, and a second user opening the same record sees exactly what the recorded privacy default says they should — no more, no less.

**Spec** — CONTEXT.md — Email / calendar ingestion (forward-only, BYO GCP client, Google verification avoidable); CONTEXT.md — Privacy default (metadata shared, bodies restricted, per-connection exclude list, settings toggle); docs/survey-twenty-email-sync.md §5 (visibility enforced at read time) and §7.3, §7.5; docs/spec-plugin-sdk.md §14 build order step 5 (Calendar, then Gmail forward-only); docs/ARCHITECTURE.md §12

### ▸ Struck 2026-10-06

_`arrival-8` and `arrival-9` are kept below as written, struck: D72 supersedes D33 — a feed is a watch plugin, matching is `Discover` → `previewResolve`, and unmatched items are the add-record cards._

#### ~~`arrival-8` · hitl · M — feed and feed_item — one URL, three scopes, a cadence you can mute~~ **struck 2026-10-06 (D72 supersedes D33: a feed is a watch plugin)**

**Blocked by:** `docsurf-1b`, `sdk-24b`

**What to build**

The product half of the feed capability, which sdk-24b does not build: it makes plugins/rss a PluginDb tenant whose feeds are configured in manifest settings and whose seen-guid dedupe lives in `plugin_rss.feed_item`. CONTEXT specifies something else — `feed(url, scope, cadence, muted)` plus `feed_item(feed_id, guid, url, title, summary, published_at)`, attaching at three scopes: global, per space, per entity. Attaching a hydrogen blog to the hydrogen space, or a portfolio company's press page to its record, is a product gesture on a product surface, and a plugin never extends the product: the fetch is the plugin's job, the graph and the surface are core's. So core owns both tables, the attach surface and the recurring job, and plugins/rss keeps only a conditional-GET cache (etag / last-modified per URL) in its own schema — still a real PluginDb tenant, just not the owner of the product's rows.

`feed.scope` is a discriminator plus a nullable `entity_id`: a space is an entity, so per-space and per-entity are one column and one ENTITY_REFS entry rather than two. Dedupe is `unique(feed_id, guid)` with a URL fallback for feeds that omit guids, and it is core's rule, so a second poller inherits it. Cadence and muted live on the row so a noisy feed is silenced without deleting what it already found. hitl because the attach control appears in three places — settings for global, the space page beside docsurf-1b's Sources section, the record page — and a feed's health line (last polled, last error, items this week) is a new readout to judge against DESIGN.md.

**Acceptance criteria**

- [ ] Migrations add `feed(id, url, scope, entity_id, cadence_minutes, muted, last_polled_at, status, last_error, created_by, created_at)` and `feed_item(id, feed_id, guid, url, title, summary, published_at, created_at)` with `unique(feed_id, guid)`; SQL hand-inspected
- [ ] ENTITY_REFS gains `feed.entity` with an explicit merge strategy and an explicit `context` decision; deleting the entry fails entity-refs.test.ts naming the column
- [ ] A `feed.poll` queue schedules per row from `cadence_minutes` and drives the `poller` port; core writes every `feed_item` row and the plugin stores nothing per item
- [ ] Polling the same fixture feed twice inserts items once, asserted by row count; a feed whose items carry no guid dedupes on URL, tested with a second fixture
- [ ] A muted feed is not polled and keeps its items; unmuting resumes without re-inserting anything
- [ ] The same URL attached at two scopes is two feed rows with two item sets — no cross-scope sharing, with a comment naming that as the decision
- [ ] With no poller plugin installed the attach surface reads "no feed reader installed" rather than accepting a URL that will never be polled
- [ ] The global, space and record attach controls are one component; gate 5 passes on it and the feed readout is reviewed against DESIGN.md before merge
- [ ] Each poll writes a `job_run` row and a failing feed sets `status` with the reason instead of retrying in a tight loop
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Paste a sector blog's RSS URL onto the hydrogen space and a portfolio company's press feed onto its record. Within a cadence both show items with dates and a last-polled line; mute the noisy one and it stops without losing what it already found.

**Spec** — CONTEXT.md — The integration map #12 (feed(url, scope, cadence, muted) + feed_item; three attach scopes); docs/spec-plugin-sdk.md §5 (poller kind) and §14 step 6; docs/spec-plugin-sdk.md §1 (plugins feed the graph; they never extend the product); src/db/entity-refs.ts (every entity-referencing column declares merge strategy and context role)

#### ~~`arrival-9` · afk · M — Feed items match the graph — a signal on the record, the unmatched still visible~~ **struck 2026-10-06 (D72; matching is `Discover` → `previewResolve`, unmatched items are the add-record cards)**

**Blocked by:** `arrival-8`

**What to build**

What makes feeds CRM-grade rather than a reader, and the half CONTEXT is most specific about: each item runs a deterministic match pass against the graph — company domains in the item's links against `entity_alias(kind: 'domain', is_identity)`, and alias or canonical-name matches in title and summary — and lands as a `signal` on the matched record. `signal` already exists (src/db/schema/interactions.ts) with `source` as open text, and it already has an ENTITY_REFS entry whose context role is item/event/hop 0, so a matched item is on the record's timeline and inside the context assembler the day it lands, with no schema change at all. Matching is pure and lives in `src/lib/arrival/match.ts`; the classify-lane pass CONTEXT calls the AI upgrade is explicitly not built here and stays gated on the AI capability.

The other half is the one that is easy to drop: unmatched items are the sourcing signal — companies you do not have records for yet. CONTEXT names the digest as their consumer, and the digest does not exist (the Monday brief is a banked feature nobody owns), so this slice keeps them where they already are, on the feed's own row with an unmatched count and list. It does not invent a third queue beside the review inbox and the unfiled shelf.

**Acceptance criteria**

- [ ] `matchItem` is pure over (item, candidate aliases) and unit-tested with no Postgres: a domain in a link matches, a domain mentioned only in prose does not, a canonical-name match requires a word boundary, and an alias under three characters never matches
- [ ] A matched item writes exactly one `signal` row on the record with `source` naming the feed and the item in the payload; re-polling writes no second signal, keyed on the feed_item row
- [ ] Signals render on the record timeline through the path `signal` already has, with no new timeline branch
- [ ] An item matching two records writes a signal on each, with a comment naming that as the decision
- [ ] No entity is ever created by a feed poll — asserted by an entity-count assertion around the run, which is also what keeps a `poller` inside its allowed ports
- [ ] Unmatched items are counted and listed on the feed row; they are not added to the review inbox, to Today's Unfiled count or to the dedupe queue, and a comment names the digest as their eventual consumer
- [ ] Matching 50 fixture items runs under a stated bound with one candidate query, not one query per item
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Attach a sector feed and wait a cadence: three items land as signals on portfolio companies' timelines, and the rest sit on the feed as unmatched — which is where the next company you have never heard of comes from.

**Spec** — CONTEXT.md — The integration map #12 (deterministic match pass; unmatched items still flow to the digest); src/db/schema/interactions.ts (signal: entity_id, source as open text, payload jsonb); src/db/entity-refs.ts (signal.entity — context role item/event/hop 0); CONTEXT.md — Interactions and enrichment

---

## 24. Cmd-K finds, Ask answers

_Spaces v1 · 9 slices · added 2026-10-06, bodies 2026-10-06, amended 2026-10-09_

_Amended 2026-10-09 (D70 amended 10-08, D77): the palette's answer stage is removed — ⌘K only finds, and Tab or ⌘J hands to **Ask docked** as a 408px third column, with `/ask` as the full page over one thread store (`ask-5`); the page you are on is the default scope and view and file chips join (`ask-7`); an undecided card waits in Review (`ask-6`); Cmd-K's empty state shows the page's own actions only, a passage previews its page, and an action that needs one more answer asks it in the palette (`ask-3`, `ask-4`). `ask-8` splits: **Find** in Ask (`ask-8a`) follows `watch-3`, **Save as watch** (`ask-8b`) follows `watch-4`. The canvas is now Cmd-K — printed and Ask — printed, sheets 00–06; K1 and A1 are superseded where they differ._

The Attio-class chat layer, as D70 and D71 decided it: Cmd-K regrouped into a finder with a preview pane; Ask as a second, in-process client of the MCP tool surface, with `query_records` first so external agents gain from it before any chat UI exists; threads, citations, action cards, `@space` scoping over D71's position and peers, and a plugin's MCP server mounted when its manifest declares one (D72). Independent of 25; either may run first. The canvas: Surfaces **K1** (Cmd-K), **A1** (Ask, two stages), Components **"Ask · states and cards"**, Patterns **P10** (a palette with a preview pane).

### ▸ Questions the graph can compute

_`query_records` over the views compiler and the interaction stats, with a descendant-inclusive `space` condition, and the portfolio tools over the pure libraries, so filters, counts and money are computed and never generated._

#### `ask-1` · afk · M — `query_records` — conditions, sort, limit, the `space` condition with descendants (D70, D71)

**Blocked by:** `ai-23a`, `email-4`

**What to build**

A new tool on the MCP server (`apps/web/src/lib/mcp/tools-read.ts`): `query_records(object, conditions, sort, limit)`. It is a thin door onto the views compiler (`apps/web/src/lib/views/` — `records.ts`, `counts.ts`, `resolve.ts`): conditions are the view filter grammar the compiler already takes, keyed by attribute slug, plus the read-only interaction-stat columns `email-4` adds (`last_interaction`, `first_email`, `next_meeting`) and one new condition, `space: {id, includeDescendants: true}`, compiled as an `entity_space` join through `space.path <@` so it matches ancestor visibility (D71). Sort takes any filterable or sortable attribute and the stat columns; `limit` caps at 200 and the result carries `total` from the counts compiler. `canRead` applies as the token's user; a record the user cannot read is neither returned nor counted. The tool description, like `get_record`'s, is written for an agent: it names the operators, says counts are computed, and says it never summarises.

**Acceptance criteria**

- [ ] `query_records` is registered beside `search_records` and `get_record`, validated by zod at the boundary, and refuses an unknown attribute slug naming it
- [ ] A `space` condition with `includeDescendants` returns records filed in the space and any descendant, through the compiler's SQL and not a second query per space
- [ ] Sorting and filtering on an interaction-stat column uses `email-4`'s table; a fixture with three companies and two emails orders by `last_interaction` correctly
- [ ] `total` equals the counts compiler's answer for the same conditions; `limit` over 200 is clamped
- [ ] A record `canRead` refuses is absent from rows and from `total`
- [ ] The existing EXPLAIN assertion in `value-index-plan.test.ts` still passes for a sort the tool compiles — the index plan is unchanged
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — From an MCP client: `query_records(company, {space: {id: aerospace, includeDescendants: true}, stage: 'seed'}, sort: last_interaction desc, limit 10)` returns ten rows and a total, and the same question with `includeDescendants: false` returns fewer.

**Spec** — D70 (new tools: `query_records` first); D71 (structured queries over the tree); `docs/spec-ai-substrate.md` §5–6

#### `ask-2` · afk · S — Portfolio tools on the MCP surface — computed over `@spaces/core/portfolio`

**Blocked by:** `ask-1`

**What to build**

Two read tools over the pure portfolio libraries, so money in an answer is computed: `portfolio_summary(asOf?)` — invested, value, distributions, TVPI and IRR per holding and in total — and `holding_detail(holdingId, asOf?)` — the event ledger with reversals applied as the reader contract applies them (originals stamped `reversedAt`, dropped once the as-of day reaches that instant). Both call the same loader `apps/web/src/lib/portfolio/detail.ts` hands the page, then the pure functions in `packages/core/src/portfolio/`, and return numbers as numbers with the currency named. `canRead` as the user; sensitive holdings are absent.

**Acceptance criteria**

- [ ] `portfolio_summary` matches `/portfolio`'s readouts for the same as-of date to the cent, asserted on the fixture ledger
- [ ] `holding_detail` with an as-of date before a void still shows the original; after it, the original is gone and no negation row leaks
- [ ] Money is returned as numbers parsed at the boundary, never as the drizzle `numeric` strings
- [ ] A sensitive holding is absent from both tools
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Ask an MCP client "what is our TVPI as of last quarter end": the tool returns the figure the portfolio page shows for that date.

**Spec** — D70 (portfolio tools over the pure libraries); CLAUDE.md — the portfolio reader contract (D12)

### ▸ Cmd-K finds and goes

_Jump to, Actions with printed keys and the record's own verbs first, Records lexical and fuzzy only, Passages as the second wave; a preview pane on highlight; Tab hands the query to Ask._

#### `ask-3` · afk · M — The finder regroup — four groups, contextual actions, semantic only as Passages (D70)

**Blocked by:** none

_Amended 2026-10-09 (D70 amended 10-08): with nothing typed the palette shows only the page's own actions — no recent items; an action that needs one more answer (File in a space…) asks it in the same palette, the input's mode label naming the action and ⌫ on an empty input returning to Find; Tab hands the typed text to Ask docked (`ask-5`), never to an answer inside the palette._

_Amended 2026-10-10 (pre-check against main `3397486`): no page publishes its own verbs today — the palette has one static action, Upload. This slice adds the mechanism: a `usePageActions(actions)` registration each record route and Today call with their verbs and keys, which the Actions group reads. "Write email" does not exist (email-7) and is left out until then. Confirmed present: `fusedStatement` in `@spaces/core/writes/read/search`, the semantic wave in `lib/search/waves.ts`._

**What to build**

The palette as **K1** draws it. Four groups in order: **Jump to** (objects, saved views, settings pages), **Actions** (verbs with their printed keys — only our bindings, `L`, `G T`, never `esc` or `↵` — contextual: on a record its own verbs first, Log interaction, Write email, Move stage), **Records** (the lexical fused search statement from `@spaces/core` only, fuzzy on `canonical_name` and aliases, so a typed name puts that record first), **Passages** (SPA-129's semantic lane, second wave after typing pauses, places to go and never answers). A result row is 36px with the kind glyph, the name in ink, the path or object in graphite, and the printed key right. The foot is one mono line: navigate · actions on this result · open · **Tab → Ask**; Tab hands the typed text to Ask (`ask-5`), which until then opens the existing `/ask`-less state as "Ask is coming" — no, until `ask-5` lands the foot omits Tab, so nothing is printed that does not work. Empty: "Nothing found" with the one pine "Ask it" once `ask-5` exists. Passages loading shows the group head with a running mark, never a spinner row.

**Acceptance criteria**

- [ ] The four groups render in order; a group with no results is absent, not an empty head
- [ ] Typing a record's name ranks it first in Records; semantic hits never appear in Records — asserted with a fixture where the semantic lane would outrank
- [ ] On a record route the Actions group lists the record's verbs first with their keys; on Today it lists the global verbs
- [ ] Passages arrive as a second wave after the typing pause and appear under their own head; the head carries a running mark while pending
- [ ] No `esc`, `↵` or ⌘K is printed anywhere in the palette; the foot lists only our bindings
- [ ] With nothing typed on a record, the palette lists that record's actions only; on a page with no actions of its own it shows only the input until something is typed, and never recent items
- [ ] File in a space… asks for the space in the same palette with the mode label `FILE IN ›`; ⌫ on the empty input returns to Find with the query restored
- [ ] Gate 5 passes; rows are 36px, groups separated by bone heads at 44px
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Press ⌘K on a deal, type "hal": Jump to offers Deals, Actions offers Move stage `M`, Records puts Halcyon Grid first, and a moment later Passages offers a deck page.

**Sheets** — Cmd-K — printed, sheets 00–03 (kit, opened on a record, typed, the action's second step); Patterns P10. **Spec** — D70 (Cmd-K is the finder) and its 2026-10-08 amendment

#### `ask-4` · afk · S — The preview pane — a record's readout and key fields, an object's views and counts

**Blocked by:** `ask-3`

_Amended 2026-10-09 (D70 amended 10-08): a highlighted **passage** previews too — its page rendered with the matched text set off — and ↵ opens the file viewer at that page. The palette is a window over the scrim, so it carries the solid shadow, not the dithered one._

**What to build**

K1's stage A: when a Records or Jump to result is highlighted, the palette widens and a preview pane opens right over a bone-deep scrim — for a record, its readout strip in variant B and the first six filled attributes as label–value rows; for an object, its saved views with counts; for a settings page, nothing (no pane). The pane reads through the same loaders the record head uses (`get_record`'s program for records, the views directory for objects) and is cached per highlighted id for the palette's life. Nothing highlighted, the list runs full width. Keyboard: ↑↓ moves the highlight and the pane follows; → focuses the pane's actions; the foot's "actions on this result" opens the record's verbs.

**Acceptance criteria**

- [ ] Highlighting a record shows its strip and six filled attributes; empty attributes are not listed
- [ ] Highlighting an object shows its views and counts from the directory loader
- [ ] Highlighting a passage shows its page with the matched text and ↵ opens the file viewer at that page
- [ ] The pane does not open for settings pages and closes when the highlight leaves a previewable row
- [ ] Preview data is fetched once per id per palette session, asserted by a request counter
- [ ] Gate 5 passes; the scrim is bone-deep and the pane follows the readout variant B
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — ⌘K, type a company, arrow down to it: the strip and key fields appear right; arrow to Deals under Jump to: its three saved views and counts appear instead.

**Sheets** — Cmd-K — printed, sheets 02 and 03 (record preview, passage preview). **Spec** — D70 (preview pane) and its 2026-10-08 amendment

### ▸ Ask answers

_Ask docked beside the page and the full `/ask`, one thread store: every claim cited, "Save as note", action cards applied as the user, the page as the default scope, the sensitivity gate per call, private threads; then Find in Ask over a plugin's tools, and Save as watch._

#### `ask-5` · afk · M · migration — Threads and Ask docked — an in-process MCP client, citations, `/ask`, Save as note (D70)

**Blocked by:** `ask-1`, `ask-3`, `ai-15`

_Amended 2026-10-09 (D70 amended 10-08, owner): Ask is **docked** — a 408px third column beside the page — plus the full `/ask` page, over one thread store. The palette's answer stage (A1 stage A) is removed: ⌘K only finds, and Tab or ⌘J opens the dock. Answers are in sans. The turn's context is frozen when it is asked; the turn states grow to stopped, refused (no local route), no provider, connection lost and empty; a scope change inside a thread leaves a line; an answer whose cited source the reader can no longer read is hidden and leaves a line. Undecided cards wait in Review (`ask-6`). Amended again 2026-10-09 (D70 layout): the dock closes completely and resizes 360–560px; `/ask` reads in a 760px column with a collapsible thread list and tables that break out; your turn is right-aligned, the answer left with no box._

**What to build**

Ask is a second client of the MCP tool surface, in process: the agent loop runs in web's server fns (Effect-first, through `effectFn()`), calls the registered tools (`search_records`, `get_record`, `get_context`, `query_records`, the portfolio tools, `propose`) through the same registry `apps/web/src/lib/mcp/server.ts` exposes externally — one tool set, one `canRead`, one sensitivity gate — and streams the turn over the SSE channel D64 opened. Tables: `ask_thread(id, user_id, title, created_at)` and `ask_turn(id, thread_id, role, body_md, refs jsonb, calls jsonb, scope jsonb, ai_run_id, created_at)` — a migration, carried here because nothing else needs these rows. A turn stores the scope and the context it was asked with, **frozen**: reopening a thread shows what that turn saw, not what the page holds now. Threads are private to their author and are not entities: no mentions, no search hits, no `entity` row. Every turn is an `ai_run` under the daily cap; the gate per call comes from what was retrieved, routing local or refusing, and the turn says which.

**Ask docked** (Ask — printed, sheets 00–04 and 09): a column on the right of any page, the page still usable beside it — 408px by default, resized by dragging its left edge between 360 and 560px, and closed completely by ⌘J or its × (no rail; the sidebar row or ⌘J reopens it, the thread intact); width and open state are remembered per browser. **Alignment:** your turn is a bone block with a hairline, right-aligned, at most three quarters of the column, its time under it; the answer has no box and sits left at full measure, ending in a foot naming the model and the sources; a scope change is a centred mono divider. A table in an answer scrolls sideways inside its card, with "Open in /ask ›". Head: the thread title and the scope chips (`ask-7`); body: turns, the answer **in sans** streaming with every claim cited as ref chips (`doc:…#n`, `note:…`, `record:…`), the call strip under it naming each tool with its state, **Stop** while it streams; foot: the composer with ⌘↵ as the one printed key, **Save as note** (ghost) and **Open in /ask**. The answer ends in the `Sources n · pinned ›` footer (D74). **Turn states:** reading, computing, answered, stopped, sensitive (routed local), refused (no local route), capped, no provider (with "Add a model ›", D80), connection lost (retry), empty (nothing found, with what was searched).

**`/ask`** (sheets 05–08): the thread reads in a 760px column centred in the space left, and tables (Find results, query rows) break out to the full content width; the thread list collapses from its head and "Threads" brings it back. The thread list is grouped by day, each row with its scope and its outcome (cards applied, saved as note), rename in place, delete with a confirm that prints counts; a thread opened full width with day separators; **Open beside <record>** hands the thread back to the dock on that record. A **scope-change line** marks where the scope moved inside a thread. When a turn cites a source the reader can no longer read, its answer is hidden and a line says so ("An answer here cited something you can no longer see"); nothing else of the thread changes.

**Doors:** Tab from Cmd-K (the typed text carried), ⌘J anywhere, the **Ask** row under Search in the sidebar and `/ask`, and "Ask about this" in a record's or a space's `···` menu. "Save as note" writes the answer through `ai-15`'s renderer with the user as author, filed `tagged_in` on the records the answer cited.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name ask_threads`, SQL hand-inspected; `ask_thread` and `ask_turn` reference `user` and `ai_run` and carry no entity row — a test asserts a thread is not found by search or mentions
- [ ] A turn calls tools through the same registry the external MCP server uses, asserted by a spy on the registry; no second tool table exists
- [ ] Every sentence of the answer that states a fact carries a ref; the renderer refuses an unreferenced claim block in a test fixture
- [ ] A turn's scope and context are stored with it; changing the record's values after the turn does not change what the reopened turn shows
- [ ] The gate: a turn whose retrieval touched a sensitive record routes local or refuses, and the call strip names which; with no provider the turn shows "Add a model ›"
- [ ] Stop ends the stream and the turn reads "stopped" with what had arrived; a dropped connection reads "connection lost" with retry
- [ ] Each turn writes one `ai_run`; the daily cap refuses the turn with the cap state shown
- [ ] Save as note creates one note with the user as author, the cited records tagged, and the answer's refs preserved
- [ ] ⌘K never renders an answer; Tab opens the dock with the typed text, ⌘J opens it empty, the sidebar row and `/ask` land on the page, and the record menu sets the scope chip
- [ ] A thread whose cited note became private to someone else hides that answer behind the line for the reader; the author of the note still sees it
- [ ] `/ask` lists threads by day with scope and outcome; Open beside <record> opens the dock on that record with the thread
- [ ] The dock resizes between 360 and 560px and closes with ⌘J or ×; width and open state survive a reload; closing keeps the thread
- [ ] `/ask` keeps the thread at 760px and lets a table run the full content width; the thread list collapses and reopens
- [ ] Your turns render right-aligned on bone with a hairline; answers render left with no box
- [ ] Threads are listed only for their author; another user's request for the id is refused
- [ ] Gate 5 passes; answers are sans, no `esc` or `↵` printed, Send is ⌘↵ only inside the field
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On a deal, press ⌘J and ask "which Series A deals have gone quiet": the dock streams the answer in sans with each deal cited and `query_records` in the strip; Save as note files it; open `/ask`, find the thread under today, and Open beside the deal.

**Sheets** — Ask — printed, sheets 00 (anatomy), 02 (turn states), 04 (ways in and out), 05 (`/ask`), 06 (`/ask` states: lost access, scope-change line), 07–08 (`/ask` layout: aligned turns, list open and collapsed, a table breaking out), 09 (the dock resized and closable); Shell — printed, sheet 01 (Ask docked). **Spec** — D70 (Ask is the agent; one client of the tool surface; threads private) and its 2026-10-08 amendment; D74 (sources footer); D80 (no provider); `docs/spec-ai-substrate.md` §5–6

#### `ask-6` · afk · M — Action cards — propose create task, move stage, file into a space; applying writes as the user

**Blocked by:** `ask-5`

_Amended 2026-10-09 (D70 amended 10-08): a card left undecided when the thread is closed is not lost — it waits in **Review** as the suggestion it already is, grouped under its thread, and the outcomes are five: proposed, applied, skipped, left undecided → Review, conflict. "Save as watch" is `ask-8b`'s card._

**What to build**

The agent proposes; the user applies. A turn may return cards beside its answer, each a suggestion-shaped proposal rendered from the eight-card catalogue on the Components sheet: **create task** (`task` kind, `interaction-1`), **move stage**, **file into a space**, **log signal**, **note**, **draft email** (`email-6`, when it exists), **add record** and **save as watch** (`ask-8b`). Each card shows the proposal, its evidence refs and one pine **Apply**; applying runs the same server fn a person would — the task writer, the stage move, the tag insert — as the user, so provenance is the user and the activity log says so. Outcomes render once: applied, skipped, not applied on conflict (the stage already moved, the record already filed), and **left undecided**, which keeps the card open in Review under a head naming its thread. A card is never applied by the agent, and the `propose` tool stays the path for attribute patches, which land in Review as today.

**Acceptance criteria**

- [ ] A turn's cards render from the catalogue with evidence refs; a card without refs is refused by the renderer
- [ ] Apply on create task makes a task through the existing writer with the user as creator; on move stage, one stage event by the user; on file into a space, one `entity_space` row with `source: 'ai'` and the user as actor — each asserted
- [ ] A conflicting apply (stage already there, already filed) renders "not applied" and writes nothing
- [ ] A card neither applied nor skipped when the thread closes appears in Review under its thread's head and applies from there with the same writer
- [ ] Attribute proposals still go through `propose` to Review, never as a card — asserted
- [ ] Gate 5 passes; cards follow the component sheet, one pine verb each
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Ask "who have we not spoken to in sixty days in Climate": the answer lists four companies and offers a task card per company; apply two, skip two, and Tasks shows the two with you as creator.

**Sheets** — Ask — printed, sheet 03 (eight card kinds, five outcomes). **Spec** — D70 (action cards; AI still only proposes) and its 2026-10-08 amendment

#### `ask-7` · afk · M — Scoping — `@space` and `@record`; the assembler's position, peers and space-as-seed (D71)

**Blocked by:** `ask-5`

_Amended 2026-10-09 (D70 amended 10-08): **the page you are on is the default scope** — Ask opened on a record, a space or a saved view starts scoped to it, and the chip is removable for the whole workspace. Two chips join `@space` and `@record`: a **view chip** (the rows of the saved view the page shows, through `query_records` with the view's conditions) and a **file chip** (one document, its chunks seeded first). A web chip appears when a plugin's tools are mounted (`ask-8a`). The body and criteria below are edited to match._

**What to build**

Two halves. The assembler half, in `packages/core/src/writes/context/` and the pure ranker: a **position** item per filed space naming its full path; a capped **peer set** — other companies filed in the same leaf space ranked by stage and recency, each with its key values — as candidates that compete for the budget; and **a space as the subject**: when the seed is a space, the assembler returns its subspace tree with counts, memos, companies grouped by stage, and terms. `canRead` applies, and a sensitive space anywhere in a path keeps the call sensitive, as the resolver already does. The Ask half: `@` in the prompt opens the mention popover (Components sheet) over spaces and records; a chosen scope becomes a chip in the row and narrows retrieval to the scope and the assembler's seed to it — `@space` makes `query_records` take the descendant-inclusive condition by default. Scope defaults to the page: on a record, a space, a saved view or a file the first chip is that page, already set; on Today or `/ask` there is none and the turn searches the whole workspace. A **view chip** passes the view's conditions to `query_records`; a **file chip** seeds the assembler with that document. Every chip is removable, and the chip reads as a narrowing, never as a mode.

**Acceptance criteria**

- [ ] A record's context carries one position item per filed space with the full path; snapshot updated
- [ ] Peers are capped and ranked, come only from the same leaf space, and lose to higher-ranked items under a tight budget — asserted with the ranker's test budget
- [ ] A space seed returns tree, memos, members by stage and terms; a sensitive descendant makes the call sensitive
- [ ] `@` opens the popover; a chosen space sets the chip and the turn's `query_records` calls carry the space condition with descendants
- [ ] Opened on a record, a space, a saved view or a file, the dock starts with that page's chip set; removing it makes the next turn workspace-wide, and on Today there is no default chip
- [ ] A view chip runs `query_records` with the view's conditions; a file chip seeds the assembler with the document's chunks first
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Ask "@Hydrogen what do we believe about this market, and who is thin": the answer names the thesis from the memos, lists the companies by stage, and points at the subspace with one member.

**Sheets** — Ask — printed, sheet 01 (context chips: page, record, space, person, view, file, web); Components "Ask · states and cards" (@ mention popover). **Spec** — D71; D70 (scoping) and its 2026-10-08 amendment

#### `ask-8a` · afk · M — Find in Ask — a plugin's MCP server mounted, Exa's results as a table, Add · File here · Dismiss (D72, D77)

**Blocked by:** `ask-6`, `ask-7`, `watch-3`, `backfill-12`

_Added 2026-10-09 (D77): the first half of the old `ask-8`. Find needs only the two card kinds and `previewResolve`, so it follows `watch-3` and no longer waits for the Watching lane._

**What to build**

**Mounting.** A manifest may declare `mcp: {url, auth}`; when the integration is enabled, Ask mounts that server's tools for the turn, keyed from the vault through `Secrets`, proxied through the Http throttle and D53's credit cap, and attributed to the integration in `ai_usage`. A turn whose scope holds a sensitive space unmounts every plugin server before the first call — **a sensitive scope never reaches Exa** — and the call strip shows the cell as `unmounted`. Ask uses Exa's fast search for a question (seconds, approximate); websets are for watches (`ask-8b`, `watch-5`).

**Find.** A question that asks who matches a description ("rental software startups in India") answers as a **results table, not prose**: name, domain, one line, place, two or three source links, and a "via <plugin>" column. Each row is checked against what is held through `watch-3`'s `Discover` path: filed in the scoped space → greyed; held elsewhere → **File here**; unknown → **Add**, with **Add and file here** in its menu when a space is in scope; dismissed for this space → hidden. **Dismiss** is permanent per (space, domain). Adding runs `resolveEntity` and D76 enrichment follows ("added · enriching"); a result is a web result until it is added, and finding never creates a deal. The table folds past twelve rows ("+13 more · 2 hidden"). The same domain found by a watch and by a question is one open card (`watch-3`).

**The door.** **Find companies** joins the space head (`spaces-4`): it opens Ask docked with the space and the web in scope, the question prefilled from the space's criteria. ⌘J asks from anywhere. Enabling Exa lights the watch, the record action and the Ask tools from one integration row.

**Acceptance criteria**

- [ ] A manifest with `mcp` validates; its tools appear in the turn's call strip with the provider's mark when the integration is enabled, and vanish when disabled or breaker-tripped
- [ ] The key comes from the vault and is never sent to the browser; calls go through the throttle and the credit cap, and the cap refuses with the cap state
- [ ] A sensitive scope unmounts plugin tools before any call; the strip cell reads `unmounted` and the fixture's spy sees zero calls
- [ ] A find returns a table whose rows are classified through `Discover`: a filed row is greyed, a held one offers File here, an unknown one Add (and Add and file here with a space in scope), a dismissed one is hidden and counted
- [ ] Add creates the record through `resolveEntity`, files it when chosen, and the row reads "added · enriching" until the job settles; no deal is created
- [ ] Dismiss writes the (space, domain) dismissal; the same domain never appears in a later find or watch for that space
- [ ] Find companies on a space head opens the dock with the space and web chips and the criteria prefilled
- [ ] `ai_usage` attributes the turn's plugin calls to the integration
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On Property ops press Find companies: the dock opens scoped to the space and the web, the criteria prefilled; the table lists fourteen operators, Leasewise greyed, Keyhold offering File here; Add two, dismiss one, and the two are filed and enriching.

**Sheets** — Enrichment + Exa — printed, sheet 04 (Find in Ask: the results table; the Find companies button); Ask — printed, sheet 01 (web chip). **Spec** — D77 (Find lives in Ask; results as a table; fast search for a question); D72 (Ask mounts a plugin's MCP server); D53; D70

#### `ask-8b` · afk · M — Save as watch — a turn becomes a weekly watch on a space, and its untouched results become cards (D77)

**Blocked by:** `ask-8a`, `watch-4`

_Added 2026-10-09 (D77): the second half of the old `ask-8`, after the Watching lane exists._

**What to build**

**Save as watch** on a Find turn turns the question into a `space_watch`. **It needs a space:** the scope's space is preselected; from a turn with none, a picker asks which space and offers to create one named from the question. It opens a window prefilled from the turn — engine, name, **Look for** (the question; blank when it equals the space's criteria), **How often** (**Weekly** when saved from Ask; Manual stays first in the list), **At most** per run — and Save writes the row, creating the webset on its first run (`watch-5`). **The turn's results are carried, not repeated:** rows added are already members, rows dismissed are dismissals, and **rows left untouched become `add_record` cards** in Review under the space. The thread keeps a line linking to the watch ("Saved as a watch on Property ops"), which says so if the watch is later deleted. The same space, engine and settings is refused as **"Already watching this"** (D72's unique index) and opens the existing watch instead.

**Acceptance criteria**

- [ ] Save as watch from a scoped turn preselects the space; from an unscoped turn it asks for one and can create a space named from the question
- [ ] The window is prefilled; How often defaults to Weekly here and Manual on the space page (`watch-4`)
- [ ] Saving writes one `space_watch`; the turn's untouched rows become `add_record` cards under the space, added rows create nothing new, dismissed rows stay dismissed — asserted on a fixture turn with all three
- [ ] The thread shows "Saved as a watch on <space>" linking to it, and "watch deleted" after it is removed
- [ ] Saving the same space, engine and settings again opens the existing watch with "Already watching this" and writes nothing
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — After finding operators in Pune, Save as watch: the window reads Property ops, Weekly, at most 25; save, and the nine rows you did not touch wait in Review under Property ops while the thread links to the new watch.

**Sheets** — Enrichment + Exa — printed, sheet 04 (the Save as watch window). **Spec** — D77 (Save as watch; consolidation by result); D72 (`space_watch`, the unique index)

---

## 25. Email — viewed, shared, tracked, composed

_Spaces v1 · 9 slices · added 2026-10-06, bodies 2026-10-06, amended 2026-10-09_

_Amended 2026-10-09 (D67 amended 10-08): `email-1` renders inline `cid:` images; `email-6` carries Bcc, never linked to records. The canvas is Email — printed, sheets 00–05._

D67's surface over `arrival-10`'s sync: the email stored rather than only its text, attachments as documents, the three privacy layers through `canRead`, interaction stats as read-only view columns, drafts, send through Gmail, variables and the `email` template kind. The canvas is Surfaces **E1–E8** (interactions ledger, viewer, inline draft, compose and review, drafts, templates, Team panel, person field editors), re-read 2026-10-06 against the Separation Rule; the Interactions tab lives in the D74 record body (**O1** shows it open).

### ▸ The email itself

_Headers, the raw MIME as a blob, a sanitized HTML viewer in a sandboxed iframe, attachments through the artifact join, list rows with summary and labels as cached display text, deep links._

#### `email-1` · afk · M · migration — `interaction.meta` email shape, the MIME blob, the viewer (D67)

**Blocked by:** `arrival-10`, `interaction-1`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-09 (D67 amended 10-08): **inline images carried inside the stored MIME (`cid:` parts) render** in the viewer — showing them loads nothing. Remote images still never load; the viewer counts them ("2 remote images not loaded") and keeps each at its size with a dithered placeholder. `meta` carries `bcc` on a sent email (`email-6`)._

**What to build**

Store the email, not only its text. The Gmail syncer and the forwarding lane both write the email shape of `interaction.meta` (`interaction-1`): `from`, `to`, `cc`, `date`, and `mime_sha`, the content-addressed blob of the raw MIME written through the blob backend (`packages/core/src/writes/storage/`) — the migration here is the `blob` reference the sha needs if the blob table's refcount is a column, else none; the slice carries the label so the journal is serialised either way. The viewer (**E2**) renders the HTML part sanitized (DOMPurify server-side, remote images blocked, links rewritten to open in a new tab) inside a sandboxed iframe with no scripts and no form submission; the plain-text part is the fallback; the body note stays the searchable, AI-readable text and is unchanged. The viewer opens from the Interactions tab row and from `?modal=email&id=` (D74), 48px bone head with subject and date, the participants row, the body, and the artifacts (`email-2`) below.

**Acceptance criteria**

- [ ] Both lanes write `meta` with the four header fields and the MIME sha; the raw MIME is a blob keyed by its sha and shared when two mailboxes hold the same message
- [ ] The viewer's iframe is `sandbox` with no scripts, no forms, no remote images; a fixture with a tracking pixel and a script renders neither — asserted on the sanitized output
- [ ] A `cid:` image in the MIME renders inline from the stored parts; remote images are counted in one line and each keeps its size as a placeholder
- [ ] Links open in a new tab with `rel="noopener"`; `mailto:` links open the composer (`email-6`) when it exists, else nothing
- [ ] `?modal=email&id=` opens the viewer over the Interactions tab; one close in the foot, nothing printed
- [ ] The body note is unchanged by this slice — search and the assembler read what they read before
- [ ] Gate 5 passes; E2's head and participants row are followed
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a synced email from a company's Interactions tab: the HTML renders with its formatting, the tracking pixel never loads, and the raw MIME is one blob even though two partners' mailboxes hold the thread.

**Sheets** — Email — printed, sheets 01 (rows) and 02 (viewer window: inline chart, blocked signature logo); Surfaces E1, E2. **Spec** — D67 (store the email; inline images, amended 10-08); D74 (deep links)

#### `email-2` · afk · M — Attachments are documents on the artifact join; the Files preview opens them; "has attachments"

**Blocked by:** `email-1`

**What to build**

The forwarding lane already files attachments through storage-6a's arrival module; this slice makes every attachment, synced or forwarded, a document on `interaction_document` with `role: attachment` (`interaction-1`), filed on the email's participant records exactly as a transcript is. The viewer lists them under the body with the kind glyph, name, size and the mark of the lane that brought them; a click opens the Files preview dialog, not a download. The Interactions ledger (**E1**) shows the attachment count in the row's mono end lane and gains "has attachments" in its filter row. The Files tab of each participant record lists the attachment with `via <email subject>` as its provenance line.

**Acceptance criteria**

- [ ] A synced email with two attachments produces two document rows joined with `role: attachment`, filed on each participant record, and storage-6a's single-writer grep test still passes
- [ ] The same attachment on a thread both forwarded and synced is one document — dedupe on the sha
- [ ] The viewer opens an attachment in the Files preview; the Files tab lists it with its email as provenance
- [ ] The ledger row shows the count; the "has attachments" filter compiles to an exists over the join
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — A founder's email arrives with a deck: the email row shows `1`, the viewer lists the deck, the company's Files tab has it with "via Re: Seed round", and the preview opens it.

**Sheets** — Surfaces E1, E2, S1 (Files tab row). **Spec** — D67 (attachments are documents); D68 (one meeting, many artifacts)

#### `email-3` · afk · M — List rows, kind filters, summary and labels cached under the sensitivity gate, `?modal=email`

**Blocked by:** `email-2`, `ai-15`

**What to build**

The Interactions tab as **E1** and **O1** draw it: a 36px filter row under the tab head — All · Email · Meeting · Call, with "has attachments" — and 40px rows: kind glyph, subject in ink, participants in graphite, the one-line summary clamped at two lines with the Gmail `snippet` as the unmarked fallback, attachment count, category labels as chips, `via <mailbox owner>` and the date in the mono end lane. Summary and labels are derived display text: the summarize and classify lanes write them to `interaction.meta.summary` and `meta.labels` under the sensitivity gate (local or skipped for a sensitive record), rebuildable like embeddings by a backfill job, never a proposal and never an attribute. The ledger reads through the shared statement in `@spaces/core/writes/read` so Ask's `search_records` and the tab agree.

**Acceptance criteria**

- [ ] The filter row narrows by kind and by attachments; the count in the tab head follows the filter
- [ ] A row with no summary shows the snippet with no mark; a row with a summary shows it clamped at two lines
- [ ] Summary and labels are written by the lanes under the gate: a sensitive record's email is summarised locally or left blank, asserted on the route
- [ ] A backfill job rebuilds summaries for emails that lack them and never rewrites one a lane already wrote
- [ ] `?modal=email&id=` from Today or a search hit opens the viewer over this tab with the row highlighted
- [ ] Gate 5 passes; the filter row is 36px, rows 40px, the end lane mono
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a company's Interactions tab, filter Email, see each thread's summary and labels, click one: the viewer opens with the row still highlighted behind it.

**Sheets** — Surfaces E1, O1 (Interactions tab open). **Spec** — D67 (list rows; summary and labels are derived display text); D74

### ▸ Who may read it

_Synced mail private to its mailbox owner, forwarded mail shared, a per-record override and per-email grants; subject, participants, date and owner always visible; interaction stats maintained by the writer and read by views._

#### `email-4` · afk · M · migration — Interaction stats — first, last, next per entity and kind, written in the writer's transaction, read-only view columns (D67)

**Blocked by:** `interaction-1`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-10 (pre-check against main `3397486`): the `ENTITY_REFS` vocabulary is `repoint` | `repoint-or-drop` | `custom` | `none` for merge plus a `del` kind and `context: null` — the recompute-from-both-sides is `custom` with its section and snapshot in `merge.ts`, delete is `del: 'cascade'`. The `any` kind is not in `interaction_kind`: store `kind` as a text column on `interaction_stat` (the enum values plus `'any'`). Runs before enrich-5, which edits the same table and list files._

**What to build**

A derived table, `interaction_stat(entity_id, kind, first_id, first_at, last_id, last_at, next_id, next_at)`, one row per entity per kind plus `any`, with an `ENTITY_REFS` entry (`cascade` on merge — the winner's stats are recomputed from both sides — and `none` for context). The interaction writer (`packages/core/src/writes/interactions/write.ts`) updates it in the same transaction as every interaction insert, update and cancellation; a meeting with `status: cancelled` leaves `next`. `next` is the earliest future meeting and fills once calendar sync lands. The views compiler learns the columns as read-only — sortable and filterable, never editable, not in `entity.values` — and the people and companies tables offer them as columns (Last contact, Last email, Next meeting), which is also what the readout strip on **O2** reads.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name interaction_stat`, SQL hand-inspected, primary key `(entity_id, kind)`; `ENTITY_REFS` carries `interaction_stat.entity`
- [ ] Every writer path updates the row in the writer's transaction; a rolled-back interaction leaves the stats as they were
- [ ] A cancelled meeting is excluded from `next`; the next uncancelled one takes its place
- [ ] Merging two companies recomputes the winner's row from both histories, asserted through the merge snapshot
- [ ] Views sort and filter on the three columns; the EXPLAIN assertion shows an index on `(entity_id, kind)` used
- [ ] O2's readout strip reads Last contact, Last email and Next meeting from this table
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Sort People by Last contact and see the quiet ones at the bottom; log a call with one of them and watch the row move.

**Sheets** — Surfaces O2 (readouts). **Spec** — D67 (interaction stats); `apps/web/src/lib/views/`

#### `email-5` · hitl · M — Privacy, three layers — owner default, record override, per-email grants, through `canRead`

**Blocked by:** `email-1`, `arrival-10`

**What to build**

D67's three layers, enforced at read time as an extension of note visibility in `packages/core/src/read-policy.ts` (`canRead`) and its SQL twin `canReadNoteSql`. Layer one: a synced email's body, attachments and summary are private to the mailbox owner (`mailbox.user_id` through `source_ref`); a forwarded email stays shared (D49). Layer two: a per-record override — "my emails with Flent are visible to the workspace" — as a row `email_visibility(entity_id, user_id, scope: workspace)` the owner sets from the record's Interactions tab head. Layer three: per-email grants to named users, `email_grant(interaction_id, user_id)`, from the viewer's privacy row ("visible to: you · widen"). Subject, participants, date and mailbox owner are always visible, so the ledger row renders for everyone and the body refuses. `hitl` because the two tables are a migration on a policy the owner must read once more against CONTEXT.md's privacy line before it is enforced, and because the widen control is the one place the product says who can see what.

**Acceptance criteria**

- [ ] The decision is quoted in CONTEXT.md §"Privacy default" from D67 in the same PR, with the two override tables named
- [ ] A non-owner opening a synced email sees subject, participants, date and owner and is refused the body, attachments and summary — asserted on the timeline, Cmd-K, the assembler and the MCP tools separately
- [ ] The record override makes every email the owner has with that record readable workspace-wide; removing it restores privacy without touching grants
- [ ] A per-email grant opens one email to one user and nothing else
- [ ] `canRead` and `canReadNoteSql` agree on every case in a shared table-driven test
- [ ] The privacy row reads "visible to: you · widen" and the widen dialog is one close, no sentence about what privacy is
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Two users, one synced mailbox: the second sees the thread's subject on the company but cannot open it; the owner widens it for the record, and the second can.

**Sheets** — Surfaces E2 (privacy row). **Spec** — D67 (privacy, three layers); D49; `packages/core/src/read-policy.ts`

### ▸ Writing one

_Drafts author-private and local, four modes with threading headers, recipients over people and aliases, variables as paths shared with AI prompts, the `email` template kind, send through Gmail so replies thread and land in Sent._

#### `email-6` · afk · M · migration — `email_draft` — new, reply, reply-all, forward; recipients over aliases; autosave (D67)

**Blocked by:** `email-1`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-09 (D67 amended 10-08): a draft carries **To, Cc and Bcc**. Cc and Bcc open from the address block and stay closed when empty; a Bcc chip reads as hidden. Bcc recipients are never linked to records the way To and Cc are, so a Bcc stays hidden everywhere — on the sent interaction, in participants and in interaction stats._

**What to build**

`email_draft(id, user_id, mode, in_reply_to_id, to jsonb, cc jsonb, bcc jsonb, subject, body_md, attachments jsonb, updated_at)`: author-private, local only, never synced to Gmail drafts. Modes are new, reply, reply-all and forward; reply modes carry `in_reply_to_id` so send (`email-7`) sets `In-Reply-To` and `References` from the parent's `meta`. The composer (**E3** inline under a thread, **E4** full) is the dialog grammar: recipients as chips searched over people and their email aliases, the chip picking which alias, a new address accepted and passed through the participants module at send; subject; the body editor; attachments from the record's documents or an upload. Autosave on a debounce; the drafts count in the account menu (**E5**) opens the drafts list; Trash deletes the row. The one printed key is ⌘↵ inside the body to send.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name email_draft`, SQL hand-inspected; drafts are listed only for their author
- [ ] Reply and reply-all prefill recipients from the parent's `meta` (reply-all minus the user's own aliases); forward prefills nothing but the quoted body and the attachments
- [ ] Recipient search matches people by name and by alias; choosing a person with two aliases offers the pick on the chip
- [ ] Cc and Bcc open from the address block and are closed when empty; a Bcc recipient is never written to `interaction_entity` or the stats when the email is sent, asserted through `email-7`'s writer fixture
- [ ] Autosave writes after the debounce and never on every keystroke; closing and reopening restores the draft
- [ ] Trash deletes the row; the account menu's count follows
- [ ] Gate 5 passes; E3 and E4 are followed, ⌘↵ is the only printed key
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Reply to a founder from the viewer: recipients are prefilled, type three lines, close the dialog, see "1 draft" in the account menu, reopen it and the text is there.

**Sheets** — Email — printed, sheets 03 (reply all, forward), 04 (new email with Bcc open), 05 (drafts); Surfaces E3, E4, E5. **Spec** — D67 (drafts; recipients; Bcc, amended 10-08)

#### `email-7` · afk · M — Send through the Gmail plugin with `gmail.send`; the outgoing interaction at once; Message-ID dedupe

**Blocked by:** `email-6`, `arrival-10`

_Amended 2026-10-09 (D67 amended 10-08): send puts the draft's Bcc on the outgoing message; the outgoing interaction keeps it in `meta.bcc`, shown only as hidden chips, and it never reaches the participants (`interaction_entity`) or the interaction stats — a Bcc recipient is linked to no record._

**What to build**

Send is a job on the Gmail plugin — an `action` whose `uses` include `Http` and `Content` — called from the composer's server fn with the draft id. The plugin builds the MIME (threading headers from the parent, attachments from the blob backend), sends through `users.messages.send` with `gmail.send` (D66's scope line), and the host writes the outgoing interaction at once through the interaction writer with the returned Message-ID as `message_id`, `source_ref` the integration, participants resolved, and the draft deleted in the same transaction. When sync later sees the sent message, `interaction_message_id_unique` dedupes. A connection without `gmail.send` makes the Send button absent and the composer say which product needs reconnecting, through **C1**'s connection row; a transient failure keeps the draft and shows the provider's error text.

**Acceptance criteria**

- [ ] Send through the fake Gmail provider produces one outgoing interaction with the provider's Message-ID, the participants resolved, and no draft row
- [ ] A later sync of the same message is a no-op on `message_id`
- [ ] Reply threading: the sent MIME carries `In-Reply-To` and `References` from the parent; the fake asserts the headers
- [ ] A connection lacking `gmail.send` hides Send and names the product to reconnect; a 5xx keeps the draft and surfaces the provider's text
- [ ] Attachments are read from the blob backend and attached once; a 25 MB total refuses before the call with the limit named
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Reply from Spaces against the fake: the reply lands in the thread on the company at once, and when the sync runs it does not double.

**Sheets** — Surfaces E4, C1. **Spec** — D67 (sending); D66 (scopes)

#### `email-8` · afk · M — Variables as paths, resolved per recipient with blanks flagged; the `email` template kind

**Blocked by:** `email-6`

**What to build**

One variable grammar for email and AI prompts: `{{name.first}}`, `{{company.name}}`, `{{last_interaction.when}}`, resolved by one resolver in `packages/core/src/` over the record's values, D60's references and `email-4`'s stats, shared with `ai-15`'s prompt templates. The composer resolves per recipient in a Review step (**E4**'s second stage): a table of recipients × variables, blanks flagged in the row, send disabled until each is filled or the blank accepted. `template_kind` gains `email` — `{subject, body, attachments}`, favouritable — chosen from the composer's template picker (**E6**), which is the existing templates component with the new kind.

**Acceptance criteria**

- [ ] The resolver is one module used by both the composer and the prompt templates; a path an attribute slug does not match is refused naming it
- [ ] Review resolves every variable per recipient and flags blanks; Send is absent while a blank is unaccepted
- [ ] `email` templates save, favourite and apply into a draft with subject, body and attachments
- [ ] Migration for the enum value: `pnpm db:generate --name template_kind_email`, SQL hand-inspected — carried here, one value
- [ ] Gate 5 passes; E4's review table and E6's picker are followed
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Pick the "intro" template, add three founders, Review shows one with no first name flagged, fill it, send: three threads, each personalised.

**Sheets** — Surfaces E4 (review stage), E6 (templates). **Spec** — D67 (variables as paths; the `email` template kind)

#### `email-9` · afk · S · migration — Name parts and `canonical_name` as their join; `phone` as E.164 with `multi` (D67)

**Blocked by:** `graph-1`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-10 (pre-check against main `3397486`): there is no `name` attribute — `canonical_name` is an entity column outside the attribute engine. So "`name` becomes two attributes" means: `first_name` and `last_name` are new system attributes on person, and `setValues` keeps the `canonical_name` column equal to their join (a rename through `renameRecordProgram` splits back into them). `phone` is `z.string().max(40)` today with no `multi`; this slice adds E.164 validation and `multi` support to the engine._

**What to build**

Two attribute shapes on the person object. `name` becomes two system attributes, `first_name` and `last_name`, and `canonical_name` is their join kept in sync by `setValues` (a write to either part rewrites the name; a write to the name splits on the last space into the parts, which the field editor on **E8** shows live as the user types). A data migration splits existing names the same way and its journal `when` is the clock at write time. `phone` validates as E.164 in the attribute engine's validators and takes `multi: true` as config; the editor (**E8**) formats on blur and refuses a non-number naming the expected shape. Email addresses stay the identity aliases, shown as one multi-value field.

**Acceptance criteria**

- [ ] `first_name` and `last_name` are seeded insert-if-absent; the migration fills them from `canonical_name` for every person and leaves names it cannot split as `first_name` only
- [ ] Writing either part rewrites `canonical_name`; writing the name rewrites the parts — asserted through `setValues`
- [ ] `phone` refuses a non-E.164 value at the boundary with the shape named; `multi` is honoured by the editor and the view column
- [ ] Import maps First name and Last name columns onto the parts and a Name column onto the join
- [ ] Gate 5 passes on E8's editors
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a person: the head shows the joined name; edit the first name and the head follows; add a second phone and both show, formatted.

**Sheets** — Surfaces E8 (person field editors). **Spec** — D67 (attribute shapes); `packages/core/src/attributes/registry.ts`

---

## 26. Relationships, and what a newer file supersedes

_Spaces v1 · 7 slices · added 2026-10-06, bodies 2026-10-06_

The attribute engine's second pass (D69) and the one relation nothing writes (D59). A relationship is a pair of `record_reference` attributes stored once on the owning side with a derived inverse; views compile the inverse; edits widen and never narrow; system attributes are never archivable. Then `supersedes` written by verbs — demote, the upload picker, the intake suggestion — and never picked as a relation. `graph-1` (Corrections) is the first pair and must land first. The canvas: Surfaces **R1 · R2** (the attributes ledger with relationships, the relationship dialog and widen), **O1–O4** (the details column's relationship sections), **S1–S3** (Files rows and menus).

### ▸ A relationship is a pair

_The Relationship dialog names both sides; the owner holds the value; one resolver serves rail, views, variables and the assembler._

#### `rel-1` · afk · M — The pair — `options.inverseOf`, owner-side writes from either side, cardinality in `setValues` (D69)

**Blocked by:** `graph-1`

**What to build**

A relationship is two `record_reference` attribute rows, one per object, joined by `options.inverseOf` (the other attribute's id) and `options.cardinality` (`1:1` | `1:N` | `N:1` | `N:N`), created together by one server fn from the Relationship dialog (**R2**): object A, attribute name on A, object B, attribute name on B, cardinality. The owner is the "many" side for N:1 and 1:N, holding a single reference; the side the dialog was opened from for N:N and 1:1. The inverse row is a real attribute — it appears in the ledger (**R1**) with its pair named — but it stores nothing: `setValues` on the inverse side is rewritten into `setValues` on the owner (one event, one history), and cardinality is enforced there: single versus multi on the owner, inverse uniqueness for 1:1 (refused naming the record that already holds it). `SYSTEM_ATTRIBUTES` declares the pairs for D60's `companies` ↔ company `team` so the seed makes them.

**Acceptance criteria**

- [ ] The dialog creates two attribute rows in one transaction with `inverseOf` pointing at each other and the cardinality on both; deleting one is refused while its pair exists
- [ ] A write on the inverse side becomes one `setValues` on the owner: one `attribute_event`, one `references` link; the inverse side has no `values` entry
- [ ] 1:1 refuses a second owner naming the holder; N:1 refuses a multi value on the owner
- [ ] `companies` ↔ `team` is declared in the registry and seeded insert-if-absent; the seed is idempotent
- [ ] Gate 5 passes on R2
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Make "Fund ↔ Portfolio company" N:N from the funds object: both ledgers show the pair; add a company from the fund's side and the company's values hold the fund with one history event.

**Sheets** — Surfaces R1, R2. **Spec** — D69 (a pair of attributes; the value is stored once; cardinality in `setValues`)

#### `rel-2` · afk · M — The inverse resolver — rail, variables, assembler read the `references` links

**Blocked by:** `rel-1`

**What to build**

One resolver in `packages/core/src/` answers "what references this record through attribute X" by reading the `references` links `setValues` already writes (`link_to_idx`), so the inverse side is derived everywhere: the details column's relationship sections on **O1–O4** (Team, Associated deals, Deals, Portfolio), the record's property rows for an inverse attribute, `email-8`'s variable paths, and the context assembler's walk, which already follows `references` at weight 1 and now labels the item with the inverse attribute's name. `get_record` on the MCP surface returns inverse attributes under their own slug, marked derived, so Ask reads both sides.

**Acceptance criteria**

- [ ] The resolver returns the referencing records for an inverse attribute with one query per record, not one per attribute
- [ ] O1's Team, O3's People and O4's Portfolio sections read through the resolver and show the same rows from either side
- [ ] A variable path through an inverse attribute resolves; the assembler's context item names the inverse attribute; `get_record` lists it marked derived
- [ ] Merge, delete and import are unchanged — asserted by the existing merge snapshot and an import of a pair column
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a company: Team lists the people whose `companies` holds it; open one of them: Companies lists the company; ask Ask "who is on Halcyon's team" and the answer cites both.

**Sheets** — Surfaces O1–O4 (relationship sections). **Spec** — D69 (the inverse reads the `references` links; one resolver)

#### `rel-3` · afk · M — Views learn inverse attributes — link-join and count expressions, an index plan like `attr_idx_*`

**Blocked by:** `rel-2`

**What to build**

The one new piece of work D69 names: `apps/web/src/lib/views/` compiles an inverse attribute as a link join — filter "Team contains X" becomes an exists over `link` with `attr_slug` and `to_id`; "Team count > 3" becomes a correlated count; sort on an inverse sorts by the count or by the first referenced name. The reconciler (`packages/db/src/value-indexes.ts`) learns a second index family for inverse attributes flagged filterable or sortable: an index on `link(to_id, attr_slug)` that is the same for every inverse, minted once rather than per attribute, and named so the EXPLAIN assertion can find it. `query_records` (`ask-1`) inherits the condition for free.

**Acceptance criteria**

- [ ] Filter, count and sort on an inverse attribute compile to one statement each; `value-index-plan.test.ts` gains a case asserting the link index is used
- [ ] The reconciler mints the link index once when the first inverse attribute is flagged and never duplicates it; dropping the flag on the last one drops it
- [ ] A saved view with an inverse column survives the attribute's rename
- [ ] `query_records` accepts an inverse condition with no code in `tools-read.ts`
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On Companies, add a Team column, filter "Team count ≥ 2", sort by it, save the view, and the EXPLAIN shows an index scan.

**Spec** — D69 (views learn inverse attributes); CLAUDE.md — `attr_idx_*` indexes are the reconciler's

#### `rel-4` · afk · S — Widening-only edits logged once; system attributes never archivable; Team, Associated deals, Deals become pairs

**Blocked by:** `rel-2`

**What to build**

Three rules from D69. Edits widen only: single → multi and `select` → `multi_select` are allowed as a reshape that wraps every stored value in one UPDATE and writes one `attribute_event` on the attribute, not one per record; narrowing is refused naming the attribute. System attributes are never archivable — the archive action is absent on them in the ledger (**R1**) and refused at the server fn; user-created ones archive as before. The remaining shipped references become pairs through `rel-1`'s registry declaration: deal `company` (N:1) ↔ company `associated_deals`; deal `people` (N:N) ↔ person `deals`; so the details column's Associated deals and Deals sections read through the resolver and the hand-written readers go.

**Acceptance criteria**

- [ ] Widening wraps stored values in one statement and logs one event; a narrowing request is refused and writes nothing
- [ ] Archive is absent on system attributes in R1 and refused by the server fn; a user attribute still archives
- [ ] `company` ↔ `associated_deals` and `people` ↔ `deals` are declared and seeded; the hand-written readers for those sections are deleted and the sections render through the resolver
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Widen a company's "Lead investor" from single to multi: every record keeps its value as a one-element array and History shows one event on the attribute; try to archive Stage: there is no such action.

**Sheets** — Surfaces R1 (widen), O1 (Associated deals), O3 (People). **Spec** — D69 (edits widen only; system attributes never archivable; existing references become pairs)

### ▸ Nothing is deleted, something supersedes

_D59's build order._

#### `doc-1` · afk · S — Demote and the manual "supersedes" action write the link; both rows stay, older ranked lower (D59)

**Blocked by:** `docsurf-7`

**What to build**

The first writer and the ranker change. "Newer version of…" in a document's `···` menu (**S1**'s file row menu) opens the record's documents of the same kind as a picker; choosing one writes `link(supersedes)` newer → older. "Save as new version" on a note creates a new note that supersedes the old one through the same writer. The older item shows "Replaced by → …", dimmed, in its row and head; nothing is deleted and both stay searchable. The ranker (`packages/core/src/context/rank.ts`) demotes a superseded item: its candidate score is multiplied by a `superseded` factor beside `DEFAULT_WEIGHTS.edge`, and the snapshot shows the newer deck above the older.

**Acceptance criteria**

- [ ] The action writes one `supersedes` link and no other change; both rows and their chunks remain and search finds both
- [ ] The older row reads "Replaced by → <name>" dimmed; the newer reads nothing extra
- [ ] A note's "Save as new version" creates the new note with the link; the old note's rail shows the pointer
- [ ] The ranker demotes a superseded item below its successor under equal recency; snapshot updated
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Upload v3 of a deck, mark it the newer version of v2 from the menu: v2 dims with the pointer, both open, and Ask cites v3 first.

**Sheets** — Surfaces S1 (row menu). **Spec** — D59 (nothing is deleted; the verb is "Newer version of…"; the ranker demotes)

#### `doc-2` · afk · S — The upload picker offers "replaces …" over the record's documents

**Blocked by:** `doc-1`

**What to build**

The second writer. Uploading a document to a record that already holds one of the same `document_kind` offers, in the upload dialog's last step, an optional "Newer version of" select over those documents, defaulting to none. Choosing one writes the link through `doc-1`'s writer after the birth commits. The same control appears when a file arrives from Drive into a record (`storage-7`'s attach), as the one place the user decides.

**Acceptance criteria**

- [ ] The select appears only when a same-kind document exists on the record, defaults to none, and lists the candidates newest first
- [ ] Choosing one writes the link after the document row commits; a failed upload writes no link
- [ ] The Drive attach path shows the same control through the same component
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Upload a deck to a company that already has one: the dialog offers "Newer version of: Seed deck v2"; pick it and the old one dims at once.

**Sheets** — Surfaces S2 (upload dialog). **Spec** — D59 (at upload, optional)

#### `doc-3` · afk · S · migration — Intake suggests the supersession when a newer version arrives — a new `suggestion_kind`

**Blocked by:** `doc-1`. **Label:** `migration` — runs alone on the migration lane.

**What to build**

The third writer, and the only probabilistic one. `suggestion_kind` gains `supersedes`; intake (`packages/core/src/writes/documents/intake`) proposes it when a document of the same kind is filed against a record that already holds one, through `proposeProgram` so a repeat is a no-op, with both documents as refs and the newer's date in the rationale. Accept writes the link through `doc-1`'s writer; dismiss persists as a closed suggestion, and the partial unique index keeps it closed. Never written automatically: a wrong link hides true facts from the AI. Review renders it as a card with the two documents and the one pine "Mark as newer version".

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name suggestion_supersedes`, SQL hand-inspected: one enum value
- [ ] Filing a second deck on a record proposes one `supersedes` suggestion citing both; filing a third proposes one more against the latest, not two
- [ ] Accept writes the link and closes the suggestion; dismiss closes it and a re-intake of the same pair proposes nothing
- [ ] No code path writes `supersedes` without a user action — a test greps the writers
- [ ] Gate 5 passes on the card
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Forward an email with a newer deck attached: Review offers "Seed deck v3 is a newer version of v2?"; accept, and v2 dims on the company's Files tab.

**Sheets** — Surfaces R1 (card). **Spec** — D59 (suggested at intake; never written automatically)

---

## 27. Instrument, printed — the decided design lands

_Design port · 13 slices · written 2026-10-09_

The canvas pass of 2026-10-07 → 10-09 closed with the owner's verdicts: "Instrument, printed" adopted whole (double rule, ink stamp, real tabs, dither as data and as popover elevation), sidebar A with a collapsible Library group (D68 amended), Settings grouped by whose it is (D81), Today as the one attention surface (D79) and a first run without a checklist (D80). None of it is code yet. This project ports it: the kit first, because every later surface draws with it; then the shell; then Settings, Today and the first run. No slice here runs `db:generate`. The Ask panel's placement is `ask-5`'s (amended) and the Meetings page is `arrival-12`'s; this project only leaves them their rows.

### ▸ The printed kit

_A page head prints its double rule and its stamp, a tab bar has real tabs, a menu lifts on a dithered shadow while a dialog lifts on a solid one, and a long page's head folds to a 40px bar as you scroll — on every shipped route at once, because the primitives draw it._

#### `print-1` · afk · M — Printed primitives — the double rule, the ink stamp, real tabs

**Blocked by:** none

**What to build**

Three details from the Foundations direction sheet, each a primitive so no route spells it by hand. **The double rule** (2px ink, 2px gap, 1px ink) replaces the single hairline under `PageHeader` and `RecordHeader` (`apps/web/src/components/page-header.tsx`, `apps/web/src/components/record/record-parts.tsx`) — page and record heads only, never a section. **The ink stamp**: an ink label with cut ends (`COMPANY C-0231`, `SPACE · depth 2`), mono caps on hairline, one per page, beside the crumb; an archived record's stamp is the same shape in outline with its date. **Real tabs**: a new `Tabs` primitive in `apps/web/src/components/ui/tabs.tsx` — the open tab is paper with cut shoulders joining the body below it, the others sit on the bone bar, each with its mono count, empty ones graphite at 0 — the tab head D74's record body and the space page both need; `import-wizard.tsx`'s hand-built tablist moves onto it. The shapes go in `apps/web/src/styles.css` as named utilities (`double-rule`, `stamp`, `stamp-outline`) so gate 5 keeps working; a raw `clip-path` or border stack spelled in a route is what the utility exists to prevent.

**Acceptance criteria**

- [ ] Every `PageHeader` and `RecordHeader` draws the double rule; no section head, dialog or rail does — a render test asserts both
- [ ] `Stamp` renders the cut-end label; `archived` draws it in outline with the date; one per page, asserted on the record and the space head
- [ ] `Tabs` is keyboard-complete (←→, Home/End, `role="tablist"`, `aria-selected`), the open tab joins the body with no rule under it, and an empty tab stays visible at 0
- [ ] The import wizard's steps render through `Tabs` with no visual change beyond the tab shape
- [ ] No new type step or colour; the utilities live in `styles.css` and `instrument/vocabulary` passes
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Flent: the double rule under its name, `COMPANY` stamped beside the crumb. Archive a custom record: the stamp turns to outline with the day.

**Sheets** — Foundations "Instrument, printed — direction 10-07" (01 double rule, 02 stamp, 03 tabs); "Spaces — printed" 01. **Spec** — `DESIGN.md` §1, §4 (the printed details); `docs/design-contract.md` §1

#### `print-2` · afk · S — Elevation by kind — dithered under a popover, solid under a window

**Blocked by:** `print-1`

**What to build**

Today every lifted sheet takes a hard offset shadow: 2px for popovers (`apps/web/src/styles.css`, the BlockNote and picker rules), 3px for dialogs (`apps/web/src/components/ui/dialog.tsx`). The verdict splits them by what they are. **A popover, menu, picker or palette** (no scrim) lifts on a 4px 1-bit ink shadow at Bayer 8/16 — the same 4×4 matrix `apps/web/src/components/dither.tsx` already uses, exported as an SVG data-URI utility `shadow-dither` rather than a second generator. **A dialog or window** (over the scrim) keeps a solid ink offset, because dither under a scrim nearly vanishes. The rule lives in the primitives: `Popover`, `DropdownMenu`, `Select`, `command.tsx` and the BlockNote menus take `shadow-dither`; `DialogContent` and the confirm keep the solid shadow. No call site passes a shadow.

**Acceptance criteria**

- [ ] `shadow-dither` is one utility in `styles.css`, generated from the Bayer table in `dither.tsx`, never hand-drawn per site
- [ ] A test lists the primitives and asserts which shadow each draws: popover-kind → dithered, window-kind → solid; a `shadow-[…]` in a route fails gate 5
- [ ] The dither is never under text — the sheet's paper covers it, and the shadow sits outside the 1px ink edge
- [ ] Reduced motion is unaffected (the shadow never animates)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open a row's `···` menu: it lifts on a dithered shadow. Open Record a mark: the dialog sits on a solid one over the scrim.

**Sheets** — Foundations "Instrument, printed — direction 10-07" (04 dither is data); "Cmd-K — printed" K1. **Spec** — `DESIGN.md` §4 Depth, the Dither Rule; the elevation rule agreed 2026-10-08

#### `print-3` · afk · S — The sticky head — a page or record head folds to a 40px bar on scroll

**Blocked by:** `print-1`

**What to build**

On a page or record taller than the viewport, the head folds to one 40px bar once its title scrolls out: the title at the ui step in serif, the stamp, and the head's own actions with their key hints; the readout strip and the double rule leave with the rest. An `IntersectionObserver` on the title flips a data attribute; the bar is always mounted and enters on `transform`/`opacity` only (180/120ms), so nothing below it moves (the No-Shift Rule) and reduced motion simply shows or hides it. It sits on `z-sticky` and isolates like the record table's head. `PageHeader` and `RecordHeader` own it; no route opts in.

**Acceptance criteria**

- [ ] Scrolling past the title shows the 40px bar with title, stamp and actions; scrolling back hides it — no layout shift, asserted by a test that the body's offset never changes
- [ ] The bar's actions are the head's own buttons (one hotkey binding, not two)
- [ ] Transform and opacity only; `prefers-reduced-motion` drops the transition
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Scroll Flent's Interactions tab: the head folds to a thin bar with "Flent", the stamp and Log interaction · Task · Move stage.

**Sheets** — "Shell — printed" 03 (list head and sticky record head). **Spec** — `DESIGN.md` §5 Interaction Engineering (No-Shift, Compositor); owner verdict 2026-10-08

### ▸ The shell

_The sidebar reads Today, Tasks, Spaces, then Library ▾ (Notes, Files), Objects ▾ with an inline "▸ 3 more", Capital ▸; five starred spaces under Spaces; Upload and Settings are icons on the account row; the active row is a tab cut into the page._

#### `shell-1` · afk · M — Sidebar A — the Library group, Documents becomes Files, overflow, starred spaces, the account row

**Blocked by:** `print-1`

**Chords** (D68 amended, 2026-10-09): Notes `G N`, Meetings `G E`, Files keeps `G L`; `G M` stays Mandate and `G F` Portfolio.

**What to build**

`NAV_ITEMS` (`apps/web/src/components/app-sidebar.tsx`) gains a fourth group, `library`, between `work` and `objects`: `NAV_GROUP_IDS = ['work', 'library', 'objects', 'capital']`. Work is Today, Tasks, Spaces; Library is Notes and Files. **Documents becomes Files**: the row's label, the route (`/files`, with `/documents` answering one 301 the way `review-1`'s `toReview` does, query string kept — Today's Unfiled cell links `?filed=unfiled`), the page title and every user-facing "Documents" string; the `document` table and code names stay. Library, Objects and Capital are collapsible headings (▾/▸, with the row count when folded), state per browser like table prefs. Custom objects past the first three fold into an inline `▸ n more` that expands in place — never a dropdown. **Starred spaces**: up to five under Spaces, then `▸ more`; a star toggles from the space head's `···`, kept per browser in localStorage beside table prefs (no table; it does not follow the user across devices, and that is accepted for now). Counts only on Tasks. The foot: the Upload row and the account menu's Settings become two icon buttons on the account row (tooltips "Upload", "Settings · G ,"); the menu keeps Keyboard and Sign out. The active row is a tab cut into the page edge: paper, its right edge crossing the chassis hairline so it joins the page (the No-Bar Rule still holds). The collapsed 48px chassis keeps marks only; the collapsed rail shows no group headings. The Ask row (`ask-5`) and Meetings row (`arrival-12`) are added by those slices — one row each.

**Acceptance criteria**

- [ ] `nav-grammar.test.ts` holds the four groups in order, the Library contents, and one chord per page; the Documents-on-`G L` test is rewritten for Files
- [ ] `/documents` and `/documents?filed=unfiled` redirect to `/files` with the query intact; no user-facing "Documents" string remains (grep in the PR)
- [ ] Library, Objects and Capital fold and remember per browser; a folded group shows its count
- [ ] Five starred spaces show under Spaces in star order, a sixth folds behind `▸ more`; unstarring from the head removes the row at once
- [ ] Upload and Settings are icon buttons with `aria-label`s on the account row; `G ,` still opens Settings
- [ ] The active row joins the page edge with no pine bar and no layout shift between rows
- [ ] The ⌘K Go list and the keyboard sheet follow the new `NAV_ITEMS` order with no edit of their own
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Fold Library and Capital; star Property ops from its head and see it under Spaces; press `G L` and land on Files; open an old `/documents?filed=unfiled` link and land on the same filtered list.

**Sheets** — "Shell — printed" 00 (sidebar A, with the owner's overflow notes), "Meetings + Granola — printed" 02 (Library ▾). **Spec** — D68 amended (Library group); `docs/design-contract.md` §3 "The nav grammar"; `apps/web/src/components/nav-grammar.test.ts`

#### `shell-2` · afk · S — Pinned saved views under their object

**Blocked by:** `shell-1`

_Amended 2026-10-10 (pre-check against main `3397486`): `ViewBar` has no view menu — Rename and Delete are inline ghost buttons shown only when `canEdit`. This slice adds a small `···` on the view bar carrying Pin/Unpin for every readable view, with Rename and Delete moving into it when `canEdit`. The sidebar has no read of views per object; add one server read (id, name, object, visibility) for the pinned ids so pruning can run._

**What to build**

A saved view (`view` table, `packages/db/src/schema/views.ts`) can be pinned from the `ViewBar`'s view menu; pinned views list under their object's row in the sidebar, indented one step, at most three per object then `▸ n more`. The pin is per browser in localStorage keyed by view id, like starred spaces, so no schema; a pinned id whose view was deleted or became unreadable drops silently on the next render. The row links to the object list with the view selected (`?view=`), the same URL `useViewState` already reads.

**Acceptance criteria**

- [ ] Pin/unpin from the view menu; the sidebar shows pinned views under their object in pin order, three then a fold
- [ ] A deleted or private-to-someone-else view never renders and is pruned from storage
- [ ] The row's link opens the list with that view applied, round-tripping through `useViewState`
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Pin "Seed, India" on Companies; it appears under Companies and opens the filtered list in one click.

**Sheets** — "Shell — printed" 00. **Spec** — owner verdict 2026-10-08 (pinned views approved); `apps/web/src/components/views/`

### ▸ Settings by whose it is

_Settings takes over the sidebar with You, Workspace, AI and Integrations; a toggle saves itself, typed fields share one Save bar; a member opens Models and reads it instead of a locked page; your accounts are filed by what they do; Plugins is a catalogue._

#### `settings-1` · afk · M — The settings IA — four groups, new paths, settings takes the sidebar

**Blocked by:** `shell-1`

**What to build**

`SETTINGS_GROUP_IDS` (`apps/web/src/components/settings/settings-nav.tsx`) becomes `['you', 'workspace', 'ai', 'integrations']` with crumbs You · Workspace · AI · Integrations, and `SETTINGS_SECTIONS` takes D81's list. Paths follow the labels, because the path is what a person reads and pastes: `/settings/general` (was `workspace`, gains Base currency from `/settings/currency`), `/settings/models` (Providers and Routing from `ai.tsx`), `/settings/search` (was `embeddings`), `/settings/usage` (keeps its path; label "Usage & limits", Caps moves here from `ai.tsx`), `/settings/email-forwarding` (was `arrival`), `/settings/plugins` and `/settings/plugins/$integrationId` (was `integrations`), `/settings/connection-apps` (the OAuth clients, split out of `connections.tsx`). Every old path answers one redirect, as `review-1` did. You holds Connections and API tokens until `settings-3` replaces Connections. Settings takes over the sidebar: on `/settings/*` the chassis shows `‹ Settings` (back to the last app page, `esc` too) over the settings nav, instead of the two navs side by side; below `md` the strip behaviour stays. The Enrichment row arrives with the D76 enrichment-page slice, one row.

**Acceptance criteria**

- [ ] `settings-nav.test.ts` holds the four groups, their order and one path per row; every row's eyebrow is its group's crumb
- [ ] Each old path (`workspace`, `ai`, `embeddings`, `arrival`, `integrations`, `integrations/$id`, `currency`'s base-currency block) lands on its new home, asserted per path
- [ ] Models shows Providers and Routing; Usage & limits shows the run log and Caps; General shows Base currency; Currency & FX shows rates only
- [ ] Connection apps lists the OAuth clients for an admin; Connections no longer draws them
- [ ] On a settings route the chassis is the settings nav with `‹ Settings`; `esc` returns to the page settings was opened from
- [ ] `pnpm generate-routes` run; full gate pass: typecheck, test, lint, prettier

**Demo** — Press `G ,`: the sidebar becomes You · Workspace · AI · Integrations. Open an old `/settings/embeddings` bookmark: you are on Search. `esc` returns you to Flent.

**Sheets** — "Settings — printed" 00 (the map and the nav), 01 (General in the shell), 08 (Connection apps, Currency & FX). **Spec** — D81; `docs/design-contract.md` §3 "A settings section"; `apps/web/src/components/settings/settings-nav.test.ts`

#### `settings-2` · afk · M — One way to save, confirms where it breaks something, members read admin pages

**Blocked by:** `settings-1`

_Amended 2026-10-10 (pre-check against main `3397486`): the per-block Save buttons to remove are more than the three named — also `integration-settings.tsx` (Save settings, Save auto-enrich, Save key), `embeddings-section.tsx`, `currency.tsx` and `workspace.tsx` (General after settings-1). Confirmed present: `SettingsSection`/`SettingsRow`, `useConfirm`, `lib/members/suspend.ts`, the nav `admin` lane, the member-empty loader in `ai.tsx`._

**What to build**

Four page behaviours D81 makes uniform, built into `SettingsSection` and `SettingsRow` (`apps/web/src/components/settings/settings-section.tsx`) so a page cannot opt out. **Saving**: a switch, checkbox or select writes at once with a toast; typed fields (names, hosts, ports, keys) register with a section-level form context, and one Save bar at the page foot — mono "n changes", Discard, pine Save `⌘↵` — appears only while one is dirty. The per-block Save buttons in `arrival-section.tsx`, `connections-section.tsx` (OAuth client) and the AI key editors go. **Confirms** through `useConfirm` on four acts that break something outside the page, each naming the consequence: revoking an API token, suspending a member, archiving an object, unticking an identity key. **Members read admin pages**: the loaders that return empty for a member (`settings/ai.tsx` and its siblings) call member-safe reads that return the same shapes with every secret redacted (`●●●● 7Hq2` becomes `set`), and the page renders with controls disabled under one line in the head, "Only admins can change this · ask <admin names>"; the nav drops the `admin` lane lock. Write server fns keep `requireAdmin()` unchanged. **No footer caption strips**: the grey paragraphs at the foot of settings pages are removed; a line survives only for cost, privacy or irreversibility, beside its control.

**Acceptance criteria**

- [ ] Toggling a switch saves without a button; editing a text field shows the Save bar with the count, and Discard restores the stored values
- [ ] No settings page renders more than one Save control (a render test walks the routes)
- [ ] Each of the four acts asks first and names its consequence; Keep takes focus
- [ ] A member opens Models, Search, Plugins and Email forwarding and sees values with secrets redacted and every control disabled; a write attempt still refuses server-side
- [ ] No settings page ends in a caption paragraph (grep for the removed strings in the PR)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — As a member, open Models: the providers and routing read, nothing edits, the head says whom to ask. As admin, rename the workspace: the Save bar appears; toggle Secure on the mailbox: it saves alone.

**Sheets** — "Settings — printed" 01 (Save bar), 09 (asks and the member's view). **Spec** — D81 (saving, confirms, read-only members, no footer strips); `docs/design-contract.md` §1 The Commentary Rule

#### `settings-3` · afk · M — You, by job — Email & calendar, Files, Meeting notes, and an account page

**Blocked by:** `settings-2`

_Amended 2026-10-10 (pre-check against main `3397486`): `registry.json` is empty and no `gmail`, `calendar` or `box` plugin exists, so **Install ›** renders only when the registry has an entry for the provider; otherwise the row reads "Not available yet" to everyone. The manifest has no per-connection settings field — the account page renders the per-product choices block only when the plugin declares one (a later SDK minor); until then it is omitted. Disconnect revokes every time today (`lib/connections/custody.ts`), so the last-job rule is new work._

**What to build**

Connections becomes three pages under You, grouped by what an account does. The model underneath stays D66's: one `account_connection` row per (user, provider, product, account) with its own consent (`apps/web/src/lib/connections/products.ts`). That already makes "disconnect stops one job" true; what is new is the grouping and the last-job rule — disconnecting a product deletes its row, and the provider's revoke endpoint is called only when it was that account's last product row. **Email & calendar** (`/settings/email-calendar`): one row per provider account holding a `gmail` or `calendar` product, its products as words ("Mail · Calendar"), a Default mark on the account new email sends from (the earliest-connected mail account; choosing another needs a stored preference and is `email-7`'s, which is the first sender), sync state, `Options ›`; Connect Google / Connect Microsoft below; the workspace's Bcc address read-only with Copy and "Email forwarding ›". **Files** (`/settings/files`): storage accounts (`drive`, `box`, more than one allowed), each with its sync state and `Options ›`. **Meeting notes** (`/settings/meeting-notes`): recorder connections; the page renders empty until `arrival-6` lands Granola's key-based row. A provider whose plugin is not installed shows **Install ›** to an admin and "Ask an admin" to a member. **The account page** (`Options ›`): which products this account is used for (ticking one runs the incremental consent `storage-2b` already built), per-product choices that exist (calendars to sync, labels to skip — rendered from the plugin's per-connection settings when it declares them, else omitted), last sync, Sync now, Disconnect. `/settings/connections` redirects to Email & calendar.

**Acceptance criteria**

- [ ] A Google account with Gmail and Calendar rows shows once on Email & calendar; its Drive row shows on Files under the same email
- [ ] Disconnecting Drive deletes that row only and does not call Google's revoke while a Gmail or Calendar row for the account remains; disconnecting the last one revokes — both asserted against the fake IdP
- [ ] Ticking Calendar on the account page runs the incremental consent and adds the product row without re-granting Drive
- [ ] An uninstalled provider shows Install › to an admin and "Ask an admin" to a member
- [ ] `/settings/connections` redirects; API tokens is unchanged
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Connect Google for Gmail, then from Files connect Drive on the same account: one consent screen asks only for Drive. Disconnect Drive: Gmail keeps syncing.

**Sheets** — "Settings — printed" 05 (Email & calendar, Files, Meeting notes, the account page, API tokens). **Spec** — D81 (accounts by job; a connection per product underneath, Google's revoke when the account's last product goes); D66 (a connection per product); `apps/web/src/lib/connections/`

#### `settings-4` · afk · M — Plugins as a catalogue, and one page per plugin

**Blocked by:** `settings-2`

_Amended 2026-10-10 (pre-check against main `3397486`): `registry.json` is `[]`, so Available is empty in dev and the demo's "Airtable and RSS under Available" needs a registry entry the owner publishes; the slice proves Available with a test registry fixture. `registryEntrySchema` in `packages/sdk/src/pack/index.ts` is a strict object and must gain `roles` beside the manifest. A per-plugin page already exists at `settings/integrations_.$integrationId.tsx` (→ `plugins/$integrationId` after settings-1); rebuild it on the template rather than adding a second route._

**What to build**

`/settings/plugins` becomes Installed (the existing ledger, `apps/web/src/components/integrations/integration-ledger.tsx`: toggle, mark, name and version, its jobs, status and the one number that matters — credits, signals, people connected — and `Open ›` or `Update`) then **Available** from `registry.json` through `apps/web/src/lib/integrations/registry.ts`, with tabs by job and a count each. Jobs need a field the manifest lacks: `@spaces/sdk` gains an optional `roles` array (`enrichment` · `research` · `email-calendar` · `files` · `meeting-notes` · `import` · `feeds`) — a minor, as D39's `Import` port was — and the registry entry carries it so Available groups before install. **The plugin page** (`/settings/plugins/$integrationId`) is one template: status and version, the workspace key, what it sends out of the box (from the manifest's `requires`), the manifest settings form (`integration-settings.tsx`, unchanged), what it switches on — each a link to the page that owns that capability (Enrichment, Search, a space's Watching lane, Ask), never a copy of its settings — recent runs and errors from `job_run`, Disable and Uninstall.

**Acceptance criteria**

- [ ] `roles` validates as optional; a manifest without it still loads and lands under an "Other" tab only when one exists
- [ ] Available lists registry entries not installed, grouped by role tabs with counts; Install runs the existing installer
- [ ] Every installed plugin's page renders the same seven blocks; a capability block links to its owning page and holds no setting of its own
- [ ] Recent runs read `job_run` for that integration, newest first, with the provider's own error text
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Plugins: Apollo, Exa, Google installed; Airtable and RSS under Available's Import and Feeds tabs. Open Apollo: credits, what it sends ("domain only"), its settings, "Fills company fields — Enrichment ›".

**Sheets** — "Settings — printed" 07 (the catalogue); "Enrichment + Exa — printed" 01 (Apollo's thin source page). **Spec** — D81 (every plugin has its own page; Plugins is a catalogue); D51; `packages/sdk/src/manifest.ts`

#### `settings-5` · afk · S — Models carries the sensitivity floor, Search reuses its key, the Embed row leaves

**Blocked by:** `settings-1`

**What to build**

Three D81 lines on two AI pages. **Sensitivity**: a group at the top of Models — "Treat every record as: Normal / Sensitive" — writing `workspace.settings.sensitivity_default` (already read by `resolveSensitivity` through `packages/core/src/writes/ai/sensitivity-for.ts`; nothing writes it today). It is a floor and can only raise a record's sensitivity; the head's mono meta says so. **Search reuses the Models key**: when no `embedding` credential is stored for the chosen provider and an `llm` credential exists for the same provider, the embed path uses it, and Search shows "using the OpenAI key from Models" with "Use a different key"; a provider with no embeddings (Anthropic) still asks. **The Embed row** leaves the Models routing grid (`AI_LANES` keeps `embed` for the router; the grid filters it), replaced by one line "Embeddings · <model> · set in Search ›".

**Acceptance criteria**

- [ ] Choosing Sensitive writes the floor; a record marked normal then routes as sensitive, asserted through the resolver
- [ ] With only an OpenAI `llm` key, Test on Search succeeds and the page names the reused key; adding an embedding key takes precedence
- [ ] The routing grid has no Embed row and shows the link line instead
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Set the floor to Sensitive and ask about Flent: the answer comes from Ollama. Clear the embedding key: Search keeps working on the Models key.

**Sheets** — "Settings — printed" 03 (Models, Sensitivity group), 04 (Search). **Spec** — D81; `docs/spec-ai-substrate.md` §9; `packages/db/src/schema/workspace.ts` (`sensitivity_default`)

#### `settings-6` · afk · S — The workspace logo

**Blocked by:** `settings-1`

_Amended 2026-10-10 (pre-check against main `3397486`): blob GC counts only `document` and `import_batch` references (`lib/documents/blob-refs.ts`), and the orphan sweep reclaims an unreferenced upload after 24 hours — so `blobIsReferenced` must learn `workspace.settings.logo`. The sidebar head is `Wordmark` in `app-sidebar.tsx`. No migration: `WorkspaceSettings` has an index signature._

**What to build**

General gains a Logo row: Upload and Remove beside a 48px preview, the monogram (the workspace name's initial in an ink square) when none. The file goes through the existing blob storage (`packages/core/src/writes/storage/`) and its sha is stored at `workspace.settings.logo` — the settings jsonb already admits extra keys (`WorkspaceSettings`), so no migration. The sidebar head shows the logo or monogram beside the workspace name instead of the wordmark alone, collapsed too. Images only, 1 MB cap, refused with the reason.

**Acceptance criteria**

- [ ] Uploading a PNG or SVG stores the blob and the sha; Remove clears both; the head updates without reload
- [ ] With no logo the sidebar shows the monogram; collapsed, the 24px mark
- [ ] A 3 MB file or a PDF is refused with the reason
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Upload the fund's logo in General: it appears at the top of the sidebar.

**Sheets** — "Settings — printed" 01. **Spec** — D81 (General); owner verdict 2026-10-08 (logo built with the settings port)

### ▸ Today and the first run

_Today opens on a plain title, the day strip, four derived readouts and one Needs-you list sorted by urgency; a fresh workspace instead offers Import a file, Drop a deck, Add a company, and every feature missing a key says so where you would use it._

#### `today-1` · afk · M — Today, the one attention surface (D79)

**Blocked by:** `print-1`

_Amended 2026-10-10 (pre-check against main `3397486`): companies have no owner attribute and there is no follow concept, so What's moving lists signals from the last 7 days on companies the user has **touched** — created, logged an interaction on, or filed — newest first. Today's idle-deal rule is a fixed 21 days; `medianDaysInStage` in `lib/deals/funnel.ts` is what "past stage median" uses. Today has no Meetings section yet (arrival-11 unbuilt): the day strip draws hours only and the `meeting` lane is absent. Confirmed present: `listStoppedPlugins`, `PluginStatusSection`, `GettingStarted`, `PortfolioHeadlineRail`._

**What to build**

`apps/web/src/routes/_app/today.tsx` rewritten to the Today sheet. **Head**: a plain "Today" title with the date (`Thu 10-09 · W41`); the sentence title and the `GettingStarted` banner go. **Day strip**: a thin band of today's hours — elapsed hours dithered, meetings as ink blocks with their names, now as a pine dot — drawn from the day's meeting interactions; with no calendar it draws the hours only. **Readouts**, derived only: Overdue, Deals past stage median, Oldest mark, Unfiled files (the section counts Due today, Review and Missing FX leave the strip). **Notices band**, one line each with its fix link, for what stops the machine: a stopped plugin (`listStoppedPlugins`, replacing `PluginStatusSection`), a connection in `error`, and — when D76's enrichment slices land — the enrichment cap. **Needs you**: one ledger sorted by urgency with a 48px mono kind lane — `task`, `deal` (idle past median), `mark` (stale), `review` (open suggestions grouped by source and space: "Proptech / Property ops · via Exa · 3 to add"), `meeting` (no write-up, with **Write**) — tabs in the head filter by kind, the list folds at eight with "show all ›", and its last row is the task composer. A kind whose source does not exist yet is simply absent: `meeting` until `arrival-5`/`arrival-11`, `review` grouping by watch until `watch-3`. **Meetings**: `arrival-11`'s section moves here unchanged with "all meetings ›" to `arrival-12`'s page when that exists. **Rail**: Portfolio (`PortfolioHeadlineRail`) and What's moving — `signal` rows on the user's companies from the last 7 days, cited; the 24-hour team activity folds behind "team activity ›" in place.

**Acceptance criteria**

- [ ] The head is "Today" with the date; no sentence title, no getting-started card
- [ ] The readout strip carries only the four derived figures; none repeats a section count
- [ ] Needs you merges tasks, idle deals, stale marks and open suggestions in one urgency order; each tab filters to its kind; the fold is at eight
- [ ] Review rows group by source and space with one count each and link to Review filtered the same way
- [ ] A stopped plugin and an errored connection each show one notice line with its fix link; nothing else enters the band
- [ ] With no meetings source the day strip draws hours only and the meeting lane is absent; the page renders no empty section
- [ ] What's moving lists the last 7 days' signals on companies the user owns or follows, newest first, each with its ref
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Today on the dev seed: one list with two overdue tasks, an idle deal and three Exa cards grouped under Property ops; a notice says Gmail needs reconnecting; the rail shows the portfolio and two funding rounds this week.

**Sheets** — "Today — printed (10-09)" 00. **Spec** — D79; D68 amended (Today's section and "all meetings ›"); `docs/design-contract.md` §1 (a readout is never a section count)

#### `first-run-1` · afk · M — The first run without a checklist (D80)

**Blocked by:** `today-1`, `settings-1`

_Amended 2026-10-10 (pre-check against main `3397486`): "Enrich on a record showing the website source" needs enrich-3, now a blocker. Today has no Meetings section (arrival-11 unbuilt), so the Meetings `NeedsSetup` line is wired by arrival-11 when it lands; this slice wires `NeedsSetup` on Enrich only and ships the primitive. `seedDemoData` reuses the starter-taxonomy spaces it finds — those ids must not be recorded as demo ids._

**What to build**

**Setup** (`apps/web/src/routes/setup.tsx`): the demo step keeps its question but **Start empty** becomes the primary and "Load demo data" the outline beside it. Demo data becomes removable in one step: `seedDemoData` (`apps/web/src/lib/seeds/demo.ts`) records the entity ids it births at `workspace.settings.demo` (jsonb, no migration), and General gains "Remove demo data" — a confirm with the counts — that deletes them through the existing entity delete program and clears the key; the row is absent when the key is. **Today's empty state**: in a workspace with no companies, Today renders one P5 block — "Bring in what you already have." with Import a file (pine; "CSV or Airtable export"), Drop a deck, Add a company — and nothing else; it disappears once a record exists. **In-place prompts**: one primitive, `NeedsSetup` (one line, one link), that renders "<what it needs> · <Add/Connect …›>" to an admin and "Ask <admin names> to set up <thing>" to a member. This slice wires it where the surface exists: Today's Meetings with no calendar connection ("No calendar connected · Connect Google ›"), Enrich on a record showing the website source with "More sources ›". Ask without a model (`ask-5`) and Find without Exa (`ask-8a`) use the same primitive in their own slices. **What's set up**: a passive list at the foot of General — AI model, Team, Enrichment, Email forwarding, Google, Granola, Exa — each with set/not set, the one line it unlocks, and its link; never shown unprompted.

**Acceptance criteria**

- [ ] The setup demo step's primary is Start empty; loading demo data records its ids; Remove demo data deletes exactly those records and nothing created afterwards
- [ ] A workspace with no companies shows the three ways in on Today and no other section; adding one company removes it
- [ ] `NeedsSetup` renders the admin link for an admin and the ask-line with admin names for a member — one test, both roles
- [ ] Today's Meetings and the record's Enrich use `NeedsSetup`; no setup checklist or banner exists anywhere (the `GettingStarted` component is deleted)
- [ ] What's set up lists the seven items with live state from the vault, integrations and connections
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Run setup against an empty database, press Start empty: Today offers three ways in. Load demo data on a second run, then remove it from General: the demo companies are gone, a company added since is not.

**Sheets** — "Today — printed (10-09)" 01 (empty Today, the in-place prompts, What's set up). **Spec** — D80; `docs/design-contract.md` §1 (an empty section is one short line; P5)

## 28. Spaces, research and watches

_Extensibility · 11 slices · split out of project 23 on 2026-10-09_

The space becomes a page you can reshape and a set the web keeps filling: rename, move, archive and split (D73), the space page in the record anatomy (D74), the Ai port's researcher lane with Exa's record research, then watches that hand candidates back as cards (D72, D77). Find in Ask (`ask-8a`) and Save as watch (`ask-8b`) in project 24 build on it.

### ▸ Spaces can be reshaped

_Rename a space from its head, move a subtree under another parent and watch visibility, sensitivity and context follow at once, archive one and keep its filings, carve a child and move companies into it — nothing filed moves on its own (D73). Precedes every watch._

#### `spaces-1` · afk · S · migration — Rename and archive from the space head — `renameRecordProgram` wired, archive hides and pauses

**Blocked by:** none

_Amended 2026-10-09 (D73, owner verdict on the space page 10-08): archive asks nothing — **Restore** undoes it, so there is no confirm; rename edits the title in place; the `···` menu is **Rename · New subspace · Move to… · Save as template… · Archive**. "Save as template…" has no slice yet and is left out of the menu until it has one. The body and criteria below are edited to match._

_Amended 2026-10-10 (pre-check against main `3397486`): there is no archive flag on `space` or `entity` and no `archiveRecordProgram` — only objects, attributes and templates carry `archived`. This slice therefore carries **one migration**: `space.archived_at timestamptz` nullable (space-only; archiving a record is not decided). The readers filter on `archived_at is null`; Restore clears it. Label `migration` added._

**What to build**

The space head (Spaces — printed, sheet 03) carries a `···` menu — Rename · New subspace · Move to… · Archive — and this slice wires Rename, New subspace and Archive; Move to… is `spaces-2`. Rename calls `renameRecordProgram` (`packages/core/src/writes/entities/rename.ts`) on the space entity exactly as a record's head does; `slug` and `path` are untouched and the path is never shown. Archive is the entity's existing archive flag — `archiveRecordProgram` on the space entity, never a delete — and the readers learn it: the space picker (`lib/spaces/read.ts`), the tree on `/spaces`, the ancestor-visibility climb and the assembler's space edge all exclude an archived space, while `entity_space` filings stay and the record's rail still names the space, dimmed, so nothing filed loses its history. Watches and dismissals (`watch-1`) will read the same flag to pause. Archive asks nothing: the archived space's head shows the stamp in outline (`ARCHIVED 10-08`), the name and the double rule go graphite, and a double-framed notice under the head says what still holds — "Archived. Out of the tree and the space picker." with the counts (filings kept, watches paused) and one **Restore**, which clears the flag on the space and the descendants archived with it. Rename turns the title into its own field in place; ↵ saves, and links, filings and watches point at the space id, so nothing else changes. "New subspace" is `createSpace` under this space.

**Acceptance criteria**

- [ ] Rename from the space head changes the name everywhere it is read and leaves `space.slug` and `space.path` as they were
- [ ] Archiving sets the flag on the space and every descendant in one transaction; `entity_space` rows are untouched, and the archived spaces vanish from the picker, the tree and the assembler's climb
- [ ] A record filed in an archived space still lists it in its details column, dimmed, with no action
- [ ] Archive writes at once with no confirm; the archived head shows the outline stamp and the notice with its counts, and Restore returns the space and the descendants archived with it
- [ ] The `···` menu lists Rename, New subspace, Move to… and Archive; rename is in place on the title
- [ ] Archive is refused on the root a seeded taxonomy marks `is_seeded` only when it still holds unarchived children — the test names the case
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Rename "In space mfg" to "In-space manufacturing" from its head; the breadcrumb, the picker and every filed company's rail agree at once. Archive a dead subspace: its three companies keep the filing in their history and the picker no longer offers it.

**Sheets** — Spaces — printed, sheet 03 (the `···` menu, rename in place, archived). **Spec** — D73 (rename, archive, never delete)

#### `spaces-2` · afk · M — Move a space — one subtree path rewrite, refused under its own descendant, one event

**Blocked by:** `spaces-1`

_Amended 2026-10-10 (pre-check against main `3397486`): `chunk.sensitive` is a cached value, so "nothing else is rewritten" is wrong for sensitivity — a move under a sensitive ancestor calls `raiseSensitivity` in the transaction and a move out of one queues `sensitivity.restamp`, the pair SPA-221 uses. The acceptance line on "the assembler's position item" is dropped (D71's item is not built; ask-7 carries it); assert ancestor visibility and sensitivity only. A move to the root must also satisfy `space_slug_root_unique`._

**What to build**

"Move to…" in the space head's `···` menu opens the move window (Spaces — printed, sheet 03: a window over the scrim, the space and its descendants greyed with the reason, its parent marked "now here") with the current space and its descendants excluded. The move is one program in `packages/core/src/writes/entities/` beside rename: a single `UPDATE space SET path = new_parent.path || subpath(path, nlevel(old_parent.path)), parent_id = … WHERE path <@ old_path` inside one transaction, with a unique-slug check against the new parent (`space_slug_per_parent_unique`) that refuses with a typed error naming the collision rather than renaming silently. Moving under itself or a descendant is refused before the update. One activity event on the moved space records the old and new paths.

Because every consumer computes from the path at read time — ancestor visibility, sensitivity inheritance, the assembler's climb, glossary scope — nothing else is rewritten, and the test proves it: a company filed in the moved space inherits the new ancestor's sensitivity in the same request, and its context items name the new path.

**Acceptance criteria**

- [ ] Moving a subtree rewrites every descendant's `path` and the root's `parent_id` in one statement and one transaction; `entity_space` is untouched
- [ ] Moving under itself or any descendant is refused with a typed error; a slug collision under the new parent is refused naming the sibling
- [ ] Sensitivity, ancestor visibility and the assembler's position item follow the new path with no second write — each asserted on a filed record after the move
- [ ] Exactly one activity event is written, naming both paths
- [ ] The move window greys the space and its descendants with the reason and marks the current parent "now here"
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Move "Small-lift" from under "Launch" to under "Launch › Reusable": the breadcrumb changes, the companies filed there are now visible from the new ancestor, and flagging the new parent sensitive makes their context calls sensitive at once.

**Sheets** — Spaces — printed, sheet 03 (Move to…). **Spec** — D73 (move: one UPDATE, one event, refused under its own descendant; the path is the only derived structure)

#### `spaces-3` · afk · S — Split by hand — create a child and multi-select "move here" over tag and untag

**Blocked by:** `spaces-2`

_Amended 2026-10-10 (pre-check against main `3397486`): no row selection exists anywhere, so this slice adds the row checkbox and the 44px action bar on the space's Companies tab — a space-page-only multi-select, not a table primitive (enrich-5 adds the table one). "New subspace" is already wired by spaces-1. Untag is the `untagFromSpace` server fn in `lib/server/companies.ts`. Blocked by spaces-4 for the Companies tab._

**What to build**

Not a primitive: Split is "New subspace" in the space head's `···` menu (Spaces — printed, sheet 04): it creates a child space with `createSpace` and lands on the parent's Companies tab (`spaces-4`) in multi-select mode and one action, "Move here", over the existing tag and untag writers (`lib/spaces/tag.ts`). Each chosen company gains the child filing and loses the parent's, as two explicit writes on an explicit choice — the invariant D73 states, filings never move on their own. The multi-select is the ledger's existing row checkbox with a 44px bone action bar that appears when one is checked ("3 selected · Move here"), on Spaces — printed, sheet 04. Inherited rows (via a subspace) are not offered: they are already in a child.

**Acceptance criteria**

- [ ] "New subspace" creates the child under the current space and opens it with the parent's direct members selectable
- [ ] "Move here" untags each chosen company from the parent and tags it in the child, one event each, through the existing writers and no new SQL
- [ ] Rows inherited from a subspace are not selectable; the test asserts the parent's direct filings only
- [ ] The action bar is the one bone bar at 44px with the count and the single pine verb; it disappears when nothing is selected
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On "In-space manufacturing", split "Materials" out: pick Varda and Space Forge, press Move here, and both now file under Materials with their history showing the untag and the tag.

**Sheets** — Spaces — printed, sheet 04 (split). **Spec** — D73 (split is create + move here; only split and merge touch filings)

#### `spaces-4` · afk · M — The space page in the record anatomy — three readouts, a details column, five tabs (D73, D74)

**Blocked by:** `spaces-1`

_Amended 2026-10-10 (pre-check against main `3397486`): records have no tabbed body and no `?tab=` yet, so this slice builds the tab head on `ui/tabs.tsx` (print-1) for the space page and introduces `?tab=` there. "Last tab remembered per user" is per browser in localStorage beside `chassis-prefs.ts` — no per-user prefs column, no migration. `funding_stage` is a `select`; order the bar by its options order, bootstrapped last. The Companies **Watching** filter renders only once `space_watch` exists (watch-1), else the filter row is All · In pipeline._

**What to build**

The space page as the owner approved it on 2026-10-08: a space reads like a record (D74), replacing the five stacked sections of 2026-09-16. Built from the record parts (`RecordHeader`, `RecordBody`, the tab head), not a second layout.

- **Head:** the ink stamp `SPACE · depth n`, created date, the serif name with its icon, the crumb of ancestors (`Spaces / Proptech`), the double rule. One button, **Note here** `N`, beside the **Not sensitive** toggle and the `···` menu (`spaces-1`). Add watch (`watch-4`) and Find companies (`ask-8a`) join the head when they land.
- **Readouts:** three, never section counts — **In pipeline** (`3 of 14`), **Last filed** (`10-06 · 2d`), and the **funding-stage mix** as a bar by stage with its labels. The bar is the page's one dither: density rises with stage, bootstrapped lightest at the end.
- **Details column** (bone, 320px): **Map** (`↑` parent, subspaces with their telling count, `+ Subspace`), **Glossary** (terms, inherited ones marked "from <ancestor>", `+ Term`), **Tasks** (open tasks, `+ Add a task…` `T`). Criteria, Watching and What's moving join the top of the column with `watch-1` and `watch-4`.
- **Tabs:** **Companies · Notes · Files · People · Records**, each with its mono count, empty ones grey; **Notes is the default**, the last tab remembered per user. **Referenced** stops being a section: it folds into Notes as a filter (**Filed · Mentions**). Companies carries a filter row (**All · In pipeline · Watching**) and a sort (Funding stage default), a composer row "Tag a company into <space>…", and rows with a 1-bit mark, name, stage badge, a pipeline lane (`watching`, `n deals`) and location; hovering a row shows its select box (for split, `spaces-3`) and `×` to untag with an Undo toast. People lists the people of the filed companies; Records the custom records filed here.
- Deep link `?tab=companies` as on a record.

**Acceptance criteria**

- [ ] The space route renders through the record parts with the stamp, crumb, double rule and three readouts; no readout repeats a tab count
- [ ] The funding-stage bar sums to the Companies count and orders stages as the status attribute orders them, bootstrapped last
- [ ] The details column holds Map, Glossary and Tasks in that order; inherited terms show their source space
- [ ] The five tabs show their counts, empty tabs grey with 0; Notes opens by default and the last tab is remembered per user; `?tab=` deep-links
- [ ] Notes' filter row has Filed and Mentions, and "Referenced" exists nowhere else on the page
- [ ] Companies' filter and sort work; hover shows the select box and `×`; untag writes one event and offers Undo
- [ ] Gate 5 passes; the tab head is the record's 44px bone head; Note here is the head's only button until `watch-4` and `ask-8a`
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Property ops: three readouts with the stage bar, Map, Glossary and Tasks on the left, Notes open on the right; switch to Companies, filter Watching, hover Tenantry and untag it, then undo.

**Sheets** — Spaces — printed, sheets 00 (index) and 01 (Companies tab), 02 (Notes tab), 03 (head menu), 04 (split). **Spec** — D73; D74 (the tabbed body, empty tabs grey, deep links); `docs/design-contract.md` — a record

### ▸ The last unimplemented port

_The Ai port's live layer with the sensitivity gate and the spend ceiling enforced by core rather than trusted to the plugin, tokens attributed to the integration and not to a user; then Exa as the researcher kind's first tenant — five web signals on a record and a one-paragraph brief in /inbox citing the five URLs._

#### `backfill-11` · afk · M — Ai port live — the researcher lane, budgeted and attributed to the integration

**Blocked by:** `ai-26`, `ai-4a`, `backfill-4`, `sdk-12a`

**What to build**

Every port gets a live slice — sdk-6a, sdk-6b, sdk-7a, sdk-7b, sdk-8, sdk-9, sdk-10, sdk-24a — except Ai, while sdk-12a's Layer table already names AiLive and the kind→ports table grants Ai to `researcher` and classify-only Ai to `poller`. AiLive wraps core's complete(): the lane is whatever the plugin names, sensitivity is resolved by core from the entity the job runs on through ai-26's resolver and is never accepted from the plugin (that is the whole point of the gate), the ceiling is backfill-4's predicate, and every call writes an ai_usage row with caller {type:'integration', id: row.id} so the operator can see which plugin spent what. The poller restriction is enforced in the Layer rather than documented in a table. Joins project 12 (Plugins run unattended, Apollo enriches).

**Acceptance criteria**

- [ ] A researcher fixture invoked through the loader gets Ai and writes ai_usage rows carrying caller_type 'integration' and the integration id; an enricher fixture that yields Ai fails service-not-found with no provider call
- [ ] A poller fixture calling ai.complete('synthesize') fails at the port, not at the provider; classify runs
- [ ] A plugin cannot influence the gate: AiLive resolves sensitivity from the entity and ignores anything the plugin passes, asserted by a fixture that tries
- [ ] A sensitive record with the lane routed to a cloud provider refuses with SensitiveRouteRefused and the job fails without writing
- [ ] Crossing backfill-4's per-day ceiling refuses the plugin's call with CapExceeded and closes job_run with the reason, so a runaway researcher cannot outspend a human
- [ ] The Layer is built per (integration, job) like the rest — two invocations of one job construct one AiLive, asserted by the counter sdk-12a already uses
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Enable the researcher fixture and invoke its job: the claim lands, Settings → AI · Usage attributes the tokens to the plugin rather than to a user, and the same job on a record under a sensitive space refuses by name.

**Spec** — docs/spec-plugin-sdk.md §4 — port table, kind→ports, the Layer the loader provides (AiLive); docs/spec-ai-substrate.md §11 — the only plugin kind that calls Ai is researcher

#### `backfill-12` · afk · M — plugins/exa — the first researcher, its signals and its brief

**Blocked by:** `backfill-11`, `sdk-10`, `sdk-12b`, `sdk-6b`, `sdk-7b`

_Amended 2026-10-10 (pre-check against main `3397486`): D51 removed `kind` and the manifest rejects it — "declares kind researcher" means a job whose `uses` is `Config | Secrets | Http | Read | Content | Ai | Judgment` (add `Secrets`). Refs are `event:<id>` strings, never URLs: the brief's refs are the signal ids and the hit URLs sit in the signal payloads. `/inbox` redirects to `/review`._

**What to build**

The researcher kind has a semver-frozen interface (sdk-4a) and no tenant, and CONTEXT banks Exa as the second Enricher alongside Apollo. The SDK spec's own worked example is Exa, so the shape is already written: Read the entity for name and domain, Http the search, one signal per hit through Content, then Ai synthesize into a brief that lands as a Judgment suggestion with the hit URLs as refs. No Facts, no Identity — research never fills fields, and the Layer refuses them. Credential kind 'search' already exists in the enum, so nothing schema-level is needed. This is sdk-15's Apollo shape on a different kind and inherits its cassette pattern rather than inventing one. Joins project 12 (Plugins run unattended, Apollo enriches).

**Acceptance criteria**

- [ ] plugins/exa declares kind researcher, requires.credential {kind:'search', scope:'workspace'}, and manifest settings maxResults and lookbackDays; grep shows no Exa special case anywhere in core
- [ ] The job's R type is Config | Http | Read | Content | Ai | Judgment, the loader hands it nothing else, and a deliberate Facts reach fails service-not-found
- [ ] Against a recorded cassette with no network, one run produces one signal per hit and exactly one note suggestion whose refs are the hit URLs
- [ ] The brief lands in /inbox and accepting it creates a note through the existing createNote path with the accepter as author
- [ ] Exa's own error text surfaces on failure rather than a generic message, the way CONTEXT requires of Apollo
- [ ] With no key configured the action is absent rather than failing at call time
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Paste an Exa key, press Research on a company: five web signals land on the record and a one-paragraph brief waits in /inbox citing the five URLs.

**Spec** — docs/spec-plugin-sdk.md §4 — worked example (Exa, researcher) and the Layer the loader provides; docs/spec-plugin-sdk.md §5 — kinds, interfaces, claims; CONTEXT.md — Enrichment (Exa alongside as a second Enricher)

### ▸ A space watches

_A space carries a criteria sentence; a watch row names an engine, a cadence or none, and a cursor; Run now fires the job and the Watching lane shows it live; candidates come back through `Discover` and land in Review as add-record and file-record cards under the space's head, dismissals permanent per space; signals on members fill "What's moving" (D72). Exa is the first tenant; Harmonic rides the same contract later._

#### `watch-1` · afk · M · migration — `space.criteria`, `space_watch`, the two suggestion kinds — one migration (D72)

**Blocked by:** `spaces-2`, `review-1`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-09 (D77): the same migration adds a partial unique index on open `add_record` and `file_record` suggestions over `(payload->>'space_id', payload->>'domain')`, so `watch-3` can keep one open card per (space, domain) and append evidence to it. Criteria now sits at the top of the space page's details column (`spaces-4`)._

_Amended 2026-10-10 (pre-check against main `3397486`): the `ENTITY_REFS` vocabulary is `repoint` | `repoint-or-drop` | `custom` | `none` for merge, a `del` kind, and `context: null` — a space merge is `{kind: 'none'}`. `settings_hash` must be a column (text, the sha of the settings jsonb). `suggestion.entity_id` is NOT NULL, but an `add_record` card has no record: the same migration makes it nullable, and `canRead`/Review read the space from the payload for that kind. Criteria sits at the top of the details column. Accept and reject live in `apps/web/src/lib/ai/propose.ts`._

**What to build**

The host state D72 names, in one migration. `space` gains `criteria` text, nullable, one to three sentences of "what belongs here"; the space page's details column shows it at the top as the in-place editable Criteria field (Enrichment + Exa — printed, sheet 03), written through a server fn that logs an activity event. `space_watch(id, space_id, integration_id, settings jsonb, cadence_minutes int null, state jsonb, last_run_at, last_status, last_error, created_by, created_at)` with `unique(space_id, integration_id, settings_hash)` so the same lens is not saved twice, and `space_watch_dismissal(space_id, domain, dismissed_by, created_at)` keyed on the pair. `suggestion_kind` gains `add_record` (payload: name, domain, aliases, evidence refs, subspace hint) and `file_record` (payload: entity id, the space, evidence) — the two cards R1 draws. `ENTITY_REFS` gains `space_watch.space` and `space_watch_dismissal.space`, both `cascade` on merge (a space merge is deferred by D73 and unions them when it lands) and `none` for context. An archived space (`spaces-1`) pauses its watches: the scheduler in `watch-2` reads the flag, so no column is needed here.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name space_watch`, SQL hand-inspected: `space.criteria`, `space_watch` with its unique index, `space_watch_dismissal`, the two enum values, and the partial unique index on open `add_record`/`file_record` cards by space and domain — two open cards for one (space, domain) are refused by the database
- [ ] Criteria edits in place on the space head and writes one activity event per save; empty stays empty, never a placeholder sentence stored
- [ ] `ENTITY_REFS` carries both new columns; deleting either fails `entity-refs.test.ts` naming it
- [ ] An `add_record` suggestion accepts through `resolveEntity`, files the new record in the space (or the hinted subspace when it exists), and fires `entity.created`; a `file_record` suggestion accepts by filing an existing record; both reject by writing the dismissal row for the domain
- [ ] A dismissal for `(space, domain)` makes a later proposal for the same domain a database no-op, asserted with two proposals
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Write a criteria sentence on a space, insert a watch row by hand, propose an add-record card for a domain, dismiss it, propose again: the second one never appears.

**Sheets** — Enrichment + Exa — printed, sheet 03 (criteria; the two cards in Review). **Spec** — D72 (`space_watch` is host state; criteria; dismissals permanent per space)

#### `watch-2` · afk · M · migration — The `watch` trigger and the `Spaces` port — a job runs per watch row with the D71 brief as its subject

**Blocked by:** `watch-1`, `sdk-12b`

_Amended 2026-10-10 (pre-check against main `3397486`): **label `migration` added** — `job_run` has no watch column, so this slice adds `job_run.watch_id` (nullable uuid, FK to `space_watch`) and writes the space id to `job_run.entity_id` so sdk-18's per-entity status stream reaches the Watching lane. Per-job `settings` does not exist (`jobSchema` is strict) and `PORT_NAMES` has no `Spaces`: both are this slice's SDK minor. "The material D71 builds" is not built — this slice builds `Spaces.brief` itself from the assembler's builders._

**What to build**

The sixth trigger. `TRIGGERS` in `packages/sdk/src/manifest.ts` gains `watch`; a watch job declares `settings` of its own (a zod schema the host renders as the watch form, the same way the plugin's settings form is generated) and `uses` that may include the new `Spaces` port and `Discover` (`watch-3`). The worker's scheduler (`apps/worker/src/plugins/`) registers one queue per watch job and enqueues per `space_watch` row: on cadence when `cadence_minutes` is set, and on "Run now" always, which is a server fn that enqueues the same job with the row id — the space's archive flag pauses both. `state` jsonb is handed to the job and written back from its return, the plugin's cursor and nothing of the host's. `job_run` rows carry the watch id so the Watching lane (`watch-4`) and the Integrations ledger can read a run log per watch.

The `Spaces` port is read-only and has one call, `brief(spaceId)`: the material D71 builds for the assembler — the full path, memo, criteria, terms, the filed companies with their key values, the subspace tree with counts — rendered through `packages/core/src/writes/context/` and handed as data, never as prompt text, so an engine turns it into its own query. `canRead` applies as the integration's actor; a sensitive space anywhere in the path refuses the call, which refuses the run.

**Acceptance criteria**

- [ ] A manifest declaring a `watch` job with a settings schema validates; one without a settings schema is refused at manifest validation
- [ ] The scheduler enqueues one job per `space_watch` row on its cadence; a row with `cadence_minutes = null` is never scheduled and runs only from "Run now"
- [ ] "Run now" on a scheduled watch enqueues immediately and the next cadence tick still fires; an archived space enqueues nothing from either path
- [ ] `state` round-trips: the job's return is written to the row and handed back on the next run; a job that throws leaves `state` as it was
- [ ] `Spaces.brief` returns path, memo, criteria, terms, members with key values and the subspace tree, through the assembler's own builders; a fixture asserts the shape is data, not a rendered prompt
- [ ] A sensitive space in the path refuses the brief and the run closes with the reason in `job_run`
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enable a watch fixture, add a watch on a space with no cadence, press Run now: `job_run` shows one run carrying the watch id, and the fixture's log shows the brief it received.

**Sheets** — Components "Research · Ask · Watches" (watch row). **Spec** — D72 (`watch` trigger, `Spaces` port, nullable cadence, plugin-owned `state`); `docs/spec-plugin-sdk.md` §4–5

#### `watch-3` · afk · M — The `Discover` port — `previewResolve`, add-record and file-record cards, permanent dismissals

**Blocked by:** `watch-2`, `sdk-7b`

_Amended 2026-10-09 (D77): consolidation is by result, not by watch — **one open `add_record` or `file_record` card per (space, domain)**. A later find of the same domain, from another watch or from Find in Ask (`ask-8a`), appends its evidence to the open card ("found by 2 watches") instead of proposing again. Every candidate passes the same three checks in order: member, dismissed, open card. No new table._

_Amended 2026-10-10 (pre-check against main `3397486`): the signal method is `Content.emitSignal`, not `logSignal`. Refs are `event:<id>` strings, so the evidence URLs live in the card payload (`evidence: [{url, title}]`) and `suggestion.refs` carries signal ids when there are any. `proposeProgram` only does ON CONFLICT DO NOTHING today; the merge-into-open-card path is new work here._

**What to build**

The hand-back. `Discover.candidate({name, domain, aliases, evidence, subspaceHint})` is the one call; the host does everything after it, in core beside the other live ports (`packages/core/src/writes/ports/`). The dismissal table is checked first — a dismissed `(space, domain)` returns without a row. Then `previewResolve` over the identity normalizers: known and already filed in this space or a descendant → dropped; known elsewhere → `file_record` card; unknown → `add_record` card with the evidence refs as the card's refs. Cards are suggestions through `proposeProgram` (`packages/core/src/writes/suggestions/propose.ts`). The open-card check keys on (space, domain), not on the payload: a candidate whose domain already has an open card in this space merges its evidence refs and the finding watch into that card's payload inside the same statement (an `ON CONFLICT … DO UPDATE` on the partial unique index `watch-1` creates over an open card's space and domain), and the card reads "found by n watches". Find in Ask (`ask-8a`) goes through the same call, so a company found by a watch and by a question is one card. Signals a watch finds on existing members go through `Content.logSignal` as they do for Apollo, with `source_ref` from the integration row.

Review (**R1**) groups the cards under a bone space head — path, `via <plugin mark>`, mono count — each card with the name, domain, the evidence refs as ref chips with their URLs, and the two verbs: pine "Add and file here" (or "File here") and ghost "Dismiss"; the tooltip on Dismiss says it is permanent for this space, which is where that sentence lives and nowhere else. Accept shows the after-state once: "Added · enriching" while `entity.created` fans out. No bulk accept.

**Acceptance criteria**

- [ ] A candidate already filed in the space or a descendant produces no suggestion; one filed elsewhere produces `file_record`; an unknown one produces `add_record` — three fixtures through `previewResolve`
- [ ] A dismissed domain produces nothing and no `previewResolve` call, asserted by a spy
- [ ] The same domain from two runs, or from two different watches on the space, is one open card whose evidence holds both sets of refs and which reads "found by 2 watches"; after the card is accepted or dismissed, the member or dismissal check answers instead
- [ ] The checks run in order — member, dismissed, open card — asserted with a spy that sees no `previewResolve` call for a dismissed domain
- [ ] Review groups the cards by space head with the plugin's mark and count; a card's refs open the evidence URLs
- [ ] Accepting `add_record` creates the record through `resolveEntity`, files it (subspace hint honoured when it resolves), and emits `entity.created`; the card then shows the enrich state until the job settles
- [ ] A `discover` fixture that tries `Facts` fails service-not-found — a watch never fills fields
- [ ] Gate 5 passes on the card and the head
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Run the watch fixture against a space holding Varda: it hands back Varda, Redwire and an unknown; Review shows one "also file Redwire here?" and one "add X?" under the space's head, and nothing for Varda. Dismiss the unknown and run again: it stays gone.

**Sheets** — Enrichment + Exa — printed, sheet 03 (what a run leaves in Review); Surfaces R1; Patterns P9 (a queue grouped by head). **Spec** — D72 (`Discover`, `previewResolve`, dismissals); D77 (one open card per space and domain); D61

#### `watch-4` · afk · M — Space page: criteria, the Watching lane with Run now and live status, "What's moving", Today's count

**Blocked by:** `watch-3`, `sdk-18`, `spaces-4`

_Amended 2026-10-09 (D73/D74 space page, D77, D79): the space page is `spaces-4`'s record anatomy, so Criteria, **Watching** and **What's moving** sit at the top of its details column above Map, Glossary and Tasks — there is no rail. **Add watch** is a window (engine, name, Look for, How often, At most per run) and its cadence defaults to **Manual** here; Ask's Save as watch defaults to Weekly (`ask-8b`). The head's **Find companies** button is `ask-8a`'s. Today counts open cards in its one Needs-you ledger as a review row grouped by source (D79), not in a separate attention section._

_Amended 2026-10-10 (pre-check against main `3397486`): blocked by today-1 for the Needs-you row and watch-2 for Run now and the `job_run.watch_id`/`entity_id` it writes; the status stream is keyed by entity, which is why watch-2 writes the space id there. Confirmed present: `lib/integrations/settings-form.ts`, `job-status-stream.ts`._

**What to build**

The watching half of the space page `spaces-4` builds. Head: **Add watch** joins Note here; it opens a window in the dialog grammar — **Engine** (the enabled integrations that declare a `watch` job), **Name**, **Look for** (the engine's settings schema, rendered by `sdk-20b`'s renderer; Exa's is the criteria override, blank when it equals the space's criteria), **How often** (a select whose first value and default is **Manual**), **At most** per run — and **Save watch**. Details column, top: **Criteria** (`watch-1`), then **Watching**, one 32px row per watch — engine mark, name, cadence or "manual", last run, a live status cell over D64's stream ("running · 7 found · 6 cards"), Run now — with the empty lane naming which installed plugins can watch and a degraded row showing the mark at reduced opacity and the reason ("Exa key removed"), Run now absent; then **What's moving**, signals on members newest first, each with its record, the subspace it came via and its source, folding at three behind "+n more". Map, Glossary and Tasks follow. Today counts the space's open cards as one review row in its Needs-you ledger ("Proptech / Property ops · via Exa · 3 to add · 1 to file", D79) linking to Review filtered by the space.

**Acceptance criteria**

- [ ] Add watch opens the window for the chosen engine with How often defaulting to Manual; saving writes a `space_watch` row with `cadence_minutes = null` and the lane shows it at once
- [ ] Criteria, Watching and What's moving sit at the top of the details column, above Map, Glossary and Tasks
- [ ] The Watching row streams the running job's status over the SSE channel `sdk-18` built and settles from `job_run` on reload — never from a missed notification
- [ ] Run now enqueues the job and is present on scheduled and manual watches alike; it is absent on a degraded engine's row, which shows the reason
- [ ] The empty lane lists installed engines that declare a `watch` job and says nothing else
- [ ] What's moving lists signals on the space's members newest first with their refs; a signal on a record filed in a subspace appears here too
- [ ] Today's Needs-you ledger shows one review row per space with open cards, counting only open `add_record` and `file_record` suggestions, linking to Review filtered by that space
- [ ] Gate 5 passes; Watching rows are 32px in the details-column grammar and section heads 44px bone
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Add an Exa watch to "In-space manufacturing" (How often: Manual), press Run now, watch the row go running → done with "7 found · 6 cards", see the review row on Today, and read the two signals on Varda under What's moving.

**Sheets** — Enrichment + Exa — printed, sheet 03 (the details column top, the Add watch window, a degraded engine); Today — printed, sheet 00 (the review row); Patterns P11 (lanes that stream). **Spec** — D72; D77 (Manual on the space page); D79; D64

#### `watch-5` · afk · M — plugins/exa — the watch job: webset from the brief, cursor in `state`, candidates and signals

**Blocked by:** `watch-3`, `backfill-12`

_Amended 2026-10-10 (pre-check against main `3397486`): `uses` must include `Secrets` (the key, as Apollo reads it). `plugins/exa` does not exist until backfill-12 lands; the cassettes this slice adds sit beside the ones 247 creates._

**What to build**

`plugins/exa` gains a second job, `watch`, beside `backfill-12`'s record action. Its settings schema is the criteria override (defaults to the space's) and a per-run cap. On first run it calls `Spaces.brief`, builds a webset query from the memo, criteria and the exemplar companies' domains, creates the webset through `Http` and stores its id in `state`; later runs page the webset from the stored cursor. Each result goes to `Discover.candidate` with the hit URLs as evidence; a result whose domain is already a member becomes a signal through `Content` instead. No `Facts`, no `Identity`: the Layer refuses them. Cassettes for the webset create, page and empty-page calls live beside the plugin's existing ones; the suite runs with no network. Harmonic is explicitly not built: this slice proves the host contract is enough for a second engine by keeping Exa's code free of any space-table knowledge.

**Acceptance criteria**

- [ ] `plugins/exa` declares a `watch` job with a settings schema and `uses: ['Config','Http','Spaces','Discover','Content','Log','Receipts']`; grep shows no Exa special case in core or the worker
- [ ] First run creates one webset from the brief and stores its id; the second run pages from the cursor and creates no second webset — asserted against cassettes
- [ ] A result for a member domain writes one signal with the hit as its ref; a non-member goes to `Discover`; the cap stops the run at the configured count with the cursor saved
- [ ] A `Facts` reach fails service-not-found; `Identity` likewise
- [ ] The raw responses are written to `Receipts`; Exa's own error text surfaces on failure
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enable Exa, add a watch to a space, Run now against the cassettes: a webset is created, seven results come back, six become cards under the space's head and one becomes a signal on a member.

**Spec** — D72 (Exa first tenant; Harmonic rides the same contract); `docs/spec-plugin-sdk.md` §4 worked example

## 29. Enrichment is the host's

_Extensibility · 8 slices · split out of project 23 on 2026-10-09_

D76 as built: the Apollo gaps closed, an enrichment vocabulary every source answers in and an attribute link that names it, the free Website source first, auto-enrich with its checks and parking, bulk enrich behind an estimate, Apollo's full field list, a picture on every record, and the Enrichment page with "Fill from" and the where-from popover.

### ▸ Sources, the vocabulary and auto-enrich

_Added 2026-10-09 (D76): a source answers in the host's vocabulary, the link lives on the attribute, sources run in the owner's order with the free Website source first, auto-enrich is the Enrich button pressed for the owner and parks at the cap, records gain a picture, and the Enrichment page shows all of it. Apollo is the first paid source and Exa an optional later one._

#### `enrich-1` · afk · M — Apollo gaps and the auto-enrich triggers — a cleared value is user-held, `Content` for signals, relationships fill only when empty, scopes replace `autoEnrich` (D76)

**Blocked by:** `graph-1`, `sdk-19`

_Amended 2026-10-09 (D76): rewritten. The four D72 gaps stay; the targeted scope becomes D76's auto-enrich — the Enrich button pressed for the owner — with three of its five triggers here (created, filed, joins a deal); appears-in-a-meeting and gains-an-identity, the host's ordered checks and parking at the cap are `enrich-4`. No longer blocked by `watch-3`: the `filed` event fires on any `entity_space` insert, and an accepted add-record card is one of them._

**What to build**

Four gaps D72 recorded against the shipped Apollo path, none needing schema, and the triggers D76 names.

- **A cleared value is user-held.** `setValuesInTx` (`packages/core/src/writes/attributes/values.ts`) records the clearing actor in `lastWriters`, and `Facts.fill` skips a slug whose last writer is a user even when the value is now empty — today it refills it.
- **Signals through `Content`.** `Content` joins Apollo's `uses`, and the enricher logs a funding round and a hiring change as signals with the receipt as ref (`enrich-6` widens what Apollo reads; this slice lands the lane).
- **Relationships fill only when empty.** A relationship value (`companies`, `founders`, the pairs `rel-1` makes) fills only when empty; when one exists and differs, a card is proposed instead of a write.
- **Scopes replace `autoEnrich`.** The per-integration on/off becomes the scopes D76 lets the owner choose — **deal** (the record joins a deal), **space** (it is filed into a chosen space), **meeting** (`enrich-4`) — and a record is auto-enriched when one of its triggers fires in scope. The triggers here: **record created** (the `entity.created` dispatcher, `sdk-19`), **filed into a space** (a `filed` event the emitter fires after an `entity_space` insert commits) and **joins a deal** (a `deal.linked` event when a company or person becomes a deal's party). `DOMAIN_EVENTS` gains `filed` and `deal.linked`: an additive SDK minor. Seed and import births emit nothing (D65); they are enriched in bulk behind an estimate (`enrich-5`). The defaults D76 sets apply on upgrade: a paid source starts with the **deal** scope only.

The Integrations ledger (I1) shows the scope words in the Apollo row and the credits used; the Enrichment page that replaces it is `enrich-8`.

**Acceptance criteria**

- [ ] Clearing a value by hand then running Apollo leaves it empty; the test asserts `lastWriters` names the user and the fill skipped the slug
- [ ] A funding event in a cassette writes one signal on the company with the receipt id as its ref and no attribute write
- [ ] An empty `companies` on a person fills; a differing one proposes a card and writes nothing — both asserted
- [ ] `autoEnrich: true|false` in existing integration configs reads as scope `deal` for `true` and none for `false`, so no config migration is needed; the settings form offers the scopes as checkboxes
- [ ] The emitter fires `filed` after an `entity_space` insert commits and `deal.linked` after a party joins a deal, skipped for `seed` and `import`; the dispatcher enriches an in-scope record once per trigger and never for an out-of-scope one
- [ ] `DOMAIN_EVENTS` lists the two new names, `SDK_VERSION` takes a minor bump, and an `event` job declaring `on: ['filed']` validates
- [ ] I1 shows the scope and credits used on the Apollo row
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Clear a company's headcount, re-run Enrich: it stays cleared. Add a company as a deal's party with Apollo scoped to deals: it is enriched within the second and its funding round appears as a signal. File a different company into a space that is not in scope: nothing runs.

**Sheets** — Surfaces I1 (Integrations row: scope, credits); Enrichment + Exa — printed, sheet 01 (auto-enrich checkboxes). **Spec** — D76 (auto-enrich; triggers; defaults); D72 (Apollo gaps); D65 (the emitter); `packages/core/src/writes/attributes/values.ts`

#### `enrich-2` · afk · M — The enrichment vocabulary, the attribute link, and sources in order — first answer wins (D76)

**Blocked by:** `enrich-1`

_Amended 2026-10-10 (pre-check against main `3397486`): Apollo's jobs are `enrichCompany`/`enrichPerson` with actions `enrich-company`/`enrich-person` — "its `enrich` action" means those; a source's manifest names which action answers which kind. Scopes already live on `integration.config` as `autoEnrichScopes`/`autoEnrichSpaces` (enrich-1) and reuse is Apollo's `cacheDays`: moving them to `workspace.settings.enrichment` is a data move. Default links on `SYSTEM_ATTRIBUTES` reach no existing workspace because the seeder never overwrites rows: add an insert-if-absent pass for `options.enrichmentKey`. Companies have no `twitter` attribute. No schema change._

**What to build**

D76's core: enrichment is a host capability and providers are interchangeable sources. Three pieces, none needing schema.

- **A host-owned vocabulary.** `ENRICHMENT_VOCABULARY` in `@spaces/sdk` names every key a source may answer — `company.description`, `company.headcount`, `company.founded_year`, `company.total_raised`, `person.title`, `person.seniority`… — each with its kind (company or person), value type and whether it is a changing figure. A source answers in these keys through a new `Facts.answer({entityId, answers, receiptId})`, never in attribute slugs. An additive SDK minor; `Facts.fill` stays for non-enrichment writers.
- **The link lives on the attribute.** `AttributeOptions` gains `enrichmentKey`: "fill from enrichment: <key>". The system attributes are linked by default in `SYSTEM_ATTRIBUTES` (description, founded, location, LinkedIn, Twitter, job title…), and an owner links their own (Employees ← `company.headcount`). One link serves every source. No `Apollo …` fields. Stored in the existing `attribute.options` jsonb, validated by the registry like every other option, so no migration — the reason it is an option and not a column is that only the registry reads it.
- **Sources run in the owner's order.** A core job `enrichment.run(entityId, reason)` reads the order from `workspace.settings.enrichment` (`sources: [integration ids]`, `reuseDays`, `scopes`), then for each source in turn invokes its `enrich` action with the identity it can look up and **only the linked keys still empty**, and maps each answer through the links: the first source with an answer for a key wins, a person's value is never touched (the fill-blanks rule, the cleared-value rule of `enrich-1`), and a disagreement with a person becomes one Review card per record listing every disagreeing field. **A disagreement between two sources is not a card**: the losing answer is kept in the where-from history (the receipt of the run, read back by `enrich-8`'s popover). A changing figure (headcount, revenue, total raised) is replaced by a newer answer when no person set it, and the old figure stays in the history with its date. One timeline line per run: "Enriched · Website, Apollo · 6 fields · 1 credit". No toast.

**Acceptance criteria**

- [ ] `ENRICHMENT_VOCABULARY` exports with kinds and types; `Facts.answer` refuses a key outside it naming the key; `SDK_VERSION` takes a minor bump
- [ ] A custom attribute linked to `company.headcount` is filled from an answer; an unlinked answer writes nothing and is kept in the receipt
- [ ] With two sources in order, the first answer for a key wins and the second source is asked only for keys still empty — asserted by the second fixture's request log
- [ ] Two sources disagreeing produces no suggestion; a source disagreeing with a person's value produces exactly one card for the record listing every such field
- [ ] A changing figure newer than the stored one replaces it when the last writer is an integration; when a person set it, it is a card
- [ ] One timeline line per run names the sources, the field count and the credits
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Link a custom "Employees" attribute to headcount, put Website before Apollo, press Enrich on a company: the description comes from Website, headcount from Apollo, and the timeline reads "Enriched · Website, Apollo · 6 fields · 1 credit".

**Sheets** — Enrichment + Exa — printed, sheet 01 (sources in order; the "Fill from" window). **Spec** — D76 (vocabulary; the link on the attribute; ordered sources; Review only against a person); `docs/spec-plugin-sdk.md` §4 (ports); `packages/core/src/attributes/registry.ts`

#### `enrich-3` · afk · M — The built-in Website source — the domain read by the owner's own Extract lane, no key and no credit (D76)

**Blocked by:** `enrich-2`

**What to build**

The free source that runs first. A core source (not a plugin, so no install) registered in the enrichment order ahead of every paid one: the server fetches the company's domain — the home page, and an about page when the home page links one — under the same fetch rules the deck-link snapshot uses (size cap, timeout, no JavaScript), strips it to text, and runs the owner's **Extract** lane over it with a fixed schema answering vocabulary keys: `company.description`, `company.links` (LinkedIn, Twitter, Crunchbase, blog), `company.location` when stated, and the logo URL for `enrich-7`. It needs no key and spends no credit; its model is whatever the owner routes Extract to. **A sensitive record reads only through a local route**: when Extract is cloud-routed for a sensitive record the source skips and says why in the run's timeline line. Persons have no website and are skipped. It is on for every new record from install (D76's default).

**Acceptance criteria**

- [ ] The Website source is first in the default order and needs no credential; `ai_usage` attributes its tokens to the Extract lane, and no credit is counted
- [ ] Against a fixture site it answers description, links and location, which fill the linked attributes through `enrich-2`
- [ ] A sensitive record with Extract cloud-routed skips the source and the timeline says "Website skipped · sensitive"; with a local route it runs
- [ ] An unreachable domain, a 404 or a page over the size cap ends the source with its reason and the next source still runs
- [ ] With no AI model set up the source is absent from the order rather than failing (D80's zero-key list)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — With no Apollo key, add a company by domain: within seconds its description, LinkedIn and Twitter are filled, and the where-from says Website.

**Sheets** — Enrichment + Exa — printed, sheet 00 (Enrich · Website), sheet 01 (Website built in). **Spec** — D76 (free sources run first; what leaves the box); D80 (what works with zero keys)

#### `enrich-4` · afk · M — Auto-enrich checks and parking — the host's order, one job per record, the cap parks until reset; meetings and new identities trigger (D76)

**Blocked by:** `enrich-2`, `interaction-2`

**What to build**

The rest of D76's auto-enrich. **Two triggers** join `enrich-1`'s three: **appears in a synced meeting** (an `interaction.logged` event from `interaction-2`'s writer for a meeting participant, in the **meeting** scope) and **gains an identity** (an `identity.added` event when `setValues` adds a domain or an email to a record after birth). Both are `DOMAIN_EVENTS` additions, an SDK minor.

**The host checks, in order,** before a run is queued: in scope; not sensitive (else only local sources run); not enriched within `reuseDays`; has a key to look up (else it waits for `identity.added`); not already queued — **one job per record**, a singleton key on the record id; credits left today. At a source's daily cap (D53) the record is **parked**: the job is re-queued with `startAfter` at the next 00:00 UTC, never dropped. The host exposes one read for the Today notices band (the Today slice in project 27 renders it): "Auto-enrich paused · Apollo cap reached · 14 waiting · resumes 00:00 UTC". **No periodic refresh**: nothing re-enriches on a clock.

**Acceptance criteria**

- [ ] A participant of a synced meeting is enriched once when the meeting scope is on, and not when it is off
- [ ] Adding a domain to a company born without one enriches it once; a record with no key never queues until then
- [ ] The checks run in the order named, each asserted with a fixture that fails only that check; a record enriched within `reuseDays` is skipped
- [ ] Two triggers for one record inside a run queue one job (the singleton key)
- [ ] At the cap, further records are parked with `startAfter` at the next UTC midnight, the notices read returns the count and the source, and after the reset the parked records run and the count clears
- [ ] No schedule re-enriches a record on a clock — asserted by the worker's schedule list
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Set Apollo's daily cap to 3 and import nothing; add five companies to a deal: three enrich, two park, Today's notice reads "2 waiting · resumes 00:00 UTC", and advancing the clock past midnight runs them.

**Sheets** — Enrichment + Exa — printed, sheet 00 (limit reached); Today — printed, sheet 00 (the notices band). **Spec** — D76 (the host checks, in order; the cap parks; no periodic refresh); D53; D65

#### `enrich-5` · afk · M — Bulk enrich from a list, behind an estimate (D76)

**Blocked by:** `enrich-4`

_Amended 2026-10-10 (pre-check against main `3397486`): neither surface exists — `record-table.tsx` has no row selection and no list has a `···` menu. This slice adds both as table primitives: a row checkbox with a 44px bone selection bar on `RecordTable`, and a `···` on the list head; Enrich… is their first verb. Size S → M. Runs after email-4, which edits the same table and list files._

**What to build**

Seed and import births emit no events (D65), so they are enriched by choice: **Enrich…** in a record table's selection bar and in a list's `···` menu runs `enrichment.run` over the chosen records. Before anything is queued a window shows the estimate per source — records that would be asked, records skipped (sensitive, enriched within `reuseDays`, no key to look up), and credits at each paid source's rate against what is left today — with one pine **Enrich n**. Over the cap, the window says how many will park until the reset, and they park through `enrich-4`'s path. The estimate is a read; nothing is spent until the button.

**Acceptance criteria**

- [ ] Selecting 40 imported companies shows the estimate with the skip reasons counted separately and credits per source; cancelling queues nothing
- [ ] Confirming queues one job per record through the singleton key; records already queued are not doubled
- [ ] Over the cap, the window states how many park and they run after the reset
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Import a CSV of 40 companies, select all, Enrich…: "34 to ask · 6 skipped · about 34 Apollo credits of 100 left today", confirm, and the list fills over the next minute.

**Sheets** — Enrichment + Exa — printed, sheet 01. **Spec** — D76 (seed and import births are enriched in bulk from a list, behind an estimate); D53

#### `enrich-6` · afk · M — Apollo answers the full vocabulary — company and person fields, the latest round, a person's company, dated changes (D76)

**Blocked by:** `enrich-2`

_Amended 2026-10-10 (pre-check against main `3397486`): the "Add X?" card is an `add_record` suggestion, whose enum value is watch-1 and whose proposal path through `Discover.candidate` is watch-3 — both now blockers; Judgment proposals today are only `note` or `attribute`. Confirmed present: `isRoleEmail`, `plugins/apollo/src/map.ts`._

**What to build**

`plugins/apollo/src/map.ts` moves from slugs to `ENRICHMENT_VOCABULARY` keys and reads everything D76 lists, through `Facts.answer`, `Identity` and `Content`.

- **Company (by domain).** Built-in links: description (`short_description`, else `seo_description`), founded, location, LinkedIn. Identity: domains. **Funding stage** only when Apollo's wording matches one of the owner's options exactly; it never adds an option. The **latest round** with its date as a dated event, once per round (keyed on round and date). Vocabulary keys for the owner to link: total raised, headcount, revenue, industry, keywords, tech stack, Twitter, Facebook, AngelList, Crunchbase, blog, company phone, HQ address, ticker. The logo for `enrich-7`.
- **Person (by email or LinkedIn).** Built-in: job title, description (from the headline, only when blank), location, LinkedIn, Twitter. Identity: the email, only when Apollo marks it verified and it is neither a role address (`isRoleEmail`) nor locked. **Company link** to an existing company only, filled only when empty; an unknown company is proposed as an "Add X?" card (`add_record`). Enriching a person never creates a company. Vocabulary keys: seniority, department, GitHub, Facebook. The photo for `enrich-7`. **Phone** is a manifest setting, off by default, and costs Apollo's extra credits when on. Employment history is not stored: a changed title or company on a later run is logged as a dated event ("Moved from Keyhold to Flent as COO").
- **Changing figures** (headcount, revenue, total raised) carry their date into the where-from (`enrich-2`).
- **Not used:** departmental head count, Alexa ranking, retail location count, Apollo's tag ids. Apollo's org and person ids stay in the receipt for an exact re-match and are never shown.

The source page says what Apollo is sent: "domain only" for companies, "email and LinkedIn URL" for people.

**Acceptance criteria**

- [ ] Against cassettes, a company answer fills the built-in links and the linked keys, and every unlinked key is in the receipt and nowhere else
- [ ] A funding stage "Series A" fills an option labelled "Series A"; "Series A1" with no such option fills nothing and adds no option
- [ ] The latest round is one dated event; a second run with the same round writes nothing
- [ ] A person whose company exists links to it only when the link is empty; an unknown company yields one "Add X?" card and no company row
- [ ] An unverified, role or locked email is not claimed as identity — three fixtures
- [ ] Phone is absent unless the setting is on; a changed title on a second run writes one dated event
- [ ] `grep` shows no Apollo special case in core; the map stays pure and is tested with no database
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enrich Flent: description, founded, headcount and total raised fill, the Series A round appears dated on the timeline; enrich its COO: title and LinkedIn fill, the company links to Flent, and a second COO whose company is unknown offers "Add Keyhold?".

**Sheets** — Enrichment + Exa — printed, sheet 01 (Apollo's source page: sends, can fill n fields). **Spec** — D76 (what Apollo fills); D75 (identity is a unique attribute); `plugins/apollo/src/map.ts`

#### `enrich-7` · afk · S · migration — Records gain a picture — a logo or a photo, filled only when empty (D76)

**Blocked by:** `enrich-3`. **Label:** `migration` — runs alone on the migration lane.

_Amended 2026-10-10 (pre-check against main `3397486`): there is no blob refcount — `blobIsReferenced` in `lib/documents/blob-refs.ts` must learn `entity.picture_sha` (and runs after settings-6 adds the logo there). "A cleared picture is user-held" has no storage, since `lastWriters` reads `attribute_event` per slug: the same migration adds `entity.picture_held boolean not null default false`, set when a person uploads or clears by hand; the host fills only when `picture_sha is null and not picture_held`._

**What to build**

A company or a person can carry a picture, new and small. It needs schema: `entity.picture_sha` (nullable text), a blob sha in the blob backend. The picture is **fetched once and stored**, never hotlinked, because a remote image loads from a third party on every view (the same reason the email viewer blocks remote images, D67). The source answers a URL (`company.logo`, `person.photo` from the Website source or Apollo); the host fetches it under the snapshot rules (image types only, a size cap), stores it as a blob, and sets `picture_sha` **only when empty**. A person can set or clear it by hand, and a cleared picture is user-held like any cleared value. Where a record shows its mark today — the record head, table rows, the board card, Cmd-K — the picture replaces the 1-bit mark or the initials square when present, cropped square at the mark's size. The blob's refcount counts it so GC never takes a picture in use.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name entity_picture`, SQL hand-inspected; `entity.picture_sha` nullable, not an `ENTITY_REFS` entry (it references a blob, not an entity)
- [ ] A logo answer fetches, stores one blob and sets the picture when empty; a second answer for a record with a picture changes nothing
- [ ] A non-image or oversize response sets nothing and is noted in the run line
- [ ] Clearing the picture by hand keeps it clear on the next enrichment
- [ ] The head, rows, board and Cmd-K draw the picture at the mark's size and fall back to the mark without one; no remote URL is ever rendered
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Enrich Flent with the Website source: its logo replaces the dither mark in the head, the Companies table and the board; clear it, re-enrich, and it stays cleared.

**Spec** — D76 (records gain a picture, filled only when empty); D67 (remote images never load)

#### `enrich-8` · afk · M — The Enrichment page, the source page, "Fill from", and where a value came from (D76)

**Blocked by:** `enrich-2`, `enrich-4`

_Amended 2026-10-10 (pre-check against main `3397486`): blocked by settings-1, settings-2 and settings-4 (the Integrations group, the Save bar with member read-only, the plugin page template), enrich-3 (Website built in) and enrich-6 (Apollo's phone opt-in). The stored scopes are `deal`, `space` and `meeting`; "the five triggers as checkboxes" renders the five trigger words grouped under those three scopes._

**What to build**

The surfaces D76 draws, on Enrichment + Exa — printed, sheets 00 and 01.

- **Settings → Integrations → Enrichment** (D81's map): **Sources in order** — Website (built in) first, then each installed source with its mark, what it sends ("domain only", "email and LinkedIn URL"), its state and a drag to reorder; **Auto-enrich** — the five triggers as checkboxes per scope with D76's defaults, and re-use days; **What fills what** — per object, a grid of linked attributes against sources, showing which source answers each; **Recent runs** — the last runs with record, sources, fields and credits.
- **A source's own page** (Apollo first) is thin, on D81's plugin template: the key, what it sends, the daily limit, the phone opt-in, "can fill n fields" linking back to the grid, Uninstall. It never repeats the Enrichment page's settings.
- **"Fill from"** on an attribute's edit window: the vocabulary key it is linked to, chosen from the keys of its object's kind and value type.
- **On a record:** the **Enrich** action shows the sources it will ask (Website, then More sources › when only free sources are on, D80); a filled value's **where-from popover** names the source, the date and, for a changing figure, its earlier values with dates; the states D76 draws (running, done with counts, limit reached with the reset time, sensitive → local sources only).

Exa as an optional enrichment source arrives later (D77: after Research, Find and the watch, off until enabled); it is one more row in the order, with no host change.

**Acceptance criteria**

- [ ] The Enrichment page lists sources in the stored order with what each sends; reordering writes `workspace.settings.enrichment.sources` and the next run follows it
- [ ] Auto-enrich checkboxes and re-use days write the same settings and `enrich-4`'s checks read them
- [ ] The grid shows, per linked attribute, the first source in order that can answer it; an unlinked attribute shows "not linked" and "Fill from…"
- [ ] Apollo's page carries only the template's parts and links to the grid; a member sees the page read-only (D81)
- [ ] The where-from popover on a filled headcount shows the source, the date and the earlier figure with its date
- [ ] Gate 5 passes; the page follows the settings page behaviour (one Save bar for typed fields, toggles instant, D81)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Open Settings → Enrichment, drag Apollo above Website, link "Employees" in the grid, then open a company and hover its headcount: "Apollo · 10-04 · was 42 on 07-12".

**Sheets** — Enrichment + Exa — printed, sheet 00 (Enrich on a record; the where-from popover), sheet 01 (the Enrichment page, Apollo's source page, the "Fill from" window). **Spec** — D76; D77 (Exa's order); D80 (More sources ›); D81 (Integrations → Enrichment; the plugin page template)

## Unplaced — slices added after the plan

_Not part of the 98 and not in any project's order. Each carries the decision it implements. Published to Linear as one project, "Corrections", with the rest (2026-10-06): no blockers, grabbable now; `review-1` precedes `watch-1`, `graph-1` precedes `rel-1`, `enrich-1` and `email-9`._

#### `graph-1` · afk · M · migration — A person's companies become an attribute (D60)

**Blocked by:** none. **Label:** `migration` — runs alone on the migration lane.

**What to build**

"This person is at that company" is `link(contact_at)` today, written by hand outside the attribute engine: `createPerson` and `setPersonCompany` in `apps/web/src/lib/server/people.ts` insert and delete the link, `listPeople` / `listPeopleTable` / `getPerson` and the company page (`apps/web/src/lib/server/companies.ts`) read it, and the demo and dev seeds write it directly. It has no history, no provenance, no view column, no import mapping, and `listPeople` keys a `Map` by person, so a person at two companies shows one.

Per D60, add a system attribute to `SYSTEM_ATTRIBUTES.person` in `packages/core/src/attributes/registry.ts`: slug `companies`, name "Companies", type `record_reference`, options `{ targetKind: 'company', multi: true }`. Every writer goes through `setValues`, which syncs `link(references, attr_slug: 'companies')` like `deals.people`. A hand-written data migration converts existing data: each person's `contact_at` targets become the `companies` array in `entity.values`, and the link rows are rewritten in place to `relation = 'references'`, `attr_slug = 'companies'` (no unique-index collision is possible — no such rows exist yet). Its journal `when` is the clock at write time. The `contact_at` enum value stays (Postgres cannot drop one cheaply); nothing writes it afterwards.

Readers switch to the attribute: the people list and table read `values.companies`, the company page reads `references` links with `attr_slug = 'companies'`, and the person record shows the attribute in its rail like any other. `founders` is untouched.

**Acceptance criteria**

- [ ] `companies` is seeded on the people object (insert-if-absent), `record_reference`, `targetKind: 'company'`, `multi: true`
- [ ] `createPerson` with a company and `setPersonCompany` write through `setValues`; each change leaves an `attribute_event` and a `references` link with `attr_slug = 'companies'`
- [ ] The migration converts every `contact_at` link: the person's `values.companies` holds exactly its former targets, and no `contact_at` row remains
- [ ] A test asserts no code path inserts `relation: 'contact_at'` (seeds included)
- [ ] A person at two companies shows both in the people list and on both company pages
- [ ] People can be filtered and sorted by Companies in a saved view, and an import maps a Company column onto it
- [ ] Merging two companies repoints `companies` values and links on every person (the existing `links` merge section covers it — asserted, not assumed)
- [ ] The context assembler reaches a person's companies through `references` at weight 1; the slice records whether that ranking change is wanted
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — On a dev database with `contact_at` links, run the migration: every person's Companies column is filled, the company pages list the same people as before, and adding a second company to a person shows on both companies and in the person's history.

#### `review-1` · afk · S — The review queue is "Review", at /review (D61)

**Blocked by:** none, but land it after any open `apps/web` route work, since it regenerates `routeTree.gen.ts`.

**What to build**

Rename the page at `routes/_app/inbox.tsx` to `routes/_app/review.tsx` (route `/review`). `/inbox` becomes a redirect route shaped like `routes/_app/dedupe.tsx` today (301, `replace: true`), and `dedupe.tsx` points at `/review` directly so nothing chains two redirects. Add `review` to `RESERVED` in `packages/core/src/writes/attributes/object-registry.ts`; keep `inbox` and `dedupe` there. Change every link to `/inbox` (`components/attributes/ai-cell.tsx`, `components/record/waiting-rail.tsx`, `routes/_app/companies.tsx`, the page's own links, Today's tile) and every user-facing string that says "inbox" to "Review" or "review". Run `pnpm generate-routes`. Internal module and type names (`lib/inbox/`, `components/inbox/`, `InboxLane`) stay.

**Acceptance criteria**

- [ ] `/review` renders both lanes, suggestions and duplicate candidates, exactly as `/inbox` did
- [ ] `/inbox` and `/dedupe` each answer one 301 to `/review`, with no redirect chain
- [ ] No user-facing string says "inbox" (a grep over `apps/web/src` string literals and JSX text, excluding the arrival lane's IMAP `INBOX` folder, finds none)
- [ ] Creating an object whose slug would be `review` is refused, as `inbox` is
- [ ] `apps/e2e` specs that visit `/inbox` are updated, or pass through the redirect
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Press ✦ on an AI attribute cell: the toast says the proposal is waiting in Review, the cell's pointer opens `/review`, and an old `/inbox` bookmark lands on the same page.

#### `vault-1` · afk · S · migration — One workspace credential per provider, enforced by the database

**Blocked by:** none. **Label:** `migration` — runs alone on the migration lane.

**What to build**

`credential_user_unique` is `(scope, provider, user_id)`, and a workspace row has `user_id = null`. Postgres treats nulls as distinct, so the index never stops two workspace rows for one provider. The write path (`storeCredential` in `packages/core/src/writes/vault/index.ts`) covers the ordinary case with `select … for update` then insert, but `for update` locks nothing when no row exists yet: two first-time saves of one provider at the same moment both insert, and the reader's `limit 1` then picks either key.

Replace the index with the same columns declared `nulls not distinct` (Postgres 15+; the supported image is 17), so one index covers user and workspace rows alike. Before creating it, the migration collapses any duplicates already present: per `(scope, provider, user_id)`, keep the most recently created row, repoint `mailbox.credential_id`, `integration.credential_id` and `ai_run.credential_id` at it, then delete the rest. With the index in place, both branches of the write path become one `insert … on conflict (scope, provider, user_id) do update`, and the `for update` read goes.

**Acceptance criteria**

- [ ] Migration generated with `pnpm db:generate --name credential_unique_nulls`, SQL hand-inspected; the duplicate collapse runs before `create unique index`
- [ ] On a database seeded with two workspace rows for one provider, the migration leaves one row, and every `mailbox`, `integration` and `ai_run` row that pointed at the other now points at it
- [ ] Inserting a second workspace credential for a provider raises a unique violation
- [ ] Two concurrent first-time saves of one workspace provider leave exactly one row (a test that races two transactions)
- [ ] User-scoped credentials behave as before: one per `(scope, provider, user)`, upserted on save
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Save an OpenAI key twice from two tabs at once: one row in `credential`, and the key in use is the last one saved.

#### `sensitivity-1` · afk · M — A record turning sensitive re-stamps its chunks at once

**Blocked by:** none. Carved out of `storage-18`: this is its half that does not need storage bindings.

**What to build**

`chunk.sensitive` is a cached copy of the sensitivity resolver, written only by `stampSensitivity(entityId)` (`apps/web/src/lib/ai/stamp-sensitivity.ts`), and today only the embed job calls it. So a record flagged sensitive after it was embedded, a document filed into a sensitive space, or a space flagged sensitive leaves its chunks stamped `false`. Calls that send bytes out (`complete()`, `embed()`) resolve live and are unaffected; the stale column matters to the embed backfill's pass today and to retrieval's SQL filter once that lands.

Apply `storage-18`'s asymmetry without the binding input: **raising is synchronous, lowering is a job.**

- **Raise, in the same transaction as the change:** `setEntitySensitiveProgram` setting a record's flag stamps that record's chunks; on a space, it stamps every entity filed in the space or any descendant space (`entity_space` joined through `space.path`), as one set-based update. Filing into a space (every `entity_space` insert: `lib/spaces/tag.ts`, `lib/notes/create.ts`, `lib/documents/refile.ts`, `packages/core/src/writes/documents/birth.ts`) stamps the filed entity when the space resolves sensitive.
- **Lower, by a job:** clearing a flag or unfiling (`lib/documents/refile.ts`, `lib/server/companies.ts`) enqueues one `sensitivity.restamp` job per affected entity, keyed by entity id. The job calls `stampSensitivity`, which resolves live, so an entity still sensitive through another input stays stamped.
- `stampSensitivity` stays the only writer of the column. The set-based raise is a second function in the same module, named in the column comment.

Out of scope: storage bindings (stay in `storage-18`), and the workspace default, which has no writer yet. When one lands it raises every chunk synchronously and lowers through the same job.

**Acceptance criteria**

- [ ] Flagging an embedded document sensitive sets every one of its chunks `sensitive = true` before the request returns
- [ ] Flagging a space sensitive stamps the chunks of every entity filed in it and in its descendant spaces, in one transaction
- [ ] Filing an embedded document into a sensitive space stamps its chunks in the filing's transaction
- [ ] Clearing the flag or unfiling enqueues the restamp job; after it runs, chunks are `false` only if no other input keeps the entity sensitive (a test files one document in two sensitive spaces, unfiles one, and asserts it stays `true`)
- [ ] No code outside `stamp-sensitivity.ts` sets `chunk.sensitive` (a test asserts it, seeds included)
- [ ] Full gate pass: typecheck, test, lint, prettier

**Demo** — Embed a deck, then flag its company's space sensitive: `select sensitive from chunk` for the deck turns `true` immediately. Unflag it: after the job runs, it turns back to `false`.
