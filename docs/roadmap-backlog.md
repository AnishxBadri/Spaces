# Backlog bodies — projects 14 to 23

_The 98 slices that were **not** published to Linear. For projects 1–13 the Linear issues are the store of record and this file carries nothing; for 14–23 nothing else holds the substance, so it lives here._

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

The mapping step. Each source column takes exactly one target: the record's name, an attribute of the chosen object, one of the object's identity keys, or ignored. Because the attribute registry already is the type system, the mapping is generated from it and custom objects work with no importer code — that is the whole reason this is cheap. Identity-key targets come from one helper: the core four (domain, email, linkedin, cin) for company and person, and `object.identity_keys` for a custom object, which objects-5 declares — the repo must not grow a second notion of what identifies a record. Auto-guess is deterministic: slugify the header, match an attribute slug, then an attribute name, then a small alias table (`Website` → domain, `Company` → name, `Round` → the deal's stage), and default to ignored when nothing matches, never to a guess. The mapping persists on `import_batch.mapping` so leaving the wizard and coming back resumes. Archived attributes and types no cell can carry are not offered.

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
- [ ] docs/CODEBASE.md and docs/tour/* hosting lines are re-pointed at these documents instead of repeating them
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

An identity claim carries domain, email, linkedin and cin keys, and the plugin must normalize them the same way the choke point does — but src/lib/entities/normalize.ts is core, and plugins import only the SDK. Today Apollo would have to reimplement normalizeDomain and isRoleEmail, and the role-email rule (CONTEXT: role emails never identify a person) would drift between the plugin and resolveEntity. Move the pure normalizers (normalizeDomain, normalizeEmail, normalizeLinkedin, normalizeCin, normalizeName, isRoleEmail) into @spaces/sdk, which has no internal deps, and have src/lib/entities/normalize.ts re-export them so resolve.ts and every existing caller are unchanged. normalize.test.ts moves with the code and must pass unmodified — that is the proof the behaviour did not shift. Small, mechanical, and it removes the single most likely source of silent identity drift once third-party plugins exist.

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

_Extensibility · 10 slices_

A Layer per (integration, job), queues by kind, the breaker, hot reload, then Apollo end to end with credit safety, manifest actions, live status and event triggers.

### ▸ A Layer per job, and queues by kind

_The privilege boundary is built and released per (integration, job): an over-reaching job fails with service-not-found while the database stays clean and the worker stays up. Queues register, schedule and unregister without a restart._

#### `sdk-12a` · afk · M — A Layer per (integration, job) — the privilege boundary, built and released

**Blocked by:** `sdk-11`, `sdk-6a`, `sdk-6b`, `sdk-7a`, `sdk-7b`, `sdk-9`

**What to build**

The half of loader step six that is actually interesting: for each loaded plugin, build a scoped Layer per (integration, job) from the kind-to-ports table exported by the SDK, bound to that row's config, credential and id; cache it; and release it cleanly. The Layer is the boundary — a bundle that lies in its types gets a runtime service-not-found because the host never handed the service over, and the job fails without writing anything. This slice is demoable without pg-boss: an exported invoke(integrationId, jobName, data) runs a job through its Layer directly, which is also what the queue registration in sdk-12b wraps. definePlugin's onEnable and onDisable hooks are called here, on transition into and out of enabled, with a failing hook degrading the plugin rather than crashing the worker. Split from registration because a Layer with nothing provided and a queue name with no Layer are each undemoable, but Layer construction alone is not.

**Acceptance criteria**

- [ ] An enricher fixture invoked through the loader has Identity, Facts, Receipts, Http, Secrets, Config, Read and Log available and nothing else; a poller fixture that yields Facts fails with service-not-found mapped to permanent failure, and the database shows no write from that run
- [ ] Layers are cached per (integration, job): two invocations of the same job build one Layer, asserted by a construction counter
- [ ] The kind-to-ports table used at runtime is the one exported from the SDK — one table, asserted by the same test that checks it against the spec
- [ ] onEnable runs once when a plugin transitions to enabled and onDisable when it is released; a hook that throws degrades that plugin with the message in last_error and leaves the others running
- [ ] Releasing a plugin releases the Layer scope so any open Http client or pg handle closes, asserted by a finalizer counter
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the echo and poller fixtures enabled, call the loader's invoke seam for plugin echo's job and watch it write its claim through the ports; invoke the poller's deliberately over-reaching job and watch it fail with service-not-found while the database stays clean and the worker stays up.

**Spec** — docs/spec-plugin-sdk.md §7 step 6; docs/spec-plugin-sdk.md §4 (ports granted per integration and job)

#### `sdk-12b` · afk · M — Queues by kind — register, schedule, unregister without restarting

**Blocked by:** `sdk-1`, `sdk-12a`

**What to build**

Loader step seven: for every declared job, createQueue and boss.work('plugin.<id>.<job>', runJob(...)) using the Layer sdk-12a built; boss.schedule those with a cron and timezone; and make disable the exact reverse — unregister, release the scope, forget the module. The manifest's concurrency and timeout become the work options, and interactive jobs get their own queue name so sdk-18 can give them a separate batch size later. Web's enqueue() is typed against the QUEUES const today, so its signature widens to accept a plugin queue name shaped plugin.${string}.${string}; no other web change. Schedules must be reconciled, not appended: a job that drops its schedule on upgrade has to be unscheduled, or the old cron keeps firing against a job that no longer exists.

**Acceptance criteria**

- [ ] Every declared job is createQueue'd and registered as plugin.<id>.<job> through runJob with the manifest's concurrency and timeout; enqueuing one runs it end to end
- [ ] A job declaring a schedule is registered with boss.schedule at the manifest's cron and timezone; removing the schedule from the manifest and reloading unschedules it, asserted by reading pg-boss's schedule table
- [ ] Releasing a plugin unregisters its queues; a subsequently enqueued job for it stays queued rather than erroring, and re-enabling drains it
- [ ] enqueue() accepts plugin queue names without weakening the core QueueName type — a typo'd core queue name still fails typecheck
- [ ] A manifest declaring interactive: true registers that job on its own queue name, with the behaviour of that queue left to sdk-18
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the echo fixture enabled, enqueue plugin.echo.run from a psql-side send or the dev app and watch the worker run it; disable the row and reload, enqueue again, and watch the job sit queued while the extraction queue keeps working.

**Spec** — docs/spec-plugin-sdk.md §7 step 7; docs/spec-plugin-sdk.md §11 (queue names encode ownership)

### ▸ Failures disable the plugin, never the worker

_Five failures fill job_run, flip the integration to disabled with a reason and put one line on Today while extraction keeps working in the same worker. Enable, disable and upgrade happen over NOTIFY with no restart, and the exit-75 escape hatch is reconciled with the either-process-dies contract._

#### `sdk-13` · afk · M — Plugin breaker — five failures disable the integration, never the worker

**Blocked by:** `clean-2b`, `sdk-12b`

**What to build**

The plugin half of failure handling, with the table it used to create now owned by clean-2b. Two things land here. First, attribution: the Layer sdk-12a builds knows which integration a job belongs to, so runJob's existing `job_run` insert learns to stamp `integration_id` for plugin queues and leave it null for core ones — a widened call at the one write point, not a second insert site. Second, the breaker: a permanently failed plugin job increments `integration.error_count` and stamps `last_error` in the same transaction that closes the job_run row, and N failures inside an hour — grouped on the queue name's `plugin.<id>` segment — set the integration to disabled with the reason and unregister its queues. Breaker-disabled and operator-disabled must stay distinguishable, so the breaker sets `status` disabled with a reason while leaving `enabled` true: re-enabling is a reset, not a reinstall, which is exactly the distinction sdk-20a renders. Contract 2 means the worker process survives all of it. Today's line reuses the existing LedgerSection and LedgerRow, so there is no new visual language.

**Acceptance criteria**

- [ ] A job registered from a plugin Layer writes `job_run.integration_id`; a core job leaves it null — and clean-2b's single-writer test stays green, because no new insert site is added
- [ ] A permanently failed plugin job increments `integration.error_count` and stamps `last_error` with the typed failure tag, in the same transaction that closes the job_run row
- [ ] Five failures of the throws fixture inside an hour set `integration.status` to disabled with reason '5 failures in an hour' while `integration.enabled` stays true, unregister its queues, and leave the worker process running and the extraction queue working
- [ ] The breaker groups on the queue name's `plugin.<id>` segment: two plugins failing in the same hour disable independently
- [ ] Unregistering from inside a failing job's own handler does not deadlock or drop the in-flight batch, asserted by a test that trips the breaker on the fifth job of a batch
- [ ] Successes reset the failure window: four failures, then a success, then one failure does not trip the breaker
- [ ] Today shows one line per tripped plugin using the existing LedgerSection and LedgerRow, and it clears when the integration is reset (a SQL update at this point; the button lands with sdk-20a); gate 5 passes on the touched tsx
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Enqueue the throws fixture five times: job_run fills with failures attributed to the integration, the integration flips to disabled with a reason, one line appears on Today, and the extraction queue keeps working in the same worker. Reset error_count by SQL and the line clears.

**Spec** — docs/spec-plugin-sdk.md §11 (isolation, breaker, queue-name grouping); CONTEXT.md — Hostability decisions (contract 2); clean-2b (job_run and its single writer)

#### `sdk-14a` · afk · M — NOTIFY plugin_changed — enable, disable and upgrade without a restart

**Blocked by:** `sdk-12b`

**What to build**

There is no LISTEN client and no NOTIFY anywhere in the codebase; this adds the first. The worker holds a dedicated pg connection listening on plugin_changed; a notification carrying a plugin id re-runs the loader for that one id — release the old scope, unregister its queues, forget the module, then reconcile from disk and the row. Forgetting an ESM module is the sharp edge: import() caches by URL, so a version swap must import the new version's path (which the version-directory layout gives us) and the reload must assert the new bundle actually ran rather than the cached one. The connection reconnects with backoff and reconciles everything on reconnect, because a missed notification must not leave the worker's view stale. The exit-75 fallback is deliberately not here — it changes the supervision contract and is sdk-14b.

**Acceptance criteria**

- [ ] With the worker running, flipping a fixture row to enabled and calling pg_notify('plugin_changed','echo') registers its queues within a second and an immediately enqueued job runs, with no restart
- [ ] Disabling by the same route unregisters queues and releases the Layer scope; an already-running job finishes rather than being killed mid-write
- [ ] Swapping current to a new version directory and notifying runs the new bundle, asserted by a fixture whose two versions return different claims — the ESM cache does not serve the old module
- [ ] Killing the LISTEN connection with pg_terminate_backend reconnects within the backoff window and performs a full reconciliation rather than a resume, asserted by changing a row while the connection is down
- [ ] Reload is reentrant: two notifications for the same id arriving together produce one reconciliation, not two competing ones
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Two terminals — worker in one, psql in the other. Update the row and NOTIFY: the worker log shows unregister, reload, register, and an enqueued job runs immediately. Then terminate the listener's backend and watch it reconnect and reconcile.

**Spec** — docs/spec-plugin-sdk.md §7 (runs on boot and on NOTIFY plugin_changed); docs/spec-plugin-sdk.md §10 (split roles, NOTIFY crosses processes)

#### `sdk-14b` · hitl · S — Exit-75 reload — the escape hatch that argues with contract 2

**Blocked by:** `sdk-14a`

**What to build**

The spec's documented fallback when in-process reload proves unsafe is worker exit code 75, which the entrypoint treats as reload rather than crash. That directly contradicts what docker/entrypoint.sh implements and comments today: ROLE=worker execs the worker (so the shell is gone and cannot interpret its exit code at all), and ROLE=all deliberately kills the container when the worker exits, which is hostability contract 2 written down as a supervision rule. Implementing exit-75 means replacing exec with a supervise loop in ROLE=worker and carving an exception into the ROLE=all watchdog — a change to a locked contract, which is why a human decides rather than an agent. The alternative on the table is to not build it and let sdk-14a's in-process reload stand alone, with restart the operator's remedy. Small either way; the argument is the work.

**Acceptance criteria**

- [ ] A decision is recorded in CONTEXT.md under Hostability decisions: either contract 2 gains a named exception for exit 75, or exit-75 is dropped and the spec's fallback is struck
- [ ] If built: ROLE=worker supervises rather than execs, restarting the worker on exit 75 and exiting the container on any other non-zero code; ROLE=all restarts only the worker on 75 and still kills the container on every other worker exit
- [ ] If built: a test or scripted check drives both roles with a worker that exits 75 and one that exits 1, asserting reload versus container exit
- [ ] If built: the restart loop is bounded — repeated exit 75 within a short window stops rather than spinning, with the reason logged
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — With the split-role compose overlay up, send the worker a signal that makes it exit 75: the container stays up and the worker comes back with plugins reloaded. Make it exit 1: the container stops, exactly as contract 2 says.

**Spec** — docs/spec-plugin-sdk.md §7 (exit 75 fallback); CONTEXT.md — Hostability decisions (contract 2); docker/entrypoint.sh

### ▸ Apollo enriches a company

_Paste a key, see the Enrich action appear on records rendered from the row's manifest, click it and watch blanks fill with Apollo as actor and the raw payload in an enrichment_record — credit-capped, 90-day cached, refusals visible on Today. This is the plugin arc's undeclared L and should be split at the provider-client seam before it is grabbed._

#### `sdk-15` · afk · M — Apollo's mapping — provider JSON becomes claims, with no database

**Blocked by:** `sdk-4b`, `sdk-5`

**What to build**

plugins/apollo as a real bundle: a manifest declaring requires.credential { kind: 'enrichment', scope: 'workspace' }, the settings the operator fills, its http config, and the enricher's three methods — enrichCompany, enrichPerson, estimateCost — written against the SDK's port tags and nothing else. The job reads the entity's domain through Read, calls organizations/enrich and people/match through Http with X-Api-Key from Secrets (the header-driven self-throttle belongs to HttpLive and is declared here as manifest.http, never a second rate limiter), maps provider JSON into identity and fact claims, and stores the raw response through Receipts. Role emails are rejected using the normalizers the SDK exports, not a second copy of the list. Apollo's own error text rides on the typed failure instead of being swallowed, and a 402 or 403 from a paid-plan-only endpoint is permanent rather than retried. All of it is provable with the testing kit's recording Layers against committed fixtures derived from Apollo's documented response shapes with secrets scrubbed — no database, no network, no integration row, and nothing from the live-port arc.

**Acceptance criteria**

- [ ] plugins/apollo builds to bundle.mjs plus manifest.json and imports @spaces/sdk only — a core or db import fails lint
- [ ] against the committed fixtures, enriching by domain produces one identity claim carrying the domain, fact claims for the mapped attributes, and one receipt; the claim snapshot is committed
- [ ] a person match returning only a role email (info@, careers@) emits no identity claim for that person, using the SDK's isRoleEmail rather than a local list
- [ ] a 402 or 403 fixture fails the job permanently — not retried — carrying Apollo's own message on the typed failure, asserted through the testing kit's recorder
- [ ] estimateCost(n) returns credits from the manifest's declared pricing without touching Http, and each job's R type names no port the enricher kind is not granted
- [ ] DATABASE_URL= pnpm vitest run plugins/apollo is green with Postgres stopped and the network off; the committed fixtures carry no key material
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — DATABASE_URL= pnpm vitest run plugins/apollo with the network off: the committed Apollo fixtures produce a snapshotted claim set — one identity claim with the domain, the mapped fact claims, one receipt — the role-email fixture produces no identity claim, and the 402 fixture fails permanently carrying Apollo's own sentence.

**Spec** — docs/spec-plugin-sdk.md §5; docs/spec-plugin-sdk.md §4 — kind → ports; docs/spec-plugin-sdk.md §13 step 1; CONTEXT.md — Enrichment (Apollo endpoints, headers, error text)

#### `sdk-16` · afk · M — Credit safety — daily cap, 90-day cache, refusals that are visible

**Blocked by:** `sdk-13`, `sdk-15`

**What to build**

CONTEXT is blunt that the first issue anyone files is someone torching credits on four thousand companies. The draft left where the guards live as an open question; it is settled here, because the SDK's public surface must not move for it. Both guards are core-side, enforced at the same place privilege is — in the enricher wrapper the loader builds — so a plugin cannot bypass them and Receipts keeps its single store() method. The cache reads the entity's most recent enrichment_record for this integration; the cap sums enrichment_record.credits_used for this integration since UTC midnight, which is why it survives a worker restart. A refusal is a first-class visible outcome: job_run closes with a skipped or refused status and a reason, never a silent success. cacheDays and dailyCreditCap are ordinary manifest settings so no surface special-cases Apollo.

**Acceptance criteria**

- [ ] Enriching an entity whose most recent enrichment_record for this integration is younger than the configured cacheDays makes no provider call and closes job_run with the skipped status and reason 'cached (enriched 12 days ago)'
- [ ] With dailyCreditCap set to 2, the third enrich job of the day fails with a typed CreditCapExceeded, makes no provider call, and surfaces one line on Today; gate 5 passes on the touched tsx
- [ ] The credit count is per integration per UTC day and derived from enrichment_record rows, asserted by a test that restarts the guard mid-day and gets the same count
- [ ] Both guards live in the enricher wrapper, not in the plugin: a fixture plugin calling Http directly for the same entity still trips the cap, asserted by test
- [ ] cacheDays and dailyCreditCap are declared in the manifest settings schema so the Integrations page renders them without special-casing Apollo
- [ ] The job_run status values this needs are agreed with the clean area rather than added ad hoc; the migration adding them (if any) is hand-inspected
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Enrich a company twice in a row: the second run logs 'cached, 0 credits' and job_run shows skipped. Set dailyCreditCap to 2 and enqueue three: the third fails with the cap named and Today shows it.

**Spec** — CONTEXT.md — Enrichment (credit safety); docs/spec-plugin-sdk.md §4 (Receipts); docs/spec-plugin-sdk.md §11 (job_run)

#### `sdk-17` · hitl · M — Manifest actions — the Enrich button, rendered from the row's manifest

**Blocked by:** `sdk-11`, `sdk-15`

**What to build**

Web renders actions from integration.manifest, the jsonb the loader wrote on reconcile, and never loads a bundle or reads /data: for enabled integrations it puts the declared actions on the record pages whose object matches the action's on field and enqueues plugin.<id>.<job> with the entity id through a server fn. This is the first plugin-driven UI in the product and needs a human against DESIGN.md — where an action sits on a record page, what it looks like while it is nothing but a queued job, and how an action for a degraded plugin reads (absent, or present and explaining itself). Gate 5 applies: Instrument vocabulary only. Permissions follow the existing shape — any member can fire an action, only admins reach settings and keys, which requireAdmin already enforces.

**Acceptance criteria**

- [ ] With Apollo enabled and keyed, a company record shows its declared Enrich action; with Apollo disabled or degraded the action is absent; the web build contains no import of plugins/* and no read of the plugins directory, asserted by a build-output grep test
- [ ] Clicking enqueues plugin.apollo.enrich with the entity id and returns immediately; a job_run row appears
- [ ] An action declared on: 'person' does not appear on company or deal records
- [ ] A non-admin member can fire the action and cannot reach Settings; requireAdmin covers the settings path and requireUser the action path
- [ ] No new route file is added (the action is a component plus a server fn); if one is, pnpm generate-routes is run and routeTree.gen.ts is committed
- [ ] Gate 5 passes on the new tsx: no v1 tokens, Instrument vocabulary only
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Open a company record with Apollo enabled: the Enrich action is there, and firing it produces a job_run row and, seconds later, filled blanks. Disable Apollo and reload: the action is gone, with no code change.

**Spec** — docs/spec-plugin-sdk.md §3 (actions); docs/spec-plugin-sdk.md §11 (manual trigger); DESIGN.md

### ▸ Under a second, and on creation

_LISTEN/NOTIFY to SSE so the cell goes pending then resolves with no refresh, survives a mid-run reload, and settles into failure rather than spinning when the worker dies. New companies with a domain enrich themselves on creation, with the emitter's home decided._

#### `sdk-18` · hitl · M — Interactive status — LISTEN/NOTIFY to SSE, so 'later' is under a second

**Blocked by:** `sdk-13`, `sdk-14a`, `sdk-17`

**What to build**

The cost of every plugin result being a job is that nothing renders inline in a request; the mitigation the spec names is an eager job plus a status stream. Jobs declaring interactive: true get a low batch size and a short timeout on the queue sdk-12b already gave them; job_run transitions emit a NOTIFY, and a server-sent-events route relays them to the record page, so the cell reads 'Enriching…' and then the outcome without polling. This puts a second long-lived pg client in the product, this time in the web process — worth stating, because it is the first thing web holds open. New interaction pattern and new UI, so a human reviews: what pending looks like in a ledger cell, what a failure reads as, and how a reconnect avoids a flash. Reopening the page must recover state from job_run, not from a stream that already fired.

**Acceptance criteria**

- [ ] A new route file under src/routes/api/ serves the stream; pnpm generate-routes is run and routeTree.gen.ts is committed
- [ ] A job declaring interactive: true runs on its own queue with batchSize 1 and the manifest's short timeout; batch jobs never starve it
- [ ] Firing Enrich shows a pending state in under 200ms locally and flips to the outcome when the job closes, with no polling request in the network tab
- [ ] Closing and reopening the record while the job runs shows the same pending state, read from job_run
- [ ] A dropped SSE connection reconnects and resyncs from job_run rather than showing a stale pending forever, and the stream carries nothing the viewer could not read (canRead as the viewing user, never as the integration)
- [ ] The web-side LISTEN client is one connection shared by all subscribers, released on process shutdown, and its existence is documented in the module comment
- [ ] Gate 5 passes on the new tsx; pending and failed states use existing Instrument components
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Click Enrich on a company and watch the cell go pending then resolve with no page refresh; mid-run, reload the page and see the pending state restored; kill the worker mid-run and watch the cell settle into the failure state rather than spinning forever.

**Spec** — docs/spec-plugin-sdk.md §11 (interactive jobs, SSE); DESIGN.md — Micro-interactions

#### `sdk-19` · hitl · M — Event triggers — enrich-on-create, and where the emitter lives

**Blocked by:** `sdk-12b`, `sdk-15`

**What to build**

The third trigger, and the whole workflow engine this product will ever have: a manifest job declaring on: ['entity.created'] runs when core emits that event. No domain-event emitter exists today, and the choice of shape is exactly what makes this human work: an in-process emitter in the web write path misses entities born in the worker (an importer plugin's own Identity.resolve) and in seeds; a domain_event outbox is durable and orderable but is new schema; pg NOTIFY is neither durable nor transactional. The leading candidate is emitting inside resolveEntity — the choke point both processes already share, which is the repo's own doctrine for exactly this problem — but it makes every seeded and imported entity a trigger, which may be wrong. Decide, then build only the narrow emission the trigger needs, not a general bus, with a per-integration config toggle because bulk auto-enrichment is never a default.

**Acceptance criteria**

- [ ] The emitter's shape is decided and recorded in CONTEXT.md under Plugin architecture, naming what it does for entities born in the worker, in seeds and in imports
- [ ] Creating a company with a domain emits entity.created once and enqueues plugin.apollo.enrich within a second; creating one without a domain emits the event and Apollo's job declines it as unenrichable rather than burning a credit
- [ ] Setting autoEnrich off in the integration config stops the enqueue while the event still fires, so other subscribers are unaffected
- [ ] An event with no subscribers enqueues nothing and costs one map lookup, asserted by the absence of any job_run row
- [ ] Merging two entities does not emit entity.created for the survivor — a test pins this, since the merge executor rewrites rows
- [ ] A subscriber whose plugin is degraded or disabled is skipped without raising an error into the write path that emitted the event
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Create a company with a domain in the dev app and watch the record fill itself within a second or two; toggle autoEnrich off in the integration config and create another — nothing enqueues. Seed a company and observe whatever the recorded decision says should happen.

**Spec** — docs/spec-plugin-sdk.md §11 (event trigger); CONTEXT.md — Enrichment (never auto-enrich in bulk)

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

## 23. The researcher lane, syncers, recorders and feeds

_Extensibility · 8 slices_

The last unimplemented port goes live and every kind interface the SDK froze finally gets a tenant: a researcher, a syncer, an ingress, a poller. Placed last because each needs OAuth, the loader and the fakes — but every one of them is a channel CONTEXT names, and none of them may be dropped silently.

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

### ▸ The first syncer

_Connect Google Calendar and let the schedule fire: this week's external meetings appear on the right companies' timelines with matched attendees, last week's do not, the internal standup never appears, and an expired sync token recovers without re-importing five years of history._

#### `arrival-5` · afk · M — plugins/google-calendar — the first syncer, forward-only from the connect date

**Blocked by:** `arrival-2`, `sdk-12b`, `sdk-25`, `sdk-4a`, `sdk-7b`, `storage-2b`, `storage-3a`

**What to build**

sdk-4a ships the `syncer` interface (`pull(cursor) → {claims, nextCursor}`) with no tenant, and the entire OAuth substrate storage-1…3b builds exists to serve exactly this; spec-plugin-sdk §14 step 5 names it. The plugin lists `calendarId: 'primary'` with `singleEvents: true` and `showDeleted: true`, resumes from the stored `nextSyncToken`, and emits content claims through sdk-7b's interaction lane.

Three corrections to the surveyed implementation, each a gap the survey records. Twenty passes no `timeMin` and imports full history — forward-only is our decision, so the first pull starts at the connection's `created_at` and nothing older is ever fetched. Twenty dedupes per channel and never matches `iCalUid`, so one real meeting in two partners' calendars becomes two rows — here the interaction's `message_id` is the iCalUid, and the existing `interaction_message_id_unique` index enforces it for free. Twenty swallows HTTP 410 (expired sync token) into a silent full re-sync — here it maps to a typed cursor-invalid outcome that clears the cursor and restarts bounded by the same `timeMin`.

Attendees run through arrival-2's participant module so a calendar attendee and an email participant cannot drift apart, and `src/lib/arrival/noise.ts` gains the calendar rules beside the mail ones: an event where every attendee is a workspace member is internal traffic, and a cancelled or declined event is not a meeting that happened. The fake lives with the others behind `SPACES_FAKE_PROVIDERS=1`, which is why this waits on sdk-25 instead of inventing a second harness; the chaos cases that apply are 429 with Retry-After, token revoked mid-sync, and cursor expired.

**Acceptance criteria**

- [ ] plugins/google-calendar builds to bundle.mjs + manifest.json, imports @spaces/sdk only, and declares kind `syncer` with a schedule and `requires.connection: {provider:'google', scopes:['calendar.readonly']}`
- [ ] The first pull for a fresh connection requests `timeMin` = the connection's created_at and no earlier; a fixture calendar holding five-year-old events yields none of them, asserted by row count
- [ ] The same event on two connected calendars produces one interaction — `message_id` is the iCalUid and the second write conflicts rather than duplicating
- [ ] An expired sync token (410 from the fake) produces a typed cursor-invalid outcome: the cursor is cleared, the next run performs a bounded re-sync, and `job_run` records both — never a silent full-history import
- [ ] A cancelled event marks its interaction cancelled rather than deleting it, and re-running the pull does not resurrect it
- [ ] Attendees resolve through `src/lib/arrival/participants.ts` with no calendar-specific copy of the policy — a test changes the policy fixture and sees both the mail and calendar lanes change
- [ ] An all-internal meeting creates no interaction; the rule lives in `src/lib/arrival/noise.ts` with the mail rules and is unit-tested with no database
- [ ] A runtime assertion shows the ports a `syncer` may not touch are absent from its Layer (Facts in particular), per the kind-to-ports table
- [ ] The suite runs against the in-repo fake with no network and no Google project; `SPACES_FAKE_PROVIDERS=1` is the only switch
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Connect Google Calendar from Settings → Connections against the fake IdP and let the schedule fire: this week's external meetings appear on the right companies' timelines with their attendees, last week's do not, and the internal standup never appears at all. Expire the sync token at the fake and the next run recovers without re-importing five years of history.

**Spec** — docs/spec-plugin-sdk.md §5 (syncer kind) and §14 build order step 5; docs/survey-twenty-calendar-sync.md §1 (per-channel dedup, iCalUid never matched) and §3 (no timeMin; HTTP 410 swallowed); CONTEXT.md — Email / calendar ingestion (forward-only; sync starts at connection date); docs/ARCHITECTURE.md §12 (integrations: Calendar → Gmail forward-only → Apollo/Exa); src/db/schema/interactions.ts (interaction_message_id_unique)

### ▸ The first ingress

_A signed Fathom payload lands a call with its attendees, files the transcript on everyone in the room and links it back to the call; replay it and nothing doubles. The recorder's summary arrives as a suggestion you accept into a real editable note with the transcript cited — sdk-23's ingress stops having a fixture for a customer._

#### `arrival-6` · afk · M — plugins/recorder — a webhook lands the transcript on the call

**Blocked by:** `arrival-2`, `notes-5`, `sdk-23`, `sdk-8`

**What to build**

The first real tenant of sdk-23's ingress, which ships with a fixture payload and no customer. Fathom, tl;dv and Granola all POST a completed-meeting payload carrying participants, a transcript (body or URL) and a summary. The plugin's `verify` defers to the manifest-declared HMAC sdk-23 already checks generically in web, and `handle(payload)` returns claims: one interaction (`kind: 'call'`, `message_id` = the provider event id, so a webhook delivered twice is one call — the chaos case sdk-25 already lists), participants through arrival-2's module, and the transcript as a document filed on the matched records through sdk-8's `Content.fileDocument`.

One reconciliation the spec forces. spec-storage-sources §3.1 and the integration map both describe the transcript as `derived_from → interaction`, and `link_relation` does carry `derived_from` — but `link` is entity-to-entity (src/db/schema/entities.ts) and an interaction is not an entity: it is its own table with its own id, deliberately outside the entity graph, which is why `interaction_entity` exists at all. So the edge is a column, exactly as notes-5 solved the same problem for the body: `interaction.document_id`, nullable, FK to `document.entity_id`, unique so two interactions cannot claim one transcript, with an ENTITY_REFS entry declaring both the merge strategy and the context role or entity-refs.test.ts fails naming the column. The summary is deliberately not written here — arrival-7 turns it into a suggestion.

**Acceptance criteria**

- [ ] Migration `pnpm db:generate --name interaction_document`, SQL hand-inspected: `interaction.document_id` nullable FK to `document.entity_id` plus a unique index; ENTITY_REFS gains `interaction.document` with an explicit merge strategy and an explicit `context` decision, and deleting the entry fails entity-refs.test.ts naming the column
- [ ] plugins/recorder builds to bundle.mjs + manifest.json, declares kind `ingress` with hmac-sha256, and imports @spaces/sdk only
- [ ] The same webhook delivered twice produces one interaction and one document — dedupe is the existing `interaction_message_id_unique` index on the provider event id, not an application pre-check
- [ ] The transcript is filed through `Content.fileDocument`, appears on every matched participant's Files tab, and storage-6a's single-writer grep test still passes
- [ ] Participants resolve through `src/lib/arrival/participants.ts`: a recorder payload for an unknown company creates exactly what a forwarded thread would
- [ ] A payload naming zero resolvable participants still lands the interaction and files the transcript unfiled rather than dropping the call
- [ ] The timeline row links to the transcript in the same treatment notes-5 introduced for its note link, so no new visual vocabulary appears and this stays mergeable unattended
- [ ] Fixture payloads for all three vendors live in plugins/recorder/fixtures and are snapshot-tested through the SDK testing kit with no database and no network
- [ ] CONTEXT.md and docs/spec-storage-sources.md §3.1 are corrected in the same PR: the transcript edge is a column on interaction, not a `derived_from` link, because an interaction is not an entity
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — curl a signed Fathom fixture at the plugin's webhook URL: a call appears on the company's timeline with its attendees, the transcript is on their Files tab and searchable in Cmd-K, and the transcript row links back to the call. Replay the identical payload: nothing doubles.

**Spec** — CONTEXT.md — The integration map #3 (transcript as document on participant-matched people; summary as suggestion); docs/spec-plugin-sdk.md §5 (ingress kind) and §11 (Ingress); docs/spec-storage-sources.md §3.1 (derived layers / derived_from); src/db/schema/entities.ts (link is entity↔entity; link_relation carries derived_from); src/db/schema/interactions.ts (interaction is not an entity)

#### `arrival-7` · afk · S — The recorder's summary is a suggestion — accept it and the call has a write-up

**Blocked by:** `ai-15`, `arrival-6`, `notes-6`, `sdk-10`

**What to build**

The integration map's third item ends "summary as a suggestion that becomes the note body", and every piece of that already has an owner: ai-5 is the suggestion table with propose/accept, ai-15 owns the only server-side path that writes a note body (the markdown→BlockNote renderer it builds because `createNote` makes an empty Untitled note and `bodyMd` is produced client-side), ai-8a renders the queue, and notes-5/notes-6 own `interaction.note_id` and the lazy write-up. So this slice is wiring and nothing else: the recorder's summary becomes `suggestion(kind: 'note')` carrying the transcript in its refs, and `accept` reuses ai-15's writer, then sets `interaction.note_id` through notes-6's program so the accepted note is the call's write-up rather than a loose note in /notes.

The one case ai-15 does not have is a note suggestion whose subject is an interaction rather than a record or a document. Accept files the note `tagged_in` against the same participant set the interaction carries, links it `derived_from` the transcript document, and takes notes-6's conflict path when someone already wrote the call up by hand — the unique index on note_id is what makes that safe, and the suggestion closes as superseded rather than forking a second body.

**Acceptance criteria**

- [ ] The summary lands as `suggestion(kind: 'note')` with the transcript document in `refs` and a rationale naming the recorder; no note, entity or link exists before acceptance
- [ ] Accepting writes the note through ai-15's renderer — `bodyJson` opens populated in the editor and `bodyMd` round-trips — with the accepter as author, `derived_from` to the transcript and `tagged_in` to exactly the interaction's participants
- [ ] Accepting sets `interaction.note_id` through notes-6's program, so the timeline row stops offering "write up" and starts offering "open note"
- [ ] An interaction that already carries a note_id makes the suggestion close without writing: the hand-written body wins, the outcome is legible in the review inbox, and exactly one note row exists afterwards
- [ ] Rejecting writes nothing — no note, no entity, no link, no activity
- [ ] No AI provider is required: the summary arrives from the recorder payload and this lane never calls `complete()`, asserted by a test with no provider configured
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — After a recorded call lands, the review inbox offers the recorder's summary; accept it and the call's timeline row opens a real editable note with the transcript cited, filed on everyone who was in the room.

**Spec** — CONTEXT.md — The integration map #3; docs/spec-plugin-sdk.md §4 (Judgment lane: machine writes are suggestions); CONTEXT.md — The note model (interaction.note_id, lazily filled); CONTEXT.md — AI writes are suggestions, never silent

### ▸ Feeds, and a mailbox that syncs itself

_A feed URL attached to a space or a record, polled on a cadence you can mute, items matched deterministically into signals with the unmatched kept visible because that is where the next company comes from. Then Gmail forward-only from the connect date, deduped against threads the forwarding lane already saw, with the privacy default decided, recorded and enforced at read time._

#### `arrival-8` · hitl · M — feed and feed_item — one URL, three scopes, a cadence you can mute

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

#### `arrival-9` · afk · M — Feed items match the graph — a signal on the record, the unmatched still visible

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

#### `arrival-10` · hitl · L — plugins/gmail — forward-only sync, and the privacy default finally decided

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

---
