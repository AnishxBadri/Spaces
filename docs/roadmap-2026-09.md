# Roadmap — reconciled

_2026-09-15. Supersedes the first-pass structure in this file's history. Two decomposition passes: eight areas sliced in parallel (153 slices), then a reconciliation that resolved seven collision clusters, split seven oversized slices, corrected labels and verticality, and added seven areas the first pass never covered. Full bodies: `research/roadmap-slices-2026-09.json` (first pass) and `research/roadmap-reconciled-2026-09-15.json` (this one). Both git-ignored; they become Linear issue bodies at publish time._

**230 slices · 23 projects · 2 initiatives · 80 added · 3 deleted · 227 with written bodies, 3 still key-and-title only**

**Status: projects 1–13 are published to Linear as SPA-16…SPA-150** (134 issues, 169 blocking relations, 44
milestones, published 2026-09-16). The bodies for those live in Linear, which is their store of record; this file
carries their structure. **Projects 14–23 are not published**, and their 98 slice bodies live in
`docs/roadmap-backlog.md` — publish a project when you reach it, not before. All 48 open decisions are closed:
`docs/decisions-2026-09.md`.

_Historical note from before publication:_ The 35 unresolved placeholder blockers from the first pass (`clean-integration-table`, `mono-test-db-harness`, `ai-suggestion-inbox` and friends) have been mapped to real keys, so every blocker in projects 1–13 exists before the slice that names it. Exactly one slice blocks the rest: `import-10` (P14) is blocked by `sdk-5` (P17) and `sdk-12a` (P18); defer it and projects 14–16 unlock too. The second audit's warning was against publishing projects 2, 5 and 6 _out of order_, not against publishing more than one. See §4 for the eleven collisions this pass introduced at the new seams, which a serial reader should close before the projects that contain them.

---

## 1. Projects

### 1. Ship polish first — the name, the box, and the vocabulary

_Spaces v1 · 7 slices_

The rename to Spaces, an entrypoint that owns /data, a downgrade guard, a copy-paste TLS overlay, a restore that works, and gate 5 turned from a lying grep into a lint rule. Nothing here needs the monorepo and everything here is cheaper now than after: CONTEXT.md requires the rename before images bake the old name in, and mono-1 is blockedBy ship-1 so the great git mv never renames the same file twice.

**▸ It is called Spaces, and the box boots correctly** — A Linux operator with a mis-owned ./data stops getting a green healthcheck followed by a failure at their first upload — the entrypoint repairs ownership as root, drops to UID 1000, and refuses to boot with the fix printed if it still cannot write. An older image refuses a database from the future instead of running old code against a new schema. And the product's name is its own everywhere a human reads it. Demoable on a laptop with docker alone.

| slice    |      |     | title                                                                                       | blocked by |
| -------- | ---- | --- | ------------------------------------------------------------------------------------------- | ---------- |
| `ship-1` | hitl | S   | Rename to Spaces — every place a human reads the name, and the three that must not move     | —          |
| `ship-2` | afk  | M   | Entrypoint owns /data — root repairs, su-exec drops, boot fails instead of the first upload | —          |
| `ship-4` | afk  | S   | Downgrade guard — an image refuses a database from the future                               | —          |

**▸ HTTPS, and a restore from total loss** — Point a domain at a box and one overlay gets a real certificate, a Secure cookie and an https blob presign, with port 3000 no longer reachable from outside at all — which also closes the first-run /setup window. Then: upload a deck, save an API key, docker compose down -v && rm -rf ./data, and restore both from a backup directory.

| slice    |     |     | title                                                                       | blocked by         |
| -------- | --- | --- | --------------------------------------------------------------------------- | ------------------ |
| `ship-3` | afk | M   | TLS overlay — a worked Caddyfile, and the only port that stays open         | `ship-1`           |
| `ship-5` | afk | M   | Restore is a script — the both-or-neither round trip, proven on a clean box | `ship-1`, `ship-4` |

**▸ The vocabulary is enforceable, and written down** — Gate 5 stops passing vacuously and stops failing on a comment: the banned v1 names become lint rules that name their Instrument replacement, and the missing 10px type step lands so 45 hand-written text-[…] sizes collapse into it with nothing moving on screen. This must precede mono-6, which is about to wire today's grep into CI.

| slice      |     |     | title                                                                | blocked by |
| ---------- | --- | --- | -------------------------------------------------------------------- | ---------- |
| `design-1` | afk | M   | V1 vocabulary out — dead tokens deleted, gate 5 becomes lint         | —          |
| `design-3` | afk | S   | The field-label step — one named size, forty arbitrary ones collapse | `design-1` |

### 2. Worker spine, the workspace, and a test database of its own

_Spaces v1 · 12 slices_

runJob and the role-keyed heartbeat land against the flat tree, then pnpm 10 alone, then the move into apps/web, then the turbo graph, @spaces/db, a test database the suite owns, and CI enforcing all five gates. The first ten, one agent at a time, is now sdk-1 · sdk-2 · mono-1a · mono-1 · mono-1b · mono-2 · mono-3 · mono-4 · mono-5 · mono-6.

**▸ A worker that cannot die silently** — Every background job goes through one wrapper whose own promise never rejects and which resolves each job in a pg-boss batch explicitly, with a stated retryable-versus-terminal mapping so a transient blob read retries and an unsupported mime does not. curl /api/health says whether the worker is alive with an age, keyed by role so three restarts leave one row, and a dead worker never fails a healthy web container's HEALTHCHECK.

| slice   |     |     | title                                                                         | blocked by |
| ------- | --- | --- | ----------------------------------------------------------------------------- | ---------- |
| `sdk-1` | afk | M   | runJob wrapper — one wrapper, typed outcomes, extractDocument as first tenant | —          |
| `sdk-2` | afk | M   | Worker heartbeat — a ROLE=worker container you can health-check               | —          |

**▸ pnpm 10, apps/web, and the turbo graph** — Three failure modes, three PRs: a whole-lockfile regeneration whose failure is a missing native binary; a whole-tree rename whose failure is silence (a dotenv that no longer resolves, an eslint rule that stops matching, a data directory that moves, a grep that passes against a path that is gone); and a cached task graph whose failure is a gate serving a green result for inputs that changed. From a clean clone, pnpm install && pnpm dev is identical and the PR diff is renames plus config.

| slice     |      |     | title                                                               | blocked by |
| --------- | ---- | --- | ------------------------------------------------------------------- | ---------- |
| `mono-1a` | afk  | S   | pnpm 10 — the lockfile bump alone, before the tree moves            | —          |
| `mono-1`  | hitl | M   | Workspace scaffold — everything into apps/web, nothing else moves   | `mono-1a`  |
| `mono-1b` | afk  | S   | Turbo task graph — the five gates cached, and what invalidates what | `mono-1`   |

**▸ @spaces/db and tests that stop touching the dev database** — Schema, migrations and ENTITY_REFS become a package whose entity-refs test is green with Postgres stopped, verified as a dump-diff that comes back empty. Then dealos_test is created, migrated and seeded by a global setup and truncated between files — with /companies open, a full test run leaves the grid untouched — and CI runs all five gates against a real Postgres. This is the standing debt that makes 150 unattended agent runs safe.

| slice    |     |     | title                                                                                     | blocked by |
| -------- | --- | --- | ----------------------------------------------------------------------------------------- | ---------- |
| `mono-2` | afk | S   | @spaces/db specifier sweep — one mechanical rewrite, behind a temporary alias             | `mono-1`   |
| `mono-3` | afk | M   | packages/db extraction — schema, migrations, ENTITY_REFS, journal verified against a dump | `mono-2`   |
| `mono-4` | afk | M   | Test database — its own, migrated and seeded by a global setup                            | `mono-3`   |
| `mono-5` | afk | M   | Test isolation — truncate between files, delete the name-regex cleanup                    | `mono-4`   |
| `mono-6` | afk | S   | CI on turbo — five gates, the test database, no dev-DB writes                             | `mono-5`   |

**▸ Pure core and the queue seam** — Portfolio metrics, glossary auto-link, the due-date parser and the view filter model run green with Postgres stopped, and web stops importing the worker — one QUEUES definition, and an upload with the worker down opens and downloads instead of 500ing.

| slice     |     |     | title                                                                        | blocked by |
| --------- | --- | --- | ---------------------------------------------------------------------------- | ---------- |
| `mono-7`  | afk | M   | packages/core, pure half — no db, no React, no process.env                   | `mono-3`   |
| `mono-9c` | afk | S   | Queue seam into core — one QUEUES definition, web stops importing the worker | `mono-7`   |

### 3. Provenance without vendors, deletes that don't lie

_Spaces v1 · 9 slices_

Delete the organization ghost, create integration and job_run, open credential.kind once for everyone who needs it, collapse every vendor-named enum into source_class + source_ref, make deletion walk ENTITY_REFS, and give a deal the person behind the channel. The widest blast radius in the plan: seven sdk slices, three storage slices, two ai slices and now the arrival mailbox all key on these tables.

**▸ No vendor names in the schema** — Eight entity kinds, no ghost, every kind routing from the mention picker and the task rail. credential.kind opens to oauth_client, webhook, embedding and mailbox with the unique key rebuilt, so a Gemini key and a Google OAuth app stop overwriting each other and four downstream areas can be specified honestly. The timeline names the integration that wrote a value and stops folding two integrations into one lying burst, the extraction job leaves a run record the Files tab can read, and a deal records who referred it.

| slice        |      |     | title                                                                   | blocked by          |
| ------------ | ---- | --- | ----------------------------------------------------------------------- | ------------------- |
| `clean-1`    | afk  | S   | Organization kind deleted — no ghost, no wrong route                    | —                   |
| `clean-2a`   | afk  | M   | integration table + actor_ref — the typed actor finally has a target    | —                   |
| `clean-2c`   |      |     | _body not yet written_                                                  |                     |
| `clean-2b`   | afk  | S   | job_run — one writer in runJob, and extraction stops being unobservable | `clean-2a`, `sdk-1` |
| `clean-3`    | hitl | M   | source_class + source_ref on entity and alias — one branch in resolve   | `clean-2a`          |
| `clean-4`    | afk  | S   | source_class on interaction and document — the last two vendor enums    | `clean-3`           |
| `backfill-2` | afk  | S   | referred_by — the who behind the channel, beside deal.source            | —                   |

**▸ Delete walks the registry** — Deleting anything stops depending on a hand-maintained table list. A note goes with its filings, mentions and space edges while documents derived from it survive; the mandate's note and anything a merge snapshot depends on refuse by name instead of throwing an FK violation.

| slice     |      |     | title                                                          | blocked by |
| --------- | ---- | --- | -------------------------------------------------------------- | ---------- |
| `clean-7` | hitl | M   | Entity deletion walks the registry — one list, three consumers | —          |
| `clean-8` | hitl | M   | Note deletion — the note goes, what it fed survives            | `clean-7`  |

### 4. The Instrument port — a new surface is born ported

_Spaces v1 · 9 slices_

The design contract, the three missing primitives, the nav and chord ledger, the settings shell, the native controls, the editor chrome, and dark deferred with the deferral paid. This project exists here and not later because the ten projects after it add roughly forty surfaces, and the audit's non-negotiable is that they are not built on chrome the port is mid-way through replacing.

**▸ A new surface is born ported** — docs/design-contract.md answers 'what should this look like' without a human — hand it the contract and the docsurf-5 issue body and it says '/portfolio pattern, hand-declared columns, no ViewBar' and asks nothing. Badge, Checkbox and Switch become primitives with one API instead of eight hand-assembled copies; a page joins a nav group and claims a chord as data with a test that names both pages on a collision; dark is deferred by decision with the dead machinery removed, so every surface after this is token-only.

| slice      |      |     | title                                                                    | blocked by |
| ---------- | ---- | --- | ------------------------------------------------------------------------ | ---------- |
| `design-2` | hitl | S   | The surface contract — what a new surface must satisfy before it is born | `design-1` |
| `design-4` | hitl | M   | Badge, Checkbox and Switch — three primitives, one home                  | `design-2` |
| `design-6` | afk  | S   | Nav grammar and the chord ledger — a page joins a group, never an index  | `design-2` |
| `design-9` | hitl | S   | Dark, deferred and paid for — the dead machinery out, tokens in          | `design-1` |

**▸ Settings can take ten more sections** — The 881-line settings route becomes a shell with a section nav, a mono crumb and an exported SettingsSection, so the eleven pending settings slices (AI providers, routing, embeddings, usage, caps, integrations, connections, providers, binding health, plugin install) have one answer to 'where does this live' instead of the three they are drafted with. Every native select becomes a paper sheet. Deep-link into the FX ledger and the nav is already on it.

| slice      |      |     | title                                                                  | blocked by             |
| ---------- | ---- | --- | ---------------------------------------------------------------------- | ---------------------- |
| `design-5` | hitl | M   | Settings is a shell — one nav, one crumb, a section is a route         | `design-2`             |
| `design-7` | hitl | M   | Native controls stop being OS chrome — the selects and the date fields | `design-2`, `design-4` |

**▸ The last unported surface** — The note body and the editor's chrome stop being shadcn v1 — the mention chip is square ink-on-bone like every other reference, the slash menu and toolbars are paper sheets, and the v1 alias layer leaves styles.css entirely. The four micro-interactions the canvas sheet pins land in code, and all of them still work with Reduce Motion on.

| slice       |      |     | title                                                                        | blocked by  |
| ----------- | ---- | --- | ---------------------------------------------------------------------------- | ----------- |
| `design-8a` | afk  | S   | Marks in the prose — the mention chip, the glossary underline, the note body | `design-1`  |
| `design-8b` | hitl | M   | The editor chrome — BlockNote's shadcn theme replaced by the Instrument one  | `design-8a` |
| `design-10` | afk  | S   | The four micro-interactions — the canvas sheet's proposals, in code          | `design-4`  |

### 5. Custom objects, and one review inbox

_Spaces v1 · 9 slices_

Fuzzy dedupe, merge, a real nightly sweep and opt-in identity keys for user-created objects — and, because three slices here touch it before project 10 starts, the review inbox itself. /inbox is built once, by the area that gets there first, as a queue over typed rows whose only member on day one is duplicate_candidate.

**▸ Customs dedupe like everything else** — Merge lands first, then the sweep that produces pairs, then renames that keep old names findable. Merging repoints every space tag, mention, reference and task onto the survivor while the loser's URL redirects — which makes the 'no fourth system object' rule honest.

| slice        |     |     | title                                                                                | blocked by  |
| ------------ | --- | --- | ------------------------------------------------------------------------------------ | ----------- |
| `objects-2`  | afk | M   | Merge-as-target for customs — MERGEABLE joins, same-object guard                     | —           |
| `objects-1b` | afk | S   | A rename keeps the old name — name alias on every record rename                      | —           |
| `objects-1a` | afk | M   | Custom records join the fuzzy sweep — a name alias at birth, one object-scoped sweep | `objects-2` |

**▸ One queue, typed rows, and duplicates found while you sleep** — /dedupe becomes /inbox with a redirect, rows render through a kind-keyed renderer map with a payload fallback, the card reads 'Same Fund?' with both sides clickable into /o/funds, and Today stops loading the whole list to read a number. Then the 03:30 sweep CONTEXT.md promised actually runs, for every object, with a 'Scan for duplicates' action in the queue's own header — and a bounded first pass so an established workspace is not flooded.

| slice       |      |     | title                                                                       | blocked by                |
| ----------- | ---- | --- | --------------------------------------------------------------------------- | ------------------------- |
| `objects-3` | afk  | M   | Review inbox — /inbox, one queue over typed rows                            | `objects-1a`              |
| `objects-4` | hitl | M   | The nightly sweep is real — worker job, on-demand scan, a bounded first run | `objects-1a`, `objects-3` |

**▸ Opt-in identity keys** — Tick domain on Funds and the object gets a Domain attribute whose writes hit the same unique-index tripwire core records use: a second record claiming an owned domain becomes a toasted duplicate suggestion with the colliding value visible on both sides of the pair card, not a silent second row. Keys editable while empty, frozen once there are records, and clearing the attribute releases the claim instead of stranding it.

| slice       |      |     | title                                                                                   | blocked by               |
| ----------- | ---- | --- | --------------------------------------------------------------------------------------- | ------------------------ |
| `objects-5` | hitl | M   | Identity keys declared at creation — object.identity_keys and its backing attribute     | —                        |
| `objects-6` | afk  | S   | Keys are frozen after the first record — mutable while empty, read-only after           | `objects-5`              |
| `objects-7` | afk  | M   | Identity-backed writes — a declared key routes through addIdentityAlias                 | `objects-5`, `objects-3` |
| `objects-8` | afk  | S   | A claimed key is never silent — collision toast and the duplicate row's domain fallback | `objects-7`              |

### 6. The note model — filed, not just mentioned

_Spaces v1 · 8 slices_

Record filing via tagged_in, filed-vs-mentions lanes on every record page, kind as a toggle, templates that stamp a genre, and interaction bodies that are real notes. Self-contained, high daily value, and it has to precede ai-15 (which lands a note) and docsurf-9 (which edits the same editor).

**▸ Filed, not just mentioned** — A note started from a company, person, deal or custom record is genuinely filed against it and survives deletion of the starter mention. All four record pages separate 'Filed here' from 'Mentions this' through one component, four unfiltered mentionedIn queries that leaked private note titles are deleted, and any note can be filed against any record from its own header.

| slice      |      |     | title                                                                                     | blocked by |
| ---------- | ---- | --- | ----------------------------------------------------------------------------------------- | ---------- |
| `notes-1a` | hitl | M   | Record filing — "Note about this" writes tagged_in, and the company Notes section splits  | —          |
| `notes-1b` | afk  | S   | Same section everywhere — people, deals and custom records adopt the filed/mentions lanes | `notes-1a` |
| `notes-3`  | hitl | M   | Filed against — record chips beside the space chips in the note editor                    | `notes-1a` |

**▸ Kind is a choice** — Note · Memo · Scratch becomes a toggle instead of a decision frozen at creation. A memo pins to the top of a space's filed list, the space page stops calling every filed note a memo, and a template stamps the genre it was saved from.

| slice     |      |     | title                                                             | blocked by |
| --------- | ---- | --- | ----------------------------------------------------------------- | ---------- |
| `notes-2` | hitl | M   | Kind is a toggle — Note · Memo · Scratch in the editor header     | —          |
| `notes-4` | afk  | S   | Memo pins where it is filed — space ordering, and an honest count | `notes-1a` |
| `notes-7` | afk  | S   | Genres are templates — a note template stamps its kind            | `notes-2`  |

**▸ Meeting notes are notes** — interaction.note_id makes a meeting's body a real note row: one editor, mentions creating links, Cmd-K finding a meeting by a sentence in its write-up, and 'write it up later' for calls logged in twenty seconds.

| slice     |      |     | title                                                                      | blocked by |
| --------- | ---- | --- | -------------------------------------------------------------------------- | ---------- |
| `notes-5` | hitl | M   | Meeting notes are notes — interaction.note_id and a body worth writing     | `notes-1a` |
| `notes-6` | afk  | S   | Write it up later — lazy note creation for interactions logged without one | `notes-5`  |

### 7. Documents file into spaces

_Spaces v1 · 8 slices_

The filing target becomes a union, a space grows Sources and Contacts, documents can be re-filed and re-extracted, and the browser upload path is hoisted once. The union has to open before /documents, before global upload and before any storage binding — storage-8a binds a folder to a space, which presumes a document can be filed into a space at all.

**▸ A space is a place you file into** — Drop a PDF into a space's Sources and it is filed there through entity_space, extracted, searchable and routed back to the space from Cmd-K, with company documents underneath, collapsed and named. The Contacts half of the same answered question lands with it: people tagged into the space, and those reached through its companies, in the same collapsed pattern.

| slice         |      |     | title                                                                         | blocked by                |
| ------------- | ---- | --- | ----------------------------------------------------------------------------- | ------------------------- |
| `docsurf-1a`  | afk  | M   | Filing target is a union — documents file into spaces, not only onto records  | —                         |
| `docsurf-1b`  | hitl | M   | Space Sources section — a space becomes a place you file into                 | `docsurf-1a`              |
| `docsurf-4`   | afk  | S   | Inherited sources — company documents under the space, collapsed              | `docsurf-1b`              |
| `backfill-10` | afk  | M   | Space Contacts — tagged people and those reached through companies, collapsed | `docsurf-1b`, `docsurf-4` |

**▸ A misdrop is fixable** — kind loses memo (six values; an exported memo is derived_from), a document's edges can be added and removed from its filing control with re-kind and re-extract, and the browser hasher is hoisted into one client module so the three later entry points inherit one hasher, one size guard and one secure-context check. grep for crypto.subtle returns one line.

| slice        |      |     | title                                                          | blocked by                 |
| ------------ | ---- | --- | -------------------------------------------------------------- | -------------------------- |
| `docsurf-2`  | afk  | S   | Kind loses memo — six values, an exported memo is derived_from | —                          |
| `docsurf-3`  | hitl | M   | Re-file a document — the edges it can gain and lose            | `docsurf-1a`               |
| `docsurf-6a` | afk  | S   | Browser upload lane — one hasher, hoisted out of the Files tab | `docsurf-1a`, `docsurf-1b` |

**▸ Documents are mentionable** — @ a deck by filename in a note: the chip inserts with a paperclip, the markdown export carries the entity link, and clicking it pops the PDF preview over the note.

| slice       |     |     | title                                                  | blocked by |
| ----------- | --- | --- | ------------------------------------------------------ | ---------- |
| `docsurf-8` | afk | S   | Documents are mentionable — the chip opens the preview | —          |

### 8. The documents shelf, one row birth, two byte lanes

_Spaces v1 · 11 slices_

/documents on the record-table engine with its provenance migration and its own door in the chassis, then the arrival cluster rebuilt so nothing claims to be the only writer of bytes: one browser lane, one server intake, one document birth, three greps, three files. Then global upload, the unfiled inbox, the orphan-blob sweep, the URL clip and drop-into-note.

**▸ The whole shelf** — Every file the fund holds on one surface — filename, kind, filed against, space, origin, extraction, date, size — with show/hide/resize, sort, preview and chips that route through recordPath; then a nav row with a chord that is data, printed in the sheet and the palette with no per-surface code. The §11 provenance columns land as a declared foundation migration whose first writer is the server intake two milestones on.

| slice        |      |     | title                                                                                       | blocked by   |
| ------------ | ---- | --- | ------------------------------------------------------------------------------------------- | ------------ |
| `docsurf-5`  | hitl | M   | /documents — every document with its filing, on the record-table engine                     | `docsurf-1a` |
| `docsurf-5b` | hitl | S   | Documents in the chassis — a nav row, its chord lane and the sheet                          | `docsurf-5`  |
| `docsurf-11` | afk  | S   | Provenance columns — source_path, external_id, external_url, external_status, connection_id | `docsurf-5`  |

**▸ One row birth, two byte lanes, nothing lost** — Document birth becomes one Effect program — dedupe, entity + document + edges + activity in one transaction, enqueue outside it — widened once for every caller already queued (N targets, nullable sha, nullable actor, provenance as one bag), and server intake streams bytes to a temp file while hashing so a 200 MB arrival never buffers. Then bytes stop needing a record: global upload with a record/space/unfiled picker, unfiled counted on Today, and a scheduled sweep that reclaims bytes whose finalize never arrived.

| slice         |      |     | title                                                               | blocked by                            |
| ------------- | ---- | --- | ------------------------------------------------------------------- | ------------------------------------- |
| `storage-6a1` | afk  | M   | Document birth — one transaction, the only writer of a document row | `docsurf-1a`, `docsurf-11`, `clean-4` |
| `storage-6a2` | afk  | M   | Server intake — bytes from a stream, hashed as they land            | `storage-6a1`                         |
| `docsurf-6b`  | hitl | M   | Global upload — one dialog, a file-against picker, unfiled is legal | `docsurf-5`, `docsurf-6a`             |
| `docsurf-7`   | afk  | S   | Unfiled inbox — no edge, a filter on the shelf, a cell on Today     | `docsurf-5`, `docsurf-6b`             |
| `backfill-3`  | afk  | M   | Orphan blob sweep — bytes with no row, reclaimed on a schedule      | `sdk-1`                               |

**▸ A link is a document** — A pasted URL becomes a document whose article text joins the same search index as the decks — blobless, through birth, never through the byte lane — with the SSRF guard table in one module and unit-tested without the network; a URL that serves a PDF goes down the ordinary blob path, and blobless rows stop throwing on preview and download.

| slice         |      |     | title                                                                         | blocked by                  |
| ------------- | ---- | --- | ----------------------------------------------------------------------------- | --------------------------- |
| `docsurf-10a` | hitl | M   | URL clip — a blobless document, and the fetch is guarded                      | `storage-6a1`, `docsurf-6b` |
| `docsurf-10b` | afk  | S   | A clipped PDF is an upload — blobless rows stop breaking preview and download | `docsurf-10a`               |

**▸ Files in the writing** — Drag a file into a note body and it files where the note is filed, with the mention left at the cursor — the reason document birth takes an array of targets rather than one.

| slice       |      |     | title                                                                            | blocked by                                                          |
| ----------- | ---- | --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docsurf-9` | hitl | M   | Drop a file into a note — filed where the note is, mentioned where the cursor is | `docsurf-1a`, `docsurf-6a`, `docsurf-7`, `docsurf-8`, `storage-6a1` |

### 9. Views leave the browser — server-side filters and pagination

_Spaces v1 · 7 slices_

The area nobody owned. One surface discriminator so a view can address /documents, one Condition-to-SQL compiler proven equal to the client matcher by property test, keyset pagination with an honest count, and filterable/sortable flags that mint expression indexes on demand — closing CONTEXT's values-jsonb open question with shipped code rather than a comment.

**▸ Views leave the browser** — A view can address a surface that has no object row, and object-list conditions run in SQL with one property test walking every operator in OP_LABELS to prove both evaluators agree. Filter a custom object and the network response carries the matching rows instead of all of them, while every existing saved view still applies on first paint — and /documents saves its columns as a real view instead of per-browser localStorage.

| slice         |      |     | title                                                                             | blocked by  |
| ------------- | ---- | --- | --------------------------------------------------------------------------------- | ----------- |
| `views-1`     | hitl | M   | View surfaces — one discriminator, decided before three areas inherit it          | —           |
| `views-2`     | afk  | M   | Conditions compile to SQL — one evaluator, proven equal to the client's           | —           |
| `docsurf-12a` | hitl | M   | A view can address a surface that is not an object — /documents saves its columns | `docsurf-5` |

**▸ Twenty thousand rows** — The custom-object table pages on a keyset cursor with a server-computed count — first page instant, the foot reading '50 of 20,000', the count dropping to the true number when the filter narrows — and ticking 'filter and sort on this' mints that attribute's expression index live, turning a seq scan into an index scan while you watch. Untick it and the index is gone.

| slice     |      |     | title                                                                             | blocked by |
| --------- | ---- | --- | --------------------------------------------------------------------------------- | ---------- |
| `views-3` | hitl | M   | The record table pages — a keyset cursor and an honest count                      | `views-2`  |
| `views-4` | hitl | M   | Filterable is an attribute flag — expression indexes minted and dropped on demand | `views-3`  |

**▸ Every record table pages, and the shelf filters** — Companies and people run on the same loader, which is the day-to-day surface actually getting faster; the deals board is a documented exception with its stage-chip semantics on record rather than an oversight. The shelf gains document-field conditions compiled through the one evaluator, so 'scanned decks' and 'unfiled since Monday' are saved, shareable views.

| slice         |      |     | title                                                                          | blocked by                 |
| ------------- | ---- | --- | ------------------------------------------------------------------------------ | -------------------------- |
| `views-5`     | afk  | M   | Companies and people page too — and the board says why it cannot               | `views-3`                  |
| `docsurf-12b` | hitl | M   | Document fields as filter conditions — a registry the shelf can be filtered by | `docsurf-12a`, `docsurf-7` |

### 10. AI substrate — it reads a deck

_Spaces v1 · 15 slices_

Context readout, the registry-to-JSON-schema compiler, the provider vault and lane routing, the sensitivity flag, a per-day ceiling, the suggestion table, the second row kind in the inbox, chips on the record rail, citation stability, and the deck reader. The inbox shell already exists from project 5, so this area contributes a row kind and never a page.

**▸ Context with no model at all** — Expand Context on a record and read the ranked list with citations, with a second user correctly not seeing the private note; and the registry compiles to JSON schema — the deck reader's output type, legible with DATABASE_URL unset.

| slice  |      |     | title                                                      | blocked by |
| ------ | ---- | --- | ---------------------------------------------------------- | ---------- |
| `ai-1` | hitl | M   | Context readout — the assembler gets its first consumer    | —          |
| `ai-2` | afk  | M   | Registry to JSON schema — the output type system, compiled | —          |

**▸ Keys, lanes, sensitivity and a ceiling** — Paste an Anthropic key or point at Ollama — or at your own Helicone/LiteLLM gateway through baseURL and headers — press Test, read the answer. Features name a lane, never a model; the lane × sensitivity grid is a settings ledger rather than a new matrix pattern; a space marked sensitive makes the triggers refuse by name; and a per-day ceiling the worker asks before it spends lands once, as the helper the backfill and the column run both inherit.

| slice        |      |     | title                                                                          | blocked by |
| ------------ | ---- | --- | ------------------------------------------------------------------------------ | ---------- |
| `ai-3a`      | hitl | M   | Provider vault — one provider, a settings home, a test call                    | —          |
| `ai-3b`      | afk  | S   | The other four adapters — openai, google, ollama, openrouter                   | `ai-3a`    |
| `ai-4a`      | afk  | M   | Lanes and complete() — features name a lane, never a model                     | `ai-3a`    |
| `ai-4b`      | hitl | S   | Routing grid — lane × sensitivity as a settings surface                        | `ai-4a`    |
| `ai-26`      | hitl | M   | Sensitivity resolves — one function over entity, binding and workspace default | `ai-4a`    |
| `backfill-4` | afk  | M   | AI caps — a per-day ceiling every lane asks before it spends                   | `ai-4a`    |

**▸ Propose, never write** — The suggestion table plus the second member of the inbox's row union: suggestion cards beside duplicate pair cards, one card per record, each row individually accept/rejectable with its rationale and citations, and filter tabs copying the shipped HeaderTab treatment. Chips on the record rail show what is waiting where the deck reader's output is actually noticed, and citations survive a merge and a re-chunk — pinned by test, not by convention.

| slice        |      |     | title                                                          | blocked by                  |
| ------------ | ---- | --- | -------------------------------------------------------------- | --------------------------- |
| `ai-5`       | afk  | M   | The suggestion table — propose, never write                    | `ai-2`                      |
| `ai-8a`      | hitl | M   | Suggestions join the queue — the second row kind and its card  | `ai-1`, `ai-5`, `objects-3` |
| `backfill-5` | hitl | M   | Suggestion chips — the record rail shows what is waiting       | `ai-5`, `ai-8a`             |
| `backfill-7` | afk  | S   | Refs survive merge and re-chunk — one resolver, pinned by test | `ai-1`, `ai-5`, `ai-8a`     |

**▸ It reads a deck** — Press Read deck on a real pitch deck and accept proposed funding stage, business model, location, description and founders from /inbox, each citing the page it came from, each landing with the accepter as actor. Founders route through the same resolveEntity door every creator walks. Bulk accept per record and per column, with per-row failure surfacing the validator's message — and never touching a duplicate row, because a merge has no unmerge.

| slice   |      |     | title                                                                 | blocked by                       |
| ------- | ---- | --- | --------------------------------------------------------------------- | -------------------------------- |
| `ai-6`  | hitl | M   | Deck reader — one extract call on a document already extracted        | `ai-2`, `ai-4b`, `ai-5`, `ai-26` |
| `ai-7`  | afk  | S   | Founders from a deck — identity claims route through the dedupe inbox | `ai-6`, `ai-8a`                  |
| `ai-8b` | afk  | S   | Bulk accept — per record and per column, with per-row failure         | `ai-8a`                          |

### 11. Everything Cmd-K can find

_Spaces v1 · 13 slices_

Tasks and terms as search lanes, then the chunk table generalized while it is still empty, embeddings at a pinned dimension with a local slot, and semantic search fused into the same query. Strictly serial, one agent: five slices from three areas restructure the same 234-line CTE union and two concurrent agents here guarantee a rewrite.

**▸ Tasks and terms** — A phrase from a task returns it fused with companies, notes and deck text, and Enter lands on /tasks with that row focused and scrolled to — completed tasks included, with the result-row treatment settled rather than guessed. The glossary stops being a tooltip and becomes a real graph node with a page. Neither needs a provider configured.

| slice     |      |     | title                                                       | blocked by                |
| --------- | ---- | --- | ----------------------------------------------------------- | ------------------------- |
| `clean-5` | afk  | M   | Task search lane — the fused query learns a second id space | `clean-5a`, `docsurf-1a2` |
| `clean-6` | afk  | S   | Focused task row — the hit lands on the task, not the page  | `clean-5`                 |
| `ai-19`   | afk  | M   | Concept links — the glossary stops being a tooltip          | —                         |
| `ai-20`   | hitl | M   | Term page — concept as the third way into the graph         | `ai-19`, `clean-5a`       |

**▸ Chunks, pages and vectors** — The chunk table is generalized while it is still empty, so the note/close_reason migration never moves real vectors and the HNSW index is recreated once by hand. The dimension pins at 768 and refuses a change, embed() takes a sensitivity argument from the first day even though one branch is unreachable, PDFs learn their page numbers, and document.embed stops being a stub.

| slice    |      |     | title                                                        | blocked by                  |
| -------- | ---- | --- | ------------------------------------------------------------ | --------------------------- |
| `ai-12a` | afk  | M   | The chunk table — generalize before it holds a single vector | `ai-26`                     |
| `ai-9a`  | hitl | M   | The dimension pin — 768, and a cloud embedding provider      | `ai-3a`                     |
| `ai-10a` | afk  | S   | PDFs learn their page numbers                                | —                           |
| `ai-10b` | afk  | M   | Chunk per format — and document.embed stops being a stub     | `ai-9a`, `ai-10a`, `ai-12a` |

**▸ Search by meaning** — The fourth RRF CTE joins the fusion: 'cheaper cooling for racks' finds the immersion-cooling deck that uses none of those words. Notes and close reasons embed too, and the backfill runs with an estimate against the ceiling so a five-year-old deck becomes findable by meaning.

| slice    |      |     | title                                                        | blocked by          |
| -------- | ---- | --- | ------------------------------------------------------------ | ------------------- |
| `ai-11`  | hitl | M   | The fourth RRF CTE — semantic search joins the fusion        | `clean-5`, `ai-10b` |
| `ai-12b` | afk  | S   | Notes and close reasons get embedded                         | `ai-11`             |
| `ai-13`  | afk  | M   | Corpus backfill and caps — the one embed job that asks first | `ai-11`             |

**▸ No key required, and memory of judgment** — transformers.js downloaded at click time gives semantic search on a workspace with no API key at all — and is the slot sensitive records embed into at the same dimension. A pass reason written on one deal is cited on a similar company's Context section before you ask a model anything.

| slice   |      |     | title                                                                | blocked by |
| ------- | ---- | --- | -------------------------------------------------------------------- | ---------- |
| `ai-9b` | hitl | M   | Local embeddings — transformers.js, downloaded at click time         | `ai-9a`    |
| `ai-27` | hitl | M   | Judgment memory — similar records' pass reasons as an assembler mode | `ai-12b`   |

### 12. AI on every object, and the graph from outside

_Spaces v1 · 14 slices_

Classify, summarize, extract, space tags, AI attributes, column runs over a paged view, vision with its page-image cache, the extraction cache, the run log, and MCP. Every lane here adds a renderer to the inbox rather than a page, and every spend goes through one ceiling and one usage ledger.

**▸ Every lane** — Documents classify themselves — which is also what makes the deck reader's trigger appear on the right files — anything summarizes into a real editable note with page citations, a term sheet extracts preference, pro-rata and board terms as a note rather than as fields, and space membership finally gets its machine writer: entity_space(source 'ai', confidence) proposed into the queue, never silently written.

| slice        |     |     | title                                                                     | blocked by                              |
| ------------ | --- | --- | ------------------------------------------------------------------------- | --------------------------------------- |
| `ai-14`      | afk | M   | Kind classify — one post-extraction fan-out, and the cheapest lane on it  | `sdk-1`, `ai-4b`, `ai-8a`, `docsurf-2`  |
| `ai-15`      | afk | M   | Summarize — the synthesize lane, landing as a note suggestion             | `ai-4b`, `ai-8a`                        |
| `ai-16`      | afk | S   | DD and legal extract — key terms as a note, not as fields                 | `ai-15`                                 |
| `backfill-6` | afk | M   | Space-tag suggestions — the first entity_space writer that is not a human | `ai-4b`, `ai-8a`, `ai-26`, `backfill-5` |

**▸ AI attributes and column runs** — Any attribute on any object — including a custom object created that morning — can carry an AI config and run per cell, or over every row a saved view names, with the estimate computed from the server-side evaluator so the number shown is the filtered count and not the object's total. Re-running skips rows that already carry an open suggestion.

| slice   |      |     | title                                                                         | blocked by               |
| ------- | ---- | --- | ----------------------------------------------------------------------------- | ------------------------ |
| `ai-17` | hitl | M   | AI attributes — config on existing types, one cell at a time                  | `ai-2`, `ai-4b`, `ai-8a` |
| `ai-18` | hitl | M   | Server-side view filter — one Condition compiler, and the count on every chip | `docsurf-12b`            |

**▸ Vision, the two caches, and the run log** — A photographed deck stops being a dead end, and both sha-keyed derived layers the storage spec specified and nobody owned land beside it: rasterize once and serve both the vision lane and the preview; extract once per (sha, schema, model) so re-asking is free. Settings → AI · Usage shows one run, its steps, the tokens each cost and the suggestions it produced — which is where run vs job_run is reconciled.

| slice        |      |     | title                                                                         | blocked by                     |
| ------------ | ---- | --- | ----------------------------------------------------------------------------- | ------------------------------ |
| `ai-21`      | hitl | M   | Vision lane — scanned decks stop being dead ends                              | `ai-4b`, `ai-10b`              |
| `backfill-9` | afk  | M   | Page-image cache — rasterize once, keyed by sha, shared by vision and preview | `ai-21`, `backfill-3`          |
| `backfill-8` | afk  | M   | Extraction cache — same sha, same schema, same model, no second call          | `ai-6`, `backfill-3`           |
| `ai-25`      | hitl | M   | Run log and the Usage surface — multi-step provenance                         | `ai-15`, `clean:job-run-table` |

**▸ MCP — any assistant, auditable** — Point Claude Desktop at the server with a per-user token and ask what we know about a company: it cites the deck and the space memo with no model key configured in Spaces at all, and refuses a sensitive record the way complete() does. Search and registry follow, propose sends values into /inbox attributed to that token, and four banked features are recorded as deferred with their trigger instead of quietly lost.

| slice         |      |     | title                                                                          | blocked by |
| ------------- | ---- | --- | ------------------------------------------------------------------------------ | ---------- |
| `ai-23a`      | hitl | M   | MCP read — tokens, transport, and the assembler as a tool                      | `ai-1`     |
| `ai-23b`      | afk  | S   | MCP search and registry — the other two read tools                             | `ai-23a`   |
| `ai-24`       | afk  | S   | MCP propose — the same one door, from outside                                  | `ai-23a`   |
| `backfill-14` | afk  | S   | Banked-features register — deferred with the reason and the trigger to revisit | —          |

### 13. Doors that are not an upload — a mailbox, a link, and an API with a spec

_Spaces v1 · 10 slices_

The cheapest inbound channel CONTEXT sequences first, finally sliced: BCC an address and a thread lands on the right company with its participants and its deck. Then deck links snapshotted before they expire, then one versioned external door that describes itself, mints scoped tokens from the same store MCP uses, and turns a captured page into a filed document and a founder suggestion.

**▸ Forwarding mailbox — the cheapest door in** — Configure a throwaway IMAP mailbox, BCC it on a founder thread, and within a cadence the company's timeline carries the thread with its participants, the founder and the free-provider lawyer exist as records, your own partner does not, a domain you already track lands in the review queue instead of as a twin, and the attached deck is on the Files tab, extracted and searchable. No OAuth, no consent screen, no plugin loader in the path.

| slice       |      |     | title                                                                          | blocked by                                   |
| ----------- | ---- | --- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `arrival-1` | hitl | M   | Forwarding mailbox — an address you BCC, polled over IMAP                      | `clean-2a`, `clean-3`, `clean-4`, `clean-2b` |
| `arrival-2` | hitl | M   | Participants become records — work domains, free providers, one collision door | `arrival-1`, `objects-3`                     |
| `arrival-3` | afk  | M   | Forwarded attachments file themselves — the deck lands on the company          | `arrival-1`, `storage-6a`, `docsurf-7`       |

**▸ Deck links — a DocSend before it expires** — Paste a DocSend, Pitch or Notion link into a deal's upload box and get a searchable PDF of the deck in the document pipeline, still readable after the link dies — registered as a renderer on the clip job's link-kind table rather than a second branch inside a guarded fetch.

| slice       |      |     | title                                                                | blocked by                                 |
| ----------- | ---- | --- | -------------------------------------------------------------------- | ------------------------------------------ |
| `arrival-4` | hitl | M   | Deck links — a DocSend or Pitch link becomes a PDF before it expires | `docsurf-10a`, `docsurf-10b`, `storage-6a` |

**▸ A door with a spec on it** — One versioned external namespace on the HttpApi already in the pinned package, one handshake procedure, and $APP_URL/api/v1/openapi.json importable into Postman or n8n before a single credential exists. Then the read half: n8n pages through records and the object registry as the token's user with canRead applied in SQL — no filter dialect, no second search, no write path.

| slice   |      |     | title                                                               | blocked by       |
| ------- | ---- | --- | ------------------------------------------------------------------- | ---------------- |
| `api-1` | hitl | M   | HttpApi door — one definition, OpenAPI out (D8)                     | `mono-1`         |
| `api-2` | afk  | S   | OpenAPI emission — one spec document, versioned and snapshot-tested | `api-1`          |
| `api-6` | afk  | M   | Public read API — records and registry, paginated, no filters       | `api-2`, `api-3` |

**▸ Capture without an extension** — A token minted in settings — from the same store MCP uses, not a second one — opens the API as its user with per-scope refusals; a page's text posted by curl becomes a filed, searchable document with its source URL; and a moment later a founder suggestion is in /inbox with role and company filled in, ready to accept into a real person. The MV3 extension is then a thin client with nothing left to invent.

| slice   |      |     | title                                                                  | blocked by                                             |
| ------- | ---- | --- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `api-3` | afk  | S   | Scoped tokens on the API door — one personal-token store, not a second | `api-1`, `ai-23a`                                      |
| `api-4` | afk  | M   | /api/capture v1 — page text in, a filed document out                   | `api-2`, `api-3`, `storage-6a`, `clean-4`, `docsurf-7` |
| `api-5` | hitl | M   | Capture extraction — the deck reader's twin, pointed at a person       | `api-4`, `ai-6`, `ai-7`, `ai-8a`                       |

### 14. Import and export — a spreadsheet becomes the graph

_Spaces v1 · 12 slices_

The onboarding-critical channel: every prospective user has deal flow in a spreadsheet today and a portfolio that predates the product. Read CSV and XLSX into one grid, map onto the object registry so a custom object imports with no importer change, preview attach-or-create before anything is written, commit idempotently, and bootstrap holdings as dated events rather than balances — with a correction door, because the event tables are append-only and an import commits forty rows at once.

**▸ A spreadsheet reads and maps** — Drop the messy CSV or xlsx onto /import, pick any object in the registry, and every column says where it lands and how many of its values will parse — '38 of 40', with the two offenders and their reasons one click away, and a Stage column reading 'Seed' against an option that does not exist refused by name rather than invented. Nothing has touched the graph and no new dependency entered package.json.

| slice      |      |     | title                                                                     | blocked by               |
| ---------- | ---- | --- | ------------------------------------------------------------------------- | ------------------------ |
| `import-1` | afk  | M   | Spreadsheet reader — CSV and XLSX to one cell grid                        | —                        |
| `import-2` | hitl | M   | Staged import — a spreadsheet becomes a batch, nothing reaches the graph  | `import-1`, `storage-6a` |
| `import-3` | afk  | M   | Column mapping onto the registry — the type system is already the mapping | `import-2`, `objects-5`  |
| `import-4` | afk  | M   | Cell coercion per attribute type — and the columns that will not parse    | `import-3`               |

**▸ The first import lands** — A 46-row company sheet and a 40-row deal sheet become companies, deals and people: the preview says '31 create · 12 attach · 3 errors' before anything is written, reference cells find their record or error naming both candidates, near-duplicates queue in the existing review inbox instead of appearing as silent twins, and re-running the same file writes nothing.

| slice      |     |     | title                                                                   | blocked by                                    |
| ---------- | --- | --- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `import-5` | afk | M   | Resolve preview — attach or create, decided before anything is written  | `import-4`, `clean-3`                         |
| `import-6` | afk | S   | Reference cells find their record — a deal's company column             | `import-5`                                    |
| `import-7` | afk | M   | Idempotent commit — the first import lands, and a re-run writes nothing | `import-6`, `objects-1a`, `sdk-1`, `clean-2b` |

**▸ An angel arrives with a portfolio** — A 12-row tracking sheet becomes holdings with dated rounds, investments and marks — events, never balances — so MOIC, IRR and as-on views work on day one for checks that predate the product, with missing FX surfaced rather than faked. And because those tables are append-only with no edit path, the correction door lands first: a reversing entry with a reason, the same door ai-22's accepted proposals use.

| slice       |     |     | title                                                               | blocked by             |
| ----------- | --- | --- | ------------------------------------------------------------------- | ---------------------- |
| `import-8`  | afk | M   | Ledger mapping — one spreadsheet row becomes dated events           | `import-6`             |
| `import-11` |     |     | _body not yet written_                                              |                        |
| `import-9`  | afk | M   | Ledger commit — holdings born, events appended, nothing overwritten | `import-7`, `import-8` |

**▸ Out as well as in, and a dialect is a plugin** — The data can leave — the question a self-hosted product must be able to answer — and an Airtable export imports through the same preview and the same commit as a hand-mapped CSV, proving the pipeline stays core while dialects live outside it. This milestone is the one part of the project gated on the SDK.

| slice       |      |     | title                                                                              | blocked by                     |
| ----------- | ---- | --- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `import-12` |      |     | _body not yet written_                                                             |                                |
| `import-10` | hitl | M   | The importer kind gets its tenant — a dialect is a plugin, the pipeline stays core | `import-7`, `sdk-5`, `sdk-12a` |

### 15. packages/core and apps/worker

_Extensibility · 8 slices_

The attribute and identity write paths, the vault, storage, seeds and the boot composition, the assembler and canRead move into packages/core; the dependency fence becomes lint; apps/worker becomes its own package carrying the already-shipped wrapper and heartbeat. This project ships no user-visible surface and is verified by regression — that is the success criterion for an extraction, not a smell.

**▸ The write paths move** — Edit a select cell and a reference cell, merge two duplicate people, save a shared and a private view — all through code now in packages/core, with setValues' single-write-path fence enforced by lint and the author/admin guard still refusing a stranger.

| slice     |     |     | title                                                                             | blocked by         |
| --------- | --- | --- | --------------------------------------------------------------------------------- | ------------------ |
| `mono-8a` | afk | M   | packages/core, attribute write path — setValues keeps its single-write-path fence | `mono-5`, `mono-7` |
| `mono-8b` | afk | M   | packages/core, identity write path — resolve, merge, and the view store           | `mono-8a`          |

**▸ Vault, storage, seeds and boot — three silences, three PRs** — Delete secret.key on a scratch database and boot: it regenerates at 0600 with the warning, a credential written before the move still decrypts, and a session cookie from before the PR still logs you in. Uploads round-trip under both drivers with the blob beside the ones already on disk. One command still migrates then seeds, in that order, and a deleted taxonomy space stays deleted.

| slice     |     |     | title                                                                  | blocked by |
| --------- | --- | --- | ---------------------------------------------------------------------- | ---------- |
| `mono-9a` | afk | S   | Vault into core — the master key, /data, and nothing regenerates       | `mono-8a`  |
| `mono-9d` | afk | S   | Storage into core — one driver interface, both drivers, the same bytes | `mono-9a`  |
| `mono-9e` | afk | S   | Seeds and the boot composition — one command migrates, then seeds      | `mono-8a`  |

**▸ The assembler moves, the fence goes up, the worker is its own app** — The context readout returns the same items in the same order with canRead intact, now running through packages/core. Dependency rules stop being aspirational: a db import from the plugins fixture fails with the rule's message and the spec section. apps/worker becomes its own package, an apps/web import inside it is refused, and the queue names are renamed once with the consequence for in-flight jobs and the 03:30 schedule row recorded.

| slice      |     |     | title                                                                      | blocked by           |
| ---------- | --- | --- | -------------------------------------------------------------------------- | -------------------- |
| `mono-9b`  | afk | M   | Context assembler into core — and canRead leaves the server barrel with it | `mono-8b`            |
| `mono-10`  | afk | S   | Dependency rules as lint — packages/config and the import zones            | `mono-9a`, `mono-9c` |
| `mono-11a` | afk | S   | apps/worker — its own package, behaviour untouched                         | `mono-9c`, `mono-10` |

### 16. A published image anyone can run

_Extensibility · 8 slices_

The pruned, source-free image; the first browser coverage the project has ever had; multi-arch images on GHCR and Docker Hub from a tag; install, upgrade and rollback docs; upgrade CI that boots the last release against this commit's schema; and one-click templates. Placed here rather than last because the rename already landed in project 1, so nothing bakes DealOS in — and because the image is the adoption win CONTEXT calls the biggest one outstanding.

**▸ A source-free image** — turbo prune --docker layering, the docker/ layout, the ROLE branch, and the worker, migrate and health entries bundled so src/ and tsx leave the image — with su-exec and both entrypoint privilege phases intact, a PDF and a DOCX still becoming searchable, and the before/after image sizes recorded.

| slice      |      |     | title                                                                  | blocked by          |
| ---------- | ---- | --- | ---------------------------------------------------------------------- | ------------------- |
| `mono-13a` | afk  | M   | Pruned image — turbo prune --docker, docker/ layout, built on every PR | `mono-12`, `mono-6` |
| `mono-13b` | hitl | M   | Bundled worker — src/ and tsx leave the image                          | `mono-13a`, `sdk-1` |

**▸ A browser proves it works** — A real Chromium proves you cannot reach /today signed out, cannot claim /setup without the log token, cannot claim it twice, and cannot sign up once an admin exists — then composes the image built from the PR, waits for health to say db ok and worker ok, drops a DOCX on a company's Files tab and asserts the extracted text in the preview. The first time any of that has been checked outside a person's hands, and a harness every later UI slice adds one spec to.

| slice    |     |     | title                                                                | blocked by                                |
| -------- | --- | --- | -------------------------------------------------------------------- | ----------------------------------------- |
| `ship-6` | afk | M   | Playwright harness — the login gate and the first-run setup window   | `mono-6`                                  |
| `ship-7` | afk | M   | Upload to preview in a real browser — the smoke that gates a release | `ship-6`, `ship-2`, `mono-12`, `mono-13a` |

**▸ docker compose up from a published tag** — A stranger with no checkout drops in a compose file pinned to a multi-arch tag and is at /setup in a minute on arm64 or amd64, with no 583 MB build on their box. They can back up, they can restore from total loss, and the README tells them what to back up and what losing secret.key costs — in bold.

| slice     |      |     | title                                                                                  | blocked by                     |
| --------- | ---- | --- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `ship-8`  | hitl | M   | Published images — multi-arch GHCR and Docker Hub on a core@ tag                       | `ship-7`, `ship-1`, `mono-13a` |
| `ship-10` | afk  | M   | Install, upgrade and rollback docs — back up first, pin the tag, never lose MASTER_KEY | `ship-3`, `ship-5`, `ship-8`   |

**▸ The path back is tested** — Push a migration that drops a column something still reads and the upgrade job goes red naming that migration, with both images' logs attached, instead of the breakage arriving on an operator's box. And the PaaS templates put the whole thing one click away on the platforms self-hosters actually use.

| slice     |     |     | title                                                   | blocked by          |
| --------- | --- | --- | ------------------------------------------------------- | ------------------- |
| `ship-11` | afk | M   | Upgrade CI — last release's image, this commit's schema | `ship-8`, `ship-5`  |
| `ship-12` | afk | S   | One-click templates — Coolify, Railway, Render, Unraid  | `ship-8`, `ship-10` |

### 17. The plugin SDK — claims without a database

_Extensibility · 13 slices_

@spaces/sdk, the semver-frozen claim and kind contracts, the testing kit, the loader, the live ports, and claims landing as graph writes with provenance a plugin cannot forge. Born inside the dependency fence rather than retrofitted into it, and tested with Postgres stopped — the cheapest second agent you can have running.

**▸ A plugin can be written and tested without the app** — An author writes a manifest in TS (emitted as JSON Schema so web renders it without the bundle, with the supported type subset refused at validation time rather than rendered badly), a job against typed ports, normalizes identity keys the same way the choke point does, and proves 'this provider JSON produces these claims' with no Postgres, no network and no running product. Pack and verify settles the signing scheme and the unsigned escape.

| slice     |      |     | title                                                                    | blocked by                |
| --------- | ---- | --- | ------------------------------------------------------------------------ | ------------------------- |
| `sdk-3`   | afk  | M   | @spaces/sdk skeleton — manifest as TS, JSON Schema on disk, definePlugin | `mono-workspace-scaffold` |
| `sdk-4a`  | hitl | M   | Claims and kind interfaces — the semver-frozen contract                  | `sdk-3`                   |
| `sdk-4b`  | afk  | S   | Identity-key normalizers move into the SDK — one list, no drift          | `sdk-4a`                  |
| `sdk-5`   | afk  | M   | Port tags and the testing kit — claims provable without a database       | `sdk-4a`                  |
| `sdk-21a` | hitl | M   | Pack and verify — the signing scheme, registry.json, and a tamper check  | `sdk-3`                   |

**▸ Ambient ports and the loader's verdict** — Point the data dir at four fixtures and start the worker: one verdict line per plugin, /api/health listing the degraded ones with reasons beside the worker line it already carries, manifests cached on the integration rows, and the extraction queue serving throughout. Config, Secrets, Log, Http and ReadLive are live and bound to one integration row — the log shows the redacted key and shows a private note was never read.

| slice    |     |     | title                                                                           | blocked by                         |
| -------- | --- | --- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `sdk-11` | afk | M   | Loader part one — discover, locate, validate, cache the manifest, mark degraded | `sdk-3`, `clean-integration-table` |
| `sdk-6a` | afk | M   | Ambient ports live — Config, Secrets, Log and Http bound to one integration row | `sdk-5`, `clean-integration-table` |
| `sdk-6b` | afk | S   | ReadLive — the plugin's view of the graph, as actor integration                 | `sdk-5`, `clean-integration-table` |

**▸ Claims become graph writes** — A fixture plugin's claims land as entities, aliases, receipts, interactions, signals, documents and values — each stamped to an integration row by the port, fill-blanks decided inside the row lock, collisions becoming duplicate candidates and conflicts becoming suggestions in the queue that already exists. Content.fileDocument is a thin port over the intake and birth modules with no pipeline of its own.

| slice    |     |     | title                                                                                | blocked by                                                         |
| -------- | --- | --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `sdk-7a` | afk | M   | Identity and Receipts live — provenance the plugin cannot forge                      | `sdk-5`, `clean-integration-table`, `clean-source-class`           |
| `sdk-7b` | afk | M   | Content's interaction and signal lanes — evidence rows with a typed source           | `sdk-5`, `clean-integration-table`, `clean-source-class`           |
| `sdk-8`  | afk | S   | Content.fileDocument — a plugin's bytes through intake and birth                     | `sdk-7a`, `clean-3`, `clean-4`, `storage-6a2`                      |
| `sdk-9`  | afk | M   | Facts live — fill blanks only, inside the existing row lock                          | `sdk-5`, `sdk-7a`, `clean-integration-table`, `clean-source-class` |
| `sdk-10` | afk | S   | Judgment live — machine writes that are suggestions, and Facts conflicts become them | `sdk-9`, `ai-suggestion-inbox`                                     |

### 18. Plugins run unattended, Apollo enriches

_Extensibility · 10 slices_

A Layer per (integration, job), queues by kind, the breaker, hot reload, then Apollo end to end with credit safety, manifest actions, live status and event triggers.

**▸ A Layer per job, and queues by kind** — The privilege boundary is built and released per (integration, job): an over-reaching job fails with service-not-found while the database stays clean and the worker stays up. Queues register, schedule and unregister without a restart.

| slice     |     |     | title                                                                       | blocked by                                                |
| --------- | --- | --- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `sdk-12a` | afk | M   | A Layer per (integration, job) — the privilege boundary, built and released | `sdk-11`, `sdk-6a`, `sdk-6b`, `sdk-7a`, `sdk-7b`, `sdk-9` |
| `sdk-12b` | afk | M   | Queues by kind — register, schedule, unregister without restarting          | `sdk-12a`, `sdk-1`                                        |

**▸ Failures disable the plugin, never the worker** — Five failures fill job_run, flip the integration to disabled with a reason and put one line on Today while extraction keeps working in the same worker. Enable, disable and upgrade happen over NOTIFY with no restart, and the exit-75 escape hatch is reconciled with the either-process-dies contract.

| slice     |      |     | title                                                                    | blocked by            |
| --------- | ---- | --- | ------------------------------------------------------------------------ | --------------------- |
| `sdk-13`  | afk  | M   | Plugin breaker — five failures disable the integration, never the worker | `sdk-12b`, `clean-2b` |
| `sdk-14a` | afk  | M   | NOTIFY plugin_changed — enable, disable and upgrade without a restart    | `sdk-12b`             |
| `sdk-14b` | hitl | S   | Exit-75 reload — the escape hatch that argues with contract 2            | `sdk-14a`             |

**▸ Apollo enriches a company** — Paste a key, see the Enrich action appear on records rendered from the row's manifest, click it and watch blanks fill with Apollo as actor and the raw payload in an enrichment_record — credit-capped, 90-day cached, refusals visible on Today. This is the plugin arc's undeclared L and should be split at the provider-client seam before it is grabbed.

| slice    |      |     | title                                                                  | blocked by         |
| -------- | ---- | --- | ---------------------------------------------------------------------- | ------------------ |
| `sdk-15` | afk  | M   | Apollo's mapping — provider JSON becomes claims, with no database      | `sdk-5`, `sdk-4b`  |
| `sdk-16` | afk  | M   | Credit safety — daily cap, 90-day cache, refusals that are visible     | `sdk-15`, `sdk-13` |
| `sdk-17` | hitl | M   | Manifest actions — the Enrich button, rendered from the row's manifest | `sdk-15`, `sdk-11` |

**▸ Under a second, and on creation** — LISTEN/NOTIFY to SSE so the cell goes pending then resolves with no refresh, survives a mid-run reload, and settles into failure rather than spinning when the worker dies. New companies with a domain enrich themselves on creation, with the emitter's home decided.

| slice    |      |     | title                                                                   | blocked by                    |
| -------- | ---- | --- | ----------------------------------------------------------------------- | ----------------------------- |
| `sdk-18` | hitl | M   | Interactive status — LISTEN/NOTIFY to SSE, so 'later' is under a second | `sdk-17`, `sdk-13`, `sdk-14a` |
| `sdk-19` | hitl | M   | Event triggers — enrich-on-create, and where the emitter lives          | `sdk-12b`, `sdk-15`           |

### 19. Install from the app, no redeploy

_Extensibility · 10 slices_

The integrations ledger, manifest-generated settings forms, install/upgrade/uninstall, the plugin release pipeline, air-gapped install, webhook ingress, plugin schemas, and the chaos suite that decides whether a plugin ships.

**▸ The integrations ledger** — Settings → Integrations shows installed rows with version, status, last run and last error — Apollo enabled, a fixture breaker-disabled with a working reset, an old-sdk fixture degraded with the fix named — in the settings shell rather than a third invented layout. A manifest becomes an editable card with an inline-validated key field, and saving reloads the worker with the new config.

| slice     |      |     | title                                                                       | blocked by                                     |
| --------- | ---- | --- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `sdk-20a` | hitl | M   | Integrations ledger — installed rows, version, status, last run, last error | `sdk-13`, `sdk-14a`, `clean-integration-table` |
| `sdk-20b` | hitl | M   | Settings form and the key field — a manifest becomes an editable card       | `sdk-20a`, `sdk-6a`                            |

**▸ Install, upgrade, uninstall — and how a plugin reaches anyone** — Click Install and watch files land under the data dir and the worker load and enable it without touching a terminal; a tampered tarball is refused with the data dir untouched. A new version gets its own directory and runs its own migrations, the previous is kept one back, and a rollback after a migration refuses by name rather than corrupting. Merge a changeset and a plugin-<id>@x tag builds, tests, packs, signs and publishes it with the registry entry updated in the same commit.

| slice         |      |     | title                                                                               | blocked by                      |
| ------------- | ---- | --- | ----------------------------------------------------------------------------------- | ------------------------------- |
| `sdk-21b`     | hitl | M   | Install from the running deployment — fetch, unpack, row, notify, uninstall         | `sdk-21a`, `sdk-20a`, `sdk-14a` |
| `sdk-22`      | afk  | M   | Air-gapped install and SPACES_PLUGINS — the same installer, two other doors         | `sdk-21b`                       |
| `backfill-13` | afk  | M   | Plugin upgrade — a new version dir, its own migrations, and a rollback that refuses | `sdk-21b`, `sdk-24a`, `sdk-20a` |
| `ship-9`      | afk  | M   | Changesets and the plugin tag — how a plugin reaches the registry                   | `ship-8`, `sdk-21a`             |

**▸ Webhooks and plugin schemas** — A signed payload returns 200 in milliseconds with the raw body retained and claims landing a moment later — on a raw route outside the versioned API namespace, because HMAC is computed over the exact bytes; a flipped byte is 401 and a disabled plugin is 404. A plugin owns tables in its own Postgres schema under a role that cannot write public, proven by a real RSS poller.

| slice     |      |     | title                                                                   | blocked by                                    |
| --------- | ---- | --- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `sdk-23`  | afk  | M   | Webhook ingress — verify in web, store, enqueue, return in milliseconds | `sdk-12b`, `sdk-20b`, `clean-credential-kind` |
| `sdk-24a` | hitl | M   | PluginDb — own schema, own journal, and a role that cannot touch public | `sdk-12a`, `mono-test-db-harness`             |
| `sdk-24b` | afk  | M   | plugins/rss — the first real PluginDb tenant, and the first poller      | `sdk-24a`, `sdk-7b`, `sdk-20b`                |

**▸ A plugin passes or does not ship** — Provider fakes and the chaos suite: with no API keys anywhere and the network off, SPACES_FAKE_PROVIDERS=1 gives a clickable Enrich with plausible data, and the chaos suite runs green.

| slice    |     |     | title                                                                 | blocked by                                 |
| -------- | --- | --- | --------------------------------------------------------------------- | ------------------------------------------ |
| `sdk-25` | afk | M   | Provider fakes and the chaos suite — a plugin passes or does not ship | `sdk-15`, `sdk-23`, `mono-test-db-harness` |

### 20. Storage sources — connect an account, attach a file

_Extensibility · 11 slices_

The provider registry, the consent dance split at the redirect boundary, token custody, the StorageSource read port with its fake and chaos list, the Drive plugin's read side, and attach-from-Drive. Needs the TLS overlay from project 1: Google and Box reject non-localhost http redirect URIs, so the dance cannot be proven without a real https origin.

**▸ Connect an account** — Register the Google app once without clobbering an existing Gemini key (credential.kind opened in project 3), click Connect and land on Google's own consent screen listing exactly the scopes asked for at the redirect URI Settings printed, then watch one encrypted grant row appear with its scopes and expiries. Scopes grow without a second account row, tokens refresh once under a cross-process lock so a rotating refresh token is never spent twice, and a revoked grant shows the provider's own reason.

| slice         |      |     | title                                                                  | blocked by                 |
| ------------- | ---- | --- | ---------------------------------------------------------------------- | -------------------------- |
| `storage-1`   | hitl | M   | Provider registry — one OAuth app per provider, in the vault           | —                          |
| `storage-2a`  | hitl | M   | The outbound leg — PKCE, a signed state, and the provider's own screen | `storage-1`                |
| `storage-2a2` | afk  | M   | The grant row — code exchange, provider identity, one encrypted bundle | `storage-2a`               |
| `storage-2b`  | afk  | S   | Incremental scopes — consenting to Drive never re-grants Calendar      | `storage-2a`               |
| `storage-3a`  | afk  | M   | Token custody — refresh under a row lock, revoke, one accessor         | `storage-2a`               |
| `storage-3b`  | hitl | M   | Settings → Connections — whose account, which scopes, disconnect       | `storage-3a`, `storage-2b` |

**▸ The port and its fake** — A read conformance suite green against an in-process fake Drive, plus the chaos list — 429, vanished files, expired cursors, a 200 MB scan — with the assertions proven real by flipping the fake's toggles. The reason Box later is one array entry rather than a project.

| slice        |     |     | title                                                                | blocked by                         |
| ------------ | --- | --- | -------------------------------------------------------------------- | ---------------------------------- |
| `storage-4a` | afk | M   | The StorageSource read port — a fake Drive and its conformance suite | `sdk-sdk-package`, `mono-packages` |
| `storage-4b` | afk | S   | The chaos list — 429, vanished files, expired cursors, a 200 MB scan | `storage-4a`                       |

**▸ A file arrives from Drive** — Paste a Drive URL or open the picker on a record: the file streams through the one intake module into our blob, is extracted, is searchable in Cmd-K, shows the folder path it came from and opens back in Drive — with the gone state and the Open-in-source action decided here, by the slice that first produces one.

| slice        |      |     | title                                                              | blocked by                                                     |
| ------------ | ---- | --- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `storage-5`  | afk  | M   | Google Drive plugin, read side — a bytes pipe with hints           | `storage-3a`, `storage-4a`, `sdk-loader`, `sdk-runjob`         |
| `storage-6b` | hitl | M   | Arrival from a link — paste a Drive URL, get the file and its path | `storage-6a`, `storage-5`, `storage-3a`, `sdk-integration-row` |
| `storage-7`  | hitl | M   | The provider picker — attach from Drive without leaving the record | `storage-6b`, `storage-2b`                                     |

### 21. A bound data room

_Extensibility · 9 slices_

storage_binding, first sync, resolveItem's match-only filing, the change poll, revisions, and the change table split one row per failure mode — renames and moves, gone pointers, tombstones and the expired-cursor re-list.

**▸ Bind a folder** — Link a Drive folder to a deal, company or space with overlap refused by name; the Files tab fills with 14 documents carrying their Drive paths, and re-running keeps the count at 14. Kind folders become kinds, company folders resolve through a match-only lookup that creates nothing, and a typo lands as a suggestion rather than as a company.

| slice        |      |     | title                                                                         | blocked by                                                          |
| ------------ | ---- | --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `storage-8a` | hitl | M   | storage_binding — one folder, one owner node, guarded at bind time            | `storage-7`, `storage-4a`, `docsurf-space-filing`                   |
| `storage-8b` | afk  | M   | First sync — a bound data room fills the Files tab, twice with the same count | `storage-8a`, `storage-6a`, `storage-5`                             |
| `storage-9`  | afk  | M   | resolveItem — folder names are hints, never identity                          | `storage-8b`, `ai-5`, `ai-8a`, `docsurf-1a`, `docsurf-2`, `clean-3` |

**▸ The change poll** — A cursor per drive and a filter per binding: new files inside the bound subtree arrive and files outside it do not, and edits become revisions keyed on the provider's revision id with the prior sha kept.

| slice         |     |     | title                                                               | blocked by                              |
| ------------- | --- | --- | ------------------------------------------------------------------- | --------------------------------------- |
| `storage-10a` | afk | M   | The change poll — a cursor per drive, a filter per binding          | `storage-8b`, `storage-9`, `storage-4b` |
| `storage-10b` | afk | M   | Modified files — the row advances, the prior sha becomes a revision | `storage-10a`                           |

**▸ The rest of the change table, one failure mode at a time** — A rename advances the path and a move across companies proposes rather than repoints; a provider-side delete and a file leaving the binding both mark the pointer gone with the same badge and propose nothing; an app-side delete leaves a tombstone and an expired cursor re-lists the whole bound subtree without resurrecting it — the two halves tested against each other, which is the only way either is proven.

| slice         |     |     | title                                                                        | blocked by                           |
| ------------- | --- | --- | ---------------------------------------------------------------------------- | ------------------------------------ |
| `storage-11`  | afk | M   | Renames and moves — the path advances, a crossing move is a suggestion       | `storage-10b`, `ai-suggestion-inbox` |
| `storage-11b` | afk | S   | Gone pointers — deleted at the provider, or moved out of the binding         | `storage-11`                         |
| `storage-11c` | afk | M   | The resurrection guard — a tombstone on app-side delete, and a clean re-list | `storage-11b`                        |

**▸ Retain per binding** — retain: text makes a 40 GB data room searchable without holding its bytes — ./data/blobs grows by nothing while Cmd-K hits the contents and preview streams from the provider — with the policy stated for the derived layers and the import payload too, not only for blobs. Flip to full and watch the backfill fill the disk.

| slice        |      |     | title                                                        | blocked by   |
| ------------ | ---- | --- | ------------------------------------------------------------ | ------------ |
| `storage-12` | hitl | M   | Retain policy — full keeps the bytes, text keeps the meaning | `storage-8b` |

### 22. Drive as the archive, Box on the same port

_Extensibility · 9 slices_

The write half of the port, write-through, the mirror root, live files proposing ledger events through the correction door, binding health, sensitivity riding the filing, and Box proved by a diff that shows no core file changed. Half of this is speculative until a real user asks — treat it as a backlog with an order.

**▸ Write-through and the mirror root** — ensureFolder, putFile, move and rename pass the extended conformance suite including the concurrent case. An upload on a bound record lands in Drive too with no duplicate row on the poll that sees it, and a mirror root fills Drive with the Space/Company/Deal/Kind tree the fund would have built by hand — lazily, sanitised, no empty folders.

| slice        |      |     | title                                                            | blocked by                                |
| ------------ | ---- | --- | ---------------------------------------------------------------- | ----------------------------------------- |
| `storage-13` | afk  | M   | The write half of the port — ensureFolder, putFile, move, rename | `storage-5`, `storage-4b`                 |
| `storage-14` | afk  | M   | Write-through — an upload on a bound record lands in Drive too   | `storage-13`, `storage-10b`, `storage-11` |
| `storage-15` | hitl | M   | Mirror root — Drive fills itself with the tree you'd have built  | `storage-14`                              |

**▸ Live files propose ledger events** — Follow a cap table and watch its revisions accumulate as an append-only ledger; change it in Drive and /inbox offers 'ownership moved 12.4% → 9.8%, propose a mark'. Accept and the holding's ledger gains one append-only row — through the same programs the import commit uses, so the append-only tables keep exactly one writer each.

| slice        |      |     | title                                                                        | blocked by                            |
| ------------ | ---- | --- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `storage-16` | hitl | M   | Live files — follow a Sheet, keep its revisions                              | `storage-10b`, `storage-8a`           |
| `ai-22`      | hitl | M   | Live-file revisions propose ledger events — the append-only tables' one door | `ai-8a`, `storage:document-revisions` |

**▸ Safe hands** — A revoked token or a departed binder surfaces on Today and on Connections and can be re-bound by another user whose access is checked first, resuming with no duplicates. Sensitivity is decided at ingest and rides from the binding down to the chunk, into the local embedding slot that has been waiting for it since project 11.

| slice        |      |     | title                                                                           | blocked by                                |
| ------------ | ---- | --- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `storage-17` | hitl | M   | Binding health — the binder left, the token died                                | `storage-8b`, `storage-3b`, `storage-14`  |
| `storage-18` | afk  | M   | The sensitivity stamp — one writer, raised in the transaction, lowered by a job | `ai-26`, `ai-12a`, `ai-10b`, `storage-8b` |

**▸ A second provider, no core diff** — A Box-first fund gets the same connect, bind, filing and write-through — single-use refresh tokens and an eventless items API absorbed inside the plugin — and the proof is git diff --stat showing no core file changed.

| slice         |     |     | title                                                  | blocked by                  |
| ------------- | --- | --- | ------------------------------------------------------ | --------------------------- |
| `storage-19a` | afk | M   | Box, read side — the same port, a second fake          | `storage-11`, `storage-4b`  |
| `storage-19b` | afk | M   | Box, bound and writing — the port measured by the diff | `storage-19a`, `storage-14` |

### 23. The researcher lane, syncers, recorders and feeds

_Extensibility · 8 slices_

The last unimplemented port goes live and every kind interface the SDK froze finally gets a tenant: a researcher, a syncer, an ingress, a poller. Placed last because each needs OAuth, the loader and the fakes — but every one of them is a channel CONTEXT names, and none of them may be dropped silently.

**▸ The last unimplemented port** — The Ai port's live layer with the sensitivity gate and the spend ceiling enforced by core rather than trusted to the plugin, tokens attributed to the integration and not to a user; then Exa as the researcher kind's first tenant — five web signals on a record and a one-paragraph brief in /inbox citing the five URLs.

| slice         |     |     | title                                                                          | blocked by                                             |
| ------------- | --- | --- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `backfill-11` | afk | M   | Ai port live — the researcher lane, budgeted and attributed to the integration | `sdk-12a`, `ai-4a`, `ai-26`, `backfill-4`              |
| `backfill-12` | afk | M   | plugins/exa — the first researcher, its signals and its brief                  | `backfill-11`, `sdk-12b`, `sdk-6b`, `sdk-7b`, `sdk-10` |

**▸ The first syncer** — Connect Google Calendar and let the schedule fire: this week's external meetings appear on the right companies' timelines with matched attendees, last week's do not, the internal standup never appears, and an expired sync token recovers without re-importing five years of history.

| slice       |     |     | title                                                                          | blocked by                                                                       |
| ----------- | --- | --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `arrival-5` | afk | M   | plugins/google-calendar — the first syncer, forward-only from the connect date | `arrival-2`, `sdk-4a`, `sdk-7b`, `sdk-12b`, `sdk-25`, `storage-2b`, `storage-3a` |

**▸ The first ingress** — A signed Fathom payload lands a call with its attendees, files the transcript on everyone in the room and links it back to the call; replay it and nothing doubles. The recorder's summary arrives as a suggestion you accept into a real editable note with the transcript cited — sdk-23's ingress stops having a fixture for a customer.

| slice       |     |     | title                                                                          | blocked by                                |
| ----------- | --- | --- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `arrival-6` | afk | M   | plugins/recorder — a webhook lands the transcript on the call                  | `arrival-2`, `sdk-23`, `sdk-8`, `notes-5` |
| `arrival-7` | afk | S   | The recorder's summary is a suggestion — accept it and the call has a write-up | `arrival-6`, `ai-15`, `sdk-10`, `notes-6` |

**▸ Feeds, and a mailbox that syncs itself** — A feed URL attached to a space or a record, polled on a cadence you can mute, items matched deterministically into signals with the unmatched kept visible because that is where the next company comes from. Then Gmail forward-only from the connect date, deduped against threads the forwarding lane already saw, with the privacy default decided, recorded and enforced at read time.

| slice        |      |     | title                                                                            | blocked by                                                                  |
| ------------ | ---- | --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `arrival-8`  | hitl | M   | feed and feed_item — one URL, three scopes, a cadence you can mute               | `sdk-24b`, `docsurf-1b`                                                     |
| `arrival-9`  | afk  | M   | Feed items match the graph — a signal on the record, the unmatched still visible | `arrival-8`                                                                 |
| `arrival-10` | hitl | L   | plugins/gmail — forward-only sync, and the privacy default finally decided       | `arrival-2`, `arrival-3`, `arrival-5`, `sdk-25`, `storage-2b`, `storage-3a` |

---

## 2. What changed in the reconciliation

- **merge** `sdk-1` `mono-11b` — sdk-1 is the canonical runJob wrapper and absorbs mono-11b's one real contribution — the retryable-versus-terminal outcome mapping (transient blob read → JobRetryable; unsupported mime and sha mismatch → JobPermanent) plus a JobContext service {queue, jobId, attempt, isFinalAttempt} in the Layer so extraction_status is only written on a terminal failure or the final attempt. run(data) keeps its §11 signature. sdk-1 explicitly does NOT rename queue strings.
- **merge** `sdk-2` `mono-12` — sdk-2 is the canonical heartbeat and absorbs mono-12. The row is keyed by role, not HOSTNAME, so restart-idempotence is structural; instance and pid are stored for the operator and never served; the unauthenticated /api/health payload stays {status, db, worker:{status, lastBeatSeconds}}; overall status and the HTTP code are driven by the database alone so a dead worker never restarts a healthy web container. Keeps sdk-2's ROLE=worker self-check, the $ROLE-branched HEALTHCHECK and docker-compose.split.yml. Size S → M.
- **merge** `mono-11a` `mono-11b` — The core.<domain>.<verb> queue rename — homeless once mono-11b is deleted, and refused by mono-9c — is reassigned to mono-11a together with its drain-or-abandon note for in-flight jobs and the 03:30 'entity.dedupe-sweep' schedule row. mono-11a's 'behaviour untouched' framing relaxes to 'handlers untouched, queue names renamed once, with the upgrade consequence recorded'. This matters more after objects-4, where a stale schedule row is a silently dead nightly job.
- **merge** `mono-1` `mono-10` — The eslint ownership line is written into both bodies. mono-1 adds, renames and relocates no rule — eslint.config.js stays at the repo root and only its four path globs move; its lint check is a regression guard, named as such. mono-10 owns moving the config into packages/config and adding the new sdk/core/web/db boundary zones, and its failing-case demo is a boundary zone only.
- **merge** `objects-3` `ai-8a` — One review surface, built once and early. objects-3 becomes 'Review inbox — /inbox, one queue over typed rows' (afk, S → M): /dedupe → /inbox with a permanent redirect, dedupe.ts → inbox.ts by git mv, listInbox() returning a kind-discriminated InboxRow[], a RENDERERS map with a payload fallback, countOpenInbox() → {open, byKind} in one grouped query, and the pair card with objects-3's two hardcodings removed. ai-8a shrinks to the second row kind: the suggestion member, its card, the HeaderTab filter tabs and the UNION ALL count. Bulk accept never touches duplicate rows; 'inbox' joins 'dedupe' in RESERVED.
- **merge** `docsurf-6a` `storage-6a1` `storage-6a2` `sdk-8` — Two byte lanes, one row birth — nobody claims to be the only writer of bytes. docsurf-6a owns the browser lane (grep: exactly one crypto.subtle), storage-6a2 owns server intake (grep: exactly one storage().put outside seeds), storage-6a1 owns document birth (grep: exactly one insert(document) outside tests and seeds). Birth's signature widens once now: fileAgainst is an array of targets, blobSha and actor nullable, provenance as one bag. Neither server module is re-exported from the client-imported barrel. sdk-8's hedge ('if the extraction has not landed when this one starts, this one performs the extraction') is deleted — that hedge is the mechanism that produced this cluster.
- **merge** `ai-18` `views-2` `docsurf-12b` — The server-side filter evaluator gets one owner: views-2. This supersedes the ai-18 split (which would have made ai-18 the evaluator and ai-18b the column run) because a views area now exists and D5 assigns it there. ai-18 keeps its key, sheds the evaluator, and is the column run only — blockedBy views-2, views-3, ai-8b, ai-13, ai-17; size L → M, which answers the audit's oversized finding. docsurf-12b ships a document column registry and compiles through views-2's compileConditions rather than a second evaluator.
- **fold** `docsurf-11` `storage-6a1` `storage-6b` — The hygiene pass wanted docsurf-11 deleted (migration into storage-6a, UI into storage-6b); cluster C3 keeps it and I follow C3, because the duplication it was flagged for disappears once storage-6a1 is blockedBy docsurf-11 and storage-6a2 becomes its first real writer. docsurf-11 is now the §11 provenance migration only, explicitly labelled a foundation migration; its /documents Source column, gone marker and Open-in-source action move to storage-6b, so the 'gone' treatment is decided once by the slice that first produces a gone row.
- **split** `mono-1a` `mono-1` `mono-1b` — mono-1 splits three ways along what each part can break. mono-1a: the pnpm 10 bump and lockfile regeneration alone, in front of the rename (onlyBuiltDependencies confirmed, workspace: protocol and turbo prune --docker are why it leads). mono-1: the git mv into apps/web plus the three silent landmines (dotenv cwd, four eslint globs, dataDir()), with @spaces/* scope, per-package '#/*' imports and workspace-root dataDir pinned in the spec. mono-1b: turbo.json and the cached task graph, whose failure mode is a gate that passes from cache after its inputs changed.
- **split** `mono-9a` `mono-9d` `mono-9e` — mono-9a splits into three subsystems with three silences. mono-9a keeps the vault (a regenerated secret.key makes every credential unrecoverable and invalidates every session); mono-9d moves storage (blocked on 9a, since local.ts imports dataDir and loadMasterKey); mono-9e moves both seeds and the boot composition. Plan correction forced by the split: seeds/demo.ts does NOT move — it imports resolveEntity, which does not reach core until mono-8b, so the original would have made packages/core import apps/web.
- **split** `storage-2a` `storage-2a2` — The OAuth L splits at the redirect boundary. storage-2a (hitl M) is the outbound leg: PKCE S256, the signed state, the Connect control, the fake IdP's authorize endpoint, and the one open call it records — where the code_verifier lives between the legs. storage-2a2 (afk M) is the grant row: code exchange, userinfo, the migration adding scopes/expires_at/refresh_token_expires_at/external_account_id, and the encrypted bundle under AAD connection:<userId>:<provider>. The migration stays whole inside the second part, so no second _journal.json entry.
- **split** `storage-11` `storage-11b` `storage-11c` — The change table splits one row of §8 per failure mode, chained (all three edit one dispatcher). storage-11 keeps its key for renames and moves (a crossing move is a suggestion — it keeps the ai-5 + ai-8a dependency). storage-11b is the gone pointer (provider delete or leaving the binding — same outcome, needs neither the suggestion table nor the inbox). storage-11c is resurrection: the app-side-delete tombstone and the expired-cursor re-list, which have to be tested against each other or neither is proven. NOTE: the bodies for 11b and 11c were truncated in my input; keys, seam and ordering are recorded, the prose is owed.
- **split** `docsurf-5` `docsurf-5b` — The shelf splits from its door. docsurf-5 keeps /documents on the /portfolio pattern (hand-declared columns, useTablePrefs, no ViewBar), addressable by URL from that slice. docsurf-5b is the nav row, its chord lane and the keyboard sheet — a keyboard-map judgement that was riding inside a table slice, and one that NAV_ITEMS' positional lane bounds (slice(0,4)/slice(4,7)/slice(7)) make unsafe to do casually. All four existing dependents keep pointing at docsurf-5; nothing may block on docsurf-5b.
- **split** `storage-6a` `storage-6a1` `storage-6a2` — storage-6a's key is retired: its singular claim was about a document row while its title claimed bytes. It becomes storage-6a1 (document birth, the only writer of a document row) and storage-6a2 (server intake, stream → sha → blob, the deliberately horizontal slice four slices across three areas key on). storage-6a1 is blockedBy clean-4, not clean-3 — source_class reaches the document table in clean-4.
- **drop** `mono-11b` `mono-12` — Deleted as duplicates of sdk-1 and sdk-2, which land against the flat tree before the monorepo as the plan's own depFixes already directed.
- **drop** `ai-18b` `backfill-1` — Two proposed keys are never created. ai-18b (the split's column-run half) is unnecessary once ai-18 sheds the evaluator to views-2 and keeps its own key. backfill-1 (credential.kind opens) is absorbed into a new clean-2c per D3, so the widening rides the project-2 migration lane with clean-2a instead of arriving from a backfill area much later.
- **relabel** `objects-4` — afk → hitl. Confirmed: the slice cannot be written without pinning how much accumulated history the never-yet-run sweep may surface on its first pass. Built against the default (top 3 per entity, 50 inserts per run, no announcement beyond the count); the owner confirms the two caps and the announce question before merge (D25).
- **relabel** `clean-5` — afk → hitl, on narrower grounds than the audit gave: strikethrough for a completed item is already shipped in tasks.tsx, so that is not new language. What is new is an inert checkbox glyph in a palette row where every row today is inert navigation, plus the unconfirmed 'tasks stay workspace-visible in Cmd-K' call. The backend half (task.tsv, the row_kind discriminator, lifting searchAllQuery) stays mechanical.
- **relabel** `ai-15` — afk → hitl. ai-8a's contract anticipates later kinds, but a suggestion carrying a 400-word markdown body is a card shape nothing pins — truncated, expandable or previewed — and ai-16, ai-22 and ai-24 all inherit it. The markdown→BlockNote renderer itself stays mechanical.
- **relabel** `mono-13a` — afk → hitl. It moves the Dockerfile, re-points both compose build contexts and adds an image-build CI job — the moment a name bakes into published paths. With ship-1 landing in project 1 the rename is already done, so the human call here narrows to the image name and tag scheme (D13, D15).
- **relabel** `notes-3` — hitl → afk. The chip row is an explicit mirror of a shipped control in the same header, the design judgement for the area was spent in notes-1a, and mandate cannot be offered by the picker as a matter of schema. Whichever of notes-3/notes-5 lands second owns the unfileNoteFrom guard — say so in its body rather than leaving it to discovery.
- **relabel** `objects-7` — Stays afk, against the audit — but only after the body grows a release path. Clearing or overwriting an identity-key-backed attribute now demotes the alias it created (is_identity → false) in the same transaction: the row survives so history and pg_trgm are intact, the exclusive claim is released, and a typo'd domain stops permanently blocking the correct record. objects-5's recorded decision changes from append-only to clearing-retires; if the human confirms append-only instead, objects-7 becomes hitl.
- **relabel** `objects-8` `ai-7` — Both stay afk; the audit's escalations are rejected. objects-8 declines the undecided thing (no toast action button) and copies the shipped companies_.$companyId.tsx:474 precedent — declining an open question is not answering it. ai-7 applies a decision CONTEXT.md already made and names deck upload in verbatim ('create-then-suggest through resolveEntity'); the ai-area open question restating it is stale and is struck.
- **relabel** `ai-18` `sdk-2` `objects-3` `storage-2a` `docsurf-12a` — Size and label consequences of the merges: ai-18 L → M and stays afk (the hitl judgement moved with the evaluator to views-2, which is hitl); sdk-2 S → M (migration + worker loop + route + second entry point + compose overlay); objects-3 S → M (it now owns the surface); storage-2a L → M with storage-2a2 (afk M) beside it; docsurf-12a M → S, still hitl (views-1 takes its discriminator half).
- **relabel** `sdk-3` `clean-2b` `sdk-23` — Three spec pins from the hygiene sweep so afk labels stay honest: sdk-3's acceptance must pin the settings JSON Schema subset (string, number, boolean, enum; every other type refused at manifest-validation time) — narrowing later breaks published plugins; clean-2b writes 'context: null, revisit with ai-25' into its ENTITY_REFS entry rather than letting an agent choose what leaks into prompts; sdk-23's 'clean-credential-kind' blocker now resolves to a real slice (clean-2c) instead of a decision nobody owned.
- **fold** `ai-2` `storage-4b` `sdk-4b` `mono-7` `mono-8a` `mono-8b` `mono-9b` `ai-12a` `clean-2a` — The audit's non-vertical flags are answered rather than acted on: each of these has a consumer inside its own project (ai-2 → ai-5/ai-6, storage-4b → storage-5, sdk-4b → sdk-15, ai-12a → ai-10b/ai-11, clean-2a → clean-3 plus twelve keyed slices), and a package extraction is horizontal by construction. The fix is wording: projects 15 and 17 must say in shipsWhat that those milestones ship no user-visible surface and are verified by regression. ai-2 gains an adjacency note so it lands beside its consumer rather than months ahead.
- **new-area** `ship-1` `ship-2` `ship-3` `ship-4` `ship-5` `ship-6` `ship-7` `ship-8` `ship-9` `ship-10` `ship-11` `ship-12` — The ship/hostability area lands as 12 slices, split across project 1 (rename, /data ownership, downgrade guard, TLS overlay, restore) and project 16 (Playwright harness, image smoke, published multi-arch images, install/upgrade docs, upgrade CI, PaaS templates), with ship-9 (plugin release tags) placed in the plugin-install project where sdk-21a already owns the packing scheme. This satisfies the non-negotiable that ship is not last: the rename is project 1, before any image bakes DealOS in.
- **new-area** `design-1` `design-2` `design-3` `design-4` `design-5` `design-6` `design-7` `design-8a` `design-8b` `design-9` `design-10` — The Instrument port area lands as 11 slices. design-1 (gate 5 becomes lint) and design-3 (the field-label step) ride in project 1 because mono-6 wires today's gate-5 grep into CI and that grep fails on a clean tree; the other nine become project 4, which sits ahead of every project that adds a surface — the audit's other non-negotiable. Roughly forty surfaces in projects 5–14 are now born ported instead of built on chrome the port is replacing.
- **new-area** `views-1` `views-2` `views-3` `views-4` `views-5` — A views area finally owns what three areas were each carrying a piece of: the surface discriminator (views-1), the Condition-to-SQL compiler with its property test against the client evaluator (views-2), keyset pagination with an honest count (views-3), filterable/sortable flags minting expression indexes on demand (views-4, closing CONTEXT's values-jsonb open question with shipped code), and companies/people on the same loader (views-5). It becomes project 9, with docsurf-12a and docsurf-12b moved into it.
- **new-area** `api-1` `api-2` `api-3` `api-4` `api-5` `api-6` — The external door lands as 6 slices in project 13. Per D8 api-1 is rewritten from 'oRPC spike' to 'HttpApi door — one definition, OpenAPI out' since effect/unstable/httpapi is already installed and the named fallback now ships inside the pinned package; the amendment to CONTEXT decision 3 is still owed — D8 is in §3 (awaiting your call), and CONTEXT.md:107 plus the `no-restricted-imports` message in eslint.config.js both still name oRPC. One /api/v1 namespace (D27), one personal-token store shared with MCP (ai-23a widened, not duplicated), no filter dialect and no second search.
- **new-area** `arrival-1` `arrival-2` `arrival-3` `arrival-4` `arrival-5` `arrival-6` `arrival-7` `arrival-8` `arrival-9` `arrival-10` — The arrival area lands as 10 slices split by what they need: the forwarding mailbox, participants, attachments and deck links (arrival-1..4) join project 13, since they need only clean, objects-3, the birth/intake pair and docsurf-7; the calendar syncer, the recorder ingress, its summary, feeds and Gmail (arrival-5..10) become project 23, after OAuth and the SDK kinds exist. This is the channel CONTEXT sequences first and the plan had no slice for.
- **new-area** `import-1` `import-2` `import-3` `import-4` `import-5` `import-6` `import-7` `import-8` `import-9` `import-10` — The import area lands as project 14, renamed 'import and export'. It reads CSV/XLSX into one grid, maps onto the object registry (so a custom object created that morning imports with no importer change), coerces per attribute type, previews attach-or-create before any write, commits idempotently through the existing writers, and bootstraps a portfolio as dated events rather than balances. import-10 (a dialect is a plugin) is the last milestone and is the only part gated on the SDK.
- **new-area** `backfill-2` `backfill-3` `backfill-4` `backfill-5` `backfill-6` `backfill-7` `backfill-8` `backfill-9` `backfill-10` `backfill-11` `backfill-12` `backfill-13` `backfill-14` — The backfill area is dissolved into the projects it belongs to rather than becoming a project of its own, which is its own stated intent: referred_by → project 3; orphan blob sweep → project 8; AI caps, suggestion chips and ref stability → project 10; space tags, the two sha-keyed caches and the banked register → project 12; space Contacts → project 7; the Ai port live and plugins/exa → project 23; plugin upgrade → project 19, beside sdk-21b whose version directory it needs (D47).
- **new-area** `clean-2c` `import-11` `import-12` — Three slices created by the framed decisions. clean-2c (D3) opens credential.kind to oauth_client, webhook, embedding and mailbox with the membership rule as a comment and the unique key rebuilt on (scope, provider, kind, user_id) so a Gemini key and a Google OAuth app coexist on provider 'google'. import-11 (D12) is the ledger correction policy — the append-only tables' one reversing door — landing before import-9 commits forty events at once. import-12 (D42) is export, so the data can leave.
- **dep-fix** `sdk-3` `sdk-6a` `sdk-6b` `sdk-7a` `sdk-7b` `sdk-8` `sdk-9` `sdk-10` `sdk-11` `sdk-13` `sdk-20a` `sdk-23` `sdk-24a` `sdk-25` `storage-4a` `storage-5` `storage-6b` `storage-8a` `storage-9` `storage-11` `storage-16` `storage-18` `ai-22` `ai-25` — All sixteen placeholder blocker strings now resolve to real keys: mono-workspace-scaffold → mono-1; mono-packages → mono-7; sdk-sdk-package → sdk-5; mono-test-db-harness → mono-4 + mono-5; clean-integration-table → clean-2a; clean-source-class → clean-3 (clean-4 where the column is on document/interaction); clean-job-run-table → clean-2b; clean-credential-kind → clean-2c; sdk-integration-row → clean-2a; sdk-loader → sdk-11; sdk-runjob → sdk-1; docsurf-space-filing → docsurf-1a; docsurf-document-birth → storage-6a1 (storage-6a2 for sdk-8, which arrives with a stream); ai-suggestion-inbox → ai-5 + ai-8a; storage:document-revisions → storage-10b. A publish with an unresolved placeholder creates a dangling Linear relation, so this is a hard gate.
- **dep-fix** `objects-2` `objects-1a` `objects-7` `notes-5` `docsurf-2` `docsurf-3` `ai-7` `ai-11` `mono-9b` `storage-18` `storage-16` `sdk-13` `ai-25` — Twenty of the 29 recorded dependency corrections applied unchanged: objects-2/objects-1a ← clean-1 (so the organization-ghost branch is never written); objects-7 ← clean-3; notes-5 ← clean-4 and docsurf-2 ← clean-4 (one enum rebuild each, the migration lane held once); docsurf-3 ← clean-7; ai-7 ← clean-3; ai-11 ← clean-5 + docsurf-1a (the fused CTE stays strictly serial); mono-9b ← ai-1; storage-18 ← ai-26 + ai-12a; storage-16 ← storage-12; sdk-13 and ai-25 ← clean-2b, which forces the run-vs-job_run reconciliation to be settled in clean-2b rather than discovered twice.
- **dep-fix** `mono-1` `mono-1a` `mono-1b` `mono-2` `mono-3` `mono-6` `mono-10` `mono-11a` `mono-13a` `mono-13b` `sdk-11` `sdk-3` — C1 and the mono-1/mono-9a splits: mono-1 ← mono-1a and ← sdk-1 + sdk-2 (it now carries their files across the move); mono-1b ← mono-1; mono-3 and mono-6 ← mono-1b (their acceptance is written as turbo run --filter, which no longer arrives with mono-1); mono-2 deliberately does NOT gain mono-1b so it can run alongside it; mono-9d ← mono-9a; mono-10 replaces mono-9a with mono-9d + mono-9e; mono-11a ← sdk-1 + sdk-2; mono-13a drops mono-12 and gains mono-11a; mono-13b ← mono-13a + sdk-1; sdk-11 ← sdk-2 (it adds a third writer to the health payload sdk-2 now owns); sdk-3 ← mono-10 so @spaces/sdk is born inside the fence.
- **dep-fix** `objects-4` `ai-8a` `ai-6` `ai-24` `storage-9` `storage-11` `sdk-10` `objects-7` — C2: objects-4 ← objects-3 (the sweep fills the queue and hangs its action on the queue's header); ai-8a ← objects-3, replacing the audit's weaker 'whichever lands second inherits the first's shape'; ai-6 ← ai-8a (its own demo is reading proposals in /inbox, which without a renderer exist only in SQL); ai-24 ← ai-8a; storage-9, storage-11 and sdk-10 ← ai-5 + ai-8a; objects-7 keeps its objects-3 edge, which now means the surface as a whole. Every body that says /dedupe now says /inbox.
- **dep-fix** `storage-6a1` `storage-6a2` `docsurf-10a` `docsurf-6b` `docsurf-7` `sdk-8` `docsurf-6a` — C3: storage-6a1 ← docsurf-1a + docsurf-11 + clean-4; storage-6a2 ← storage-6a1; sdk-8 ← sdk-7a + clean-3 + clean-4 + storage-6a2; docsurf-10a ← storage-6a1 + docsurf-6b (a blobless clip needs birth, not the byte lane — so the audit's blanket 'docsurf-10a ← storage-6a' was half right); docsurf-6a ← docsurf-1a + docsurf-1b; docsurf-6b's 'finalizeDocumentUpload accepts fileAgainst: null' criterion moves into storage-6a1 as the empty-array rule, leaving docsurf-6b as the picker UI.
- **dep-fix** `ai-18` `docsurf-12a` `docsurf-12b` `mono-8b` `mono-7` `views-2` — Views: ai-18 loses docsurf-12b and gains views-2 + views-3; docsurf-12a ← views-1 and loses its first two acceptance bullets (the shape decision and the discriminator backfill are views-1's); docsurf-12b ← views-2 and rewrites its 'filter evaluation stays client-side' bullet, which stops being true of object surfaces; mono-8b's recorded fix ('← docsurf-12a and ai-18') becomes '← views-1 and views-2' and its move list gains views/sql.ts; mono-7's move list gains the shared fixture file views-2 adds beside filter.ts, so core's suite and the SQL suite read one case table.
- **dep-fix** `mono-1` `mono-13a` `mono-13b` `storage-2a` `mono-6` `mono-3` — Ship: mono-1 ← ship-1, or its 'zero content-changed lines under apps/web/src' criterion becomes untrue and a dozen files rename twice; mono-13a ← ship-2 and must carry the root-start, su-exec drop and boot write-probe forward rather than restoring USER node; mono-13b's 'no tsx binary' must not become 'no su-exec binary'; storage-2a ← ship-3, because Google and Box reject non-localhost http redirect URIs so the consent dance cannot be proven without a real https origin; mono-6's CI rewire leaves room for additive jobs (e2e, image-publish, upgrade); mono-3 carries ship-4's downgrade precheck across when it moves migrate.ts.
- **dep-fix** `mono-6` `docsurf-5` `ai-8a` `ai-3a` `sdk-20a` `sdk-20b` `storage-3b` `ai-4b` `ai-25` `storage-1` `storage-17` `ai-9a` `ai-13` `sdk-21b` `notes-2` `notes-3` `docsurf-9` `ai-17` — Design: mono-6 ← design-1 or its gate-5 CI step ships permanently red (the grep hits a comment in attribute-dialog.tsx on a clean tree); docsurf-5 and ai-8a ← design-2 + design-6, so a nav row is data with a collision test instead of a hand audit; every settings surface (ai-3a, ai-4b, ai-25, sdk-20a, storage-1, storage-3b, storage-17, ai-9a, ai-13, sdk-21b) ← design-5, so 'where does this live' has one answer instead of three; sdk-20b ← design-4 for Switch and the picker; notes-2/notes-3 ← design-8a and docsurf-9 ← design-8b, so the editor is not re-skinned under freshly-landed work; ai-17 ← design-2.
- **dep-fix** `sdk-24b` `clean-2c` `storage-1` `sdk-25` `docsurf-10a` `docsurf-7` `clean-3` — Arrival: sdk-24b ← arrival-8, with feeds and per-guid dedupe moving to core feed/feed_item and plugin_rss keeping only the conditional-GET cache — otherwise the repo gets two feed_item tables and feeds are configured in a plugin settings form instead of on the space and record pages; clean-2c gains 'mailbox' alongside oauth_client and webhook; storage-1's scope vocabulary carries calendar.readonly and gmail.readonly (storage-2b's own demo already assumes the first); sdk-25's fake list gains google-calendar; docsurf-10a dispatches the clip job on a link-kind table so arrival-4 registers a renderer rather than branching inside a guarded job; clean-3's core-owned-channel decision must cover the mailbox, the snapshotter and the feed poller, not just the clip.
- **dep-fix** `ai-22` `mono-7` `sdk-4a` `objects-4` `clean-2b` `mono-9c` `storage-6a1` `storage-12` — Import: ai-22 ← import-9 and its accept() ledger branch calls the programs import-9 extracts, so the append-only tables keep exactly one writer each; mono-7's move list gains import/read.ts, coerce.ts and ledger.ts; sdk-4a's importer interface is specified against the pipeline that now exists (parse output lands in an import_batch and never writes, each unit carries a row ordinal); objects-4's flood bound must cover a 400-row import, the second way a quiet inbox floods; clean-2b's comment names import.commit as a job_run tenant; mono-9c's QUEUES gains import.commit; storage-6a1/6a2 must accept an in-memory payload with a caller-supplied name and mime (api-4 and import-2 both arrive with no stream and no content-length); storage-12's retain policy must cover derived layers and the import payload in the same sentence it covers bytes (D38).
- **dep-fix** `storage-1` `ai-3a` `ai-13` `ai-17` `docsurf-6b` `ai-9a` `ai-23a` `sdk-23` `ai-6` `mono-10` — Backfill and api body edits: storage-1 and ai-3a ← clean-2c and each drops its own credential-enum migration criterion; ai-13 ← backfill-4 and reads the shared caps helper instead of writing a second ceiling; ai-17 ← backfill-5 so the cell's pending state inherits the chip vocabulary; docsurf-6b ← backfill-3, since its 'the bytes GC' criterion is unprovable before a sweep exists; ai-9a's embed signature ships as embed(input, {sensitivity}) with only one branch reachable (D11), so the local slot is additive; ai-23a creates api_token with scopes and last_used_at from the start and its wording widens so one token opens both MCP and /api/v1; sdk-23 records that webhook ingress stays a raw route outside the versioned namespace; ai-6 states that extract takes the target registry as a parameter so api-5 is a third caller, not a fork; mono-10's zones carry api-1's one-file bridge restriction.
- **dep-fix** `views-4` `objects-5` `clean-5` `ai-11` `views-3` — Two scheduling constraints recorded that are not blockedBy edges: views-4 and objects-5 both migrate the attribute table and must not hold open migrations concurrently (_journal.json is the serialization point the migration label exists for); and views-3's paged global text box is a deliberately separate ILIKE beside the fused RRF CTE, never a fifth lane inside it, so the search track stays strictly serial and one-agent.
- **drop** `docsurf-5` `objects-8` `ai-7` `mono-1` — Four audit findings struck as answered rather than acted on: docsurf-5's oversize flag (docsurf-5b answers it), objects-8's and ai-7's hitl escalations (rejected above), and mono-1 ∩ mono-10's rule duplication (the ownership line is now written into both bodies). One audit finding is NOT answered and stays open: sdk-15 is still an undeclared L (provider client, self-throttle, bulk endpoints, claim mapping, receipts, the wired job) and nobody handed me a split for it.

**Deleted:** `mono-11b` `mono-12` `storage-6a`

**Dependency corrections dropped as already handled by the collision resolvers:**

- 'sdk-8 must be blockedBy storage-6a, not docsurf-1a' — already handled by cluster C3, which resolves it more precisely: sdk-8 blocks on storage-6a2 (it arrives with a stream and needs the intake half), not on the row-birth half.
- 'docsurf-10a must be blockedBy storage-6a' — already handled by C3, and half wrong as stated: an HTML clip keeps no bytes, so docsurf-10a blocks on storage-6a1 (birth, with blobSha null) and docsurf-6b, and deliberately never touches the byte lane.
- 'storage-9, storage-11 and sdk-10 must be blockedBy ai-5 and ai-8a' — already handled by C2's depEdits, with one refinement the fix could not know: after the storage-11 split the suggestion dependency attaches to storage-11 (a crossing move proposes) and NOT to storage-11b or storage-11c, which propose nothing.
- 'ai-8a must be blockedBy objects-3' — already handled and superseded by C2. The fix only ordered two rewrites of one page; the resolution makes objects-3 the owner of the surface and ai-8a the owner of one row kind.
- 'ai-18 must be blockedBy docsurf-12b' — superseded by the views area (D5). ai-18 now blocks on views-2 and views-3; docsurf-12b ships a column registry only and compiles through the same evaluator, which is what the original fix was reaching for.
- 'mono-8b must be blockedBy docsurf-12a and ai-18' — superseded by the views area. It becomes 'blockedBy views-1 and views-2': the surface discriminator and the compiler are what settle the view store's shape, and ai-18 no longer touches it.
- 'mono-11b and mono-12 are duplicates of sdk-1 and sdk-2 and must not both be created' — already handled by C1, which deletes both and moves the queue rename into mono-11a.
- 'mono-13b must be blockedBy sdk-1 (replacing its dep on the deleted mono-11b)' — already handled by C1, which also adds sdk-2's ROLE=worker health command to mono-13b's bundle list so removing tsx does not break the HEALTHCHECK.
- 'GAP, no slice owns credential.kind widening' — already handled by D3, which creates clean-2c in project 2's migration lane and absorbs backfill-1 into it; the widening now covers oauth_client, webhook, embedding and mailbox in one migration.

---

## 3. Decisions awaiting your call (48)

Forty-eight decisions, with nineteen merges recorded — most of the six the audit named turned out to be fewer questions than they looked. audit #3 (run vs job_run) is closed by the C4 resolver and I ratify it rather than reopen it; audit #5 is already half-decided in src/lib/context/ref.ts, so what remains is a resolver and a fence, not a grammar; audit #2 and #6 collapse into two decisions now that a views area exists to own them. On the two that were genuinely ownerless: source_ref points at integration.id always (spec-storage-sources §5.3 is the drafting error and is corrected in clean-3's PR), and credential.kind stays a closed enum widened to six values in a new clean-2c inside project 2's migration lane. Five decisions are ones nobody had surfaced: plugin schemas must not hold foreign keys to public.entity.id or merge and delete stop being implementable by core alone (D7); MCP is an egress path and currently bypasses the sensitivity flag entirely (D10); the client and server filter evaluators need a shared case table or they will drift (D6); the append-only ledger needs a reversal-by-compensating-event door before a bulk import can commit forty wrong rows (D12); and nothing in the plan lets a user get their data back out (D42). One recommendation changes a recorded decision: drop the @orpc bridge — effect/unstable/httpapi ships inside the pinned effect@4.0.0-rc.112 with HttpApi, HttpApiBuilder, OpenApi and HttpApiTest, and the internal half oRPC was bought for is already served by createServerFn. Two small riders worth carrying into the roadmap: RESERVED in src/lib/attributes/object-registry.ts is missing 'documents', 'inbox' and 'import', so a custom object can currently steal those routes; and ship-1 only looks blocking because an internal workspace specifier was being treated as a public npm identifier — nothing in projects 1 through 10 publishes anything.

### D1-source-ref-referent

**When a row says "an integration wrote this", does `source_ref` point at the installed integration row or at the OAuth account connection it borrows credentials from?**

`spec-plugin-sdk.md` §8 declares `source_ref uuid → integration.id (null unless class = integration)`; `spec-storage-sources.md` §5.3 writes `source_ref: binding.connection_id` in the resolveItem pseudocode. Both are shipping specs and clean-3 adds the columns. The repo already has `account_connection` (per-user OAuth grant, src/db/schema/vault.ts) and storage-6b/docsurf-11 separately add `document.connection_id → account_connection`, so under the storage reading one column would carry two FK targets and could carry no FK at all.

- **source_ref → integration.id, always, with a real FK; null unless source_class = 'integration'** — One enforceable FK; the record timeline's "which integration wrote this" agrees with `attribute_event.actor_ref` (clean-2a) because both point at the same row; two integrations sharing one Google grant (Drive + Calendar) stay distinguishable. "Which account's bytes" is answered one hop away by `document.connection_id` / `storage_binding.connection_id` / `integration.connection_id`. _Reversal cost:_ High once plugins write: a backfill over every provenance-stamped entity, alias, interaction and document row plus an edit to every port write path in sdk-7a/7b/8/9.
- **source_ref → account_connection.id (the storage spec's reading)** — The column cannot FK anything for non-OAuth integrations (Apollo has a credential, no connection), so it becomes an un-FK'd uuid; provenance answers "whose Google account" instead of "what wrote this", which is the question the timeline actually asks; document.connection_id becomes a duplicate of source_ref. _Reversal cost:_ Same backfill in the other direction, plus re-deriving an integration id for rows that only recorded a connection — recoverable only where exactly one integration used that connection.
- **A polymorphic pair (ref_type, ref_id)** — Both questions answerable, no FK ever, and `entity-refs.test.ts`'s FK-metadata diff can never see it. Attio's polymorphic actor is the thing spec-attribute-engine §4 explicitly declined. _Reversal cost:_ Permanent: two consumers will branch on ref_type within a release and collapsing it later means rewriting both.

**Recommendation:** Option 1. `source_ref` always references `integration.id`, FK enforced, null unless class = 'integration'. Correct `spec-storage-sources.md` §5.3 in clean-3's PR, citing spec-plugin-sdk §8, and make the storage binding's connection reachable through `integration.connection_id` and the document's own `connection_id` column.  
The enum collapse exists to answer "what wrote this value" with one branch in resolve.ts; the integration row is the only thing that is always present for class='integration' and is already the typed-actor target, so the two provenance systems stay in agreement by construction. This is the same failure that produced this whole pass — two specs describing one column — and the cheap fix is to make one of them wrong in writing.

_Carried by_ `clean-3`. _Blocks_ `clean-4`, `docsurf-11`, `storage-6b`, `storage-8b`, `storage-9`, `sdk-7a`, `sdk-7b`, `sdk-8`, `sdk-9`, `sdk-10`, `ai-7`, `objects-7`.

### D2-view-surface-discriminator

**How does a saved view address a surface like /documents that has no object row and no `entity.values` — by minting a system object row, or by a discriminator on the view table?**

`view.object_id` is `notNull` with an FK to `object` (src/db/schema/views.ts). `entity.object_id` is deliberately null for research kinds (space/note/document/term), and `attribute.object_id` is notNull — so an object row implies an attribute registry. docsurf-12a, docsurf-12b, ai-18 and mono-8b all inherit whatever is decided, and the new views area has already drafted views-1 with `object` and `document` surface values. Separately, `RESERVED` in src/lib/attributes/object-registry.ts does not contain 'documents' or 'inbox', so a user can mint a custom object that steals either route.

- **A `surface` discriminator column on view (`object | document`), `object_id` made nullable, with a check constraint `(surface = 'object') = (object_id is not null)`** — Documents keep no attribute registry and no values jsonb; the view store gains one branch; the condition registry per surface is a code-side map, not a database row. Rule for a third value, written once: a surface may carry views when it is a list of rows with a stable id and a declared column registry — tasks qualify but ship no ViewBar until asked; `extra` stays legal on any surface. _Reversal cost:_ Low-moderate: converting to object rows later is a seed plus an update over view rows.
- **Seed a system object row per non-entity surface** — `/o/documents` starts routing to a record page that does not exist; the attribute registry gains rows for something with no entity.values; dedupe, merge and identity-key machinery must each special-case it; "no fourth system object" stops being true. _Reversal cost:_ High: un-seeding an object row after `entity.object_id` invariants and attribute rows have referenced it is a data migration with no clean rollback.
- **A second table (document_view)** — Two stores, two ViewBars, two save paths; mono-8b moves both into packages/core and every later surface adds a third. _Reversal cost:_ Moderate but paid twice — once to build, once to merge.

**Recommendation:** Option 1, and with it: docsurf-5 ships the /portfolio prefs pattern only (no ViewBar), and docsurf-12a explicitly migrates that page's `useTablePrefs` state into a default view row and deletes the prefs path for that page — named in its acceptance criteria so the chrome reconciliation is a task, not an inheritance. Add 'documents' and 'inbox' to `RESERVED` in the same slice.  
An object row is the carrier of the attribute registry, not a generic "thing with a list page"; minting one for documents buys a nullable FK's worth of convenience and breaks the two-tier model's central claim. The discriminator keeps the view store one table and one save path, which is what mono-8b needs to move it once rather than twice.

_Carried by_ `views-1`. _Blocks_ `views-2`, `views-3`, `docsurf-12a`, `docsurf-12b`, `ai-18`, `mono-8b`, `docsurf-5`.

### D3-credential-kind

**Does `credential.kind` stay a closed enum and widen to cover OAuth apps, webhook secrets and embedding providers, or does it become open text like `provider`?**

`credentialKind` is a pgEnum of llm|enrichment|search (src/db/schema/vault.ts). storage-1 needs `oauth_client` for the provider registry, sdk-23 needs `webhook` for ingress secrets, spec-ai-substrate §9 needs `embedding`. Manifest `requires.credential.kind` is typed against the enum, and the plugin doctrine forbids a plugin needing a shared core enum edited. The plan's own dep list marks this a GAP with no slice, and backfill-1 recommends keeping the enum without authority to decide.

- **Keep the closed enum; widen to `llm | embedding | enrichment | search | oauth_client | webhook` and write the membership rule: a value is added when the HOST gains new machinery for a secret, never when a vendor arrives — vendors are `provider` text** — Settings can group credentials, `aiRoute` can trust `kind`, manifests stay typed. A plugin that genuinely needs a seventh kind is a core change — correct, because the host must know what it is being asked to hold and decrypt. _Reversal cost:_ Low: enum → text is a one-line migration; the rows survive.
- **Open text like `provider`** — Any plugin invents a kind; nothing validates; the settings sections and the AI lane router both have to pattern-match strings. Satisfies "a plugin never edits a shared enum" at the cost of the enum meaning anything. _Reversal cost:_ High: text → enum later means reconciling whatever strings shipped, across installed plugin manifests in the field.
- **Collapse enrichment|search into one `integration` value, giving five (llm, embedding, oauth_client, webhook, integration)** — Truest to what the host actually does with each secret, and a plugin never needs a new one. Contradicts CONTEXT's recorded three values and spec-plugin-sdk §12's names. _Reversal cost:_ Low today (there are no enrichment/search rows yet), rising the moment Apollo ships.

**Recommendation:** Option 1, landed as a new `clean-2c` in project 2 so it rides the migration lane with clean-2a rather than arriving from the backfill area later. backfill-1 is absorbed into it. Write the membership rule as a comment above the enum.  
Every value names host machinery — a lane that routes, a consent dance, an ingress verifier — not a vendor, so the enum is closed for a real reason and saying so out loud is what stops the next plugin author asking for `kind: 'apollo'`. Option 3 is more honest but re-opens two specs for a refactor nothing is currently paying for.

_Carried by_ `clean-2c (new, project 2)`. _Blocks_ `storage-1`, `storage-2a`, `storage-3b`, `sdk-23`, `sdk-20b`, `sdk-4a`, `ai-9a`, `ai-3b`.

### D4-citation-ref-grammar

**Is the shipped ref grammar the one and only citation format, who resolves a ref into a destination through `merged_into_id`, and what is a chunk of something that is not a document called?**

The grammar already exists and already decides the two things the audit flagged: `src/lib/context/ref.ts` pins `doc:<entityId>#<idx>` ("chunk index, not chunk uuid, so a re-chunk keeps citations") and records "entity ids inside refs may be merged losers; resolvers follow merged_into_id at read time (decided 2026-09-09)". What does not exist: any resolver, any enforcement that it is the only formatter, and any ref form for a note chunk — which ai-12a creates the moment `document_chunk` generalizes to a `chunk` table keyed by `entity_id`. `attribute_event.refs` is already a shipped jsonb column, so refs are persisted strings.

- **Freeze ref.ts as the one grammar (grep gate in the shape of CLAUDE.md gate 5), add `src/lib/context/cite.ts` with `resolveRefs(refs) → {ref, label, href, missing}[]` following merged_into_id and returning a tombstone for a deleted target, and generalize the index suffix: any chunk ref is `<kind>:<entityId>#<idx>`, so a note chunk is `note:<id>#<idx>` while `note:<id>` stays the whole note** — One parser, one resolver, one place a merge or a re-chunk is handled. parseRef's '#' branch generalizes from doc-only to all entity-keyed kinds. _Reversal cost:_ Low now; high after ai-5 and ai-6 persist refs — a grammar change becomes a data migration over stored strings in attribute_event.refs and suggestion.refs.
- **Add a `chunk:<uuid>` form for generalized chunks** — Citations break on every re-chunk, which is exactly what ai-13's corpus backfill does to the whole corpus. _Reversal cost:_ Very high: refs already written point at rows that no longer exist.
- **Let each consumer resolve refs itself** — Three resolvers (inbox card, record timeline, MCP), three merge behaviours, and the one in the timeline is the one that gets it right. _Reversal cost:_ Moderate but the bug it produces — a citation that silently points at a merged loser — is invisible until someone checks.

**Recommendation:** Option 1, carried by ai-5 because the suggestion table is the second persisted writer of refs and the first one a user reads. ai-12a applies the chunk-ref generalization in the same PR that generalizes the chunk table.  
The expensive half was already decided in code a week ago; what is missing is a resolver and a fence, and both are cheap while there is exactly one writer. Persisted refs are the reason to do it before ai-5 rather than at ai-25.

_Carried by_ `ai-5`. _Blocks_ `ai-6`, `ai-8a`, `ai-12a`, `ai-11`, `ai-13`, `ai-15`, `ai-16`, `ai-22`, `ai-23a`, `ai-23b`, `ai-25a`.

### D5-filter-evaluator-owner

**Who owns the one server-side view-filter evaluator, now that an area for views exists?**

Every object list is fetched whole and filtered client-side today (`src/lib/views/filter.ts` — "tables are not paginated"). The audit flags ai-18 as carrying the evaluator as a rider inside an already-L slice, and docsurf-12b as building a second, document-shaped condition registry; the dep correction "ai-18 must be blockedBy docsurf-12b" only orders two independent inventions. The views area now exists and views-2 is drafted around exactly this.

- **views-2 owns a single condition→SQL builder (e.g. `src/lib/views/where.ts`), pure and table-driven; docsurf-12b becomes a registry of document columns feeding it; ai-18 becomes a consumer** — One filter semantics for objects, documents, the column run and later MCP search. ai-18 loses its riders and drops from L toward M. The dep correction is superseded: ai-18 is blockedBy views-2, not docsurf-12b. _Reversal cost:_ Low while there is one caller.
- **ai-18 keeps it as a rider** — An agent building a column-run UX invents the filter semantics the whole repo then lives with, inside a diff nobody is reading for that. _Reversal cost:_ High: two surfaces adopt it before anyone notices it is the contract.
- **Two evaluators, one per surface** — Predictable parity bugs — `contains` on a document filename behaving unlike `contains` on a text attribute — and two SQL dialects to index for. _Reversal cost:_ Moderate and paid under pressure, once a user reports the inconsistency.

**Recommendation:** Option 1. views-2 owns the evaluator and its expression-index minting; docsurf-12b ships a column registry only; ai-18 is re-blocked on views-2 and sheds the evaluator from its scope.  
The evaluator is a foundation three consumers key on, which is the one case the slice contract allows a horizontal slice — and it is the only way ai-18 gets back inside a reviewable diff.

_Carried by_ `views-2`. _Blocks_ `ai-18`, `docsurf-12b`, `views-3`, `mono-8b`.

### D6-client-and-server-evaluators

**When filtering moves into SQL, does the pure client-side matcher survive, and if it does, how are the two kept from disagreeing?**

`src/lib/views/filter.ts` exports `matchesCondition` / `matchesConditions` with a shipped test, and mono-7 moves it into packages/core as part of the "pure half" the project-1 milestone advertises ("the due-date parser and view filters run green with Postgres stopped"). views-2 replaces its role in the list query. Nobody has said whether it is deleted, and the answer decides whether a cell edit can remove a row from a filtered view without a refetch. The audit did not surface this.

- **Keep both, and pin one shared fixture table of (values, condition, type, expected) that both the pure matcher's test and the SQL builder's test import** — Optimistic in-page filtering survives (edit a cell, the row leaves the view immediately); parity is enforced by a file, not by discipline. Cost: one fixture, and every new op is added in two places with the test failing until both exist. _Reversal cost:_ Low.
- **Delete the client matcher; refetch on every edit** — One implementation, no parity risk, and a visible refetch flicker on the two surfaces the owner uses most. mono-7's pure half loses one of its three advertised members. _Reversal cost:_ Low to restore, but the code and its test are gone and get rewritten from the SQL.
- **Keep both with no shared fixture** — They drift on the first ambiguous op (`is` against a multi-select, `gt` on a date string), and the bug presents as a row that will not disappear. _Reversal cost:_ Moderate; the drift is found by a user, not by CI.

**Recommendation:** Option 1. views-2 ships the shared case table and both tests read it.  
The pure matcher is doing real work that SQL cannot do cheaply — reconciling a just-edited row against a view without a round trip — and the only thing that makes two implementations safe is making them share their definition of correct.

_Carried by_ `views-2`. _Blocks_ `ai-18`, `views-3`, `mono-7`.

### D7-entity-refs-and-plugin-fks

**What merge strategy and context role do this plan's roughly ten new entity-referencing columns get, and may a plugin's own schema hold a foreign key to `public.entity.id` at all?**

CLAUDE.md calls a missing ENTITY_REFS entry the worst bug of a review cycle; `entity-refs.test.ts` diffs the 25-entry list against drizzle's FK metadata and fails by name. This plan adds at least suggestion.entity_id, the generalized chunk.entity_id (ai-12a), job_run.entity_id (clean-2b), storage_binding.target_entity_id, document_revision.document_id, interaction.note_id (notes-5), import_row.entity_id and ai_run.caller_id. Separately, spec-plugin-sdk §8 explicitly permits `plugin_<id>.*` to FK `public.entity.id` — and the diff test only sees the core drizzle instance, so those FKs are invisible to it, unrepointed by the merge executor, and will raise an FK violation from a schema clean-7's delete executor does not know exists. The audit missed this entirely.

- **Every new column gets its ENTITY_REFS entry in the same PR as the column with `context` filled in as a deliberate null where it is never AI-visible; and plugin schemas may NOT FK public.entity.id — they store the uuid as a plain column and resolve through merged_into_id at read, exactly as citation refs do (D4)** — Merge and delete stay implementable by core alone with no knowledge of installed plugin DDL. Plugin rows survive a merge pointing at a loser and resolve correctly; a deleted entity leaves a plugin row whose resolve returns a tombstone. _Reversal cost:_ Low now (no plugin schema exists). High later: dropping FKs across installed plugin schemas is a migration core does not own.
- **Keep §8's FK allowance and teach the merge executor and clean-7 to enumerate plugin schemas** — Core gains a dependency on plugin DDL — the exact direction §8 forbids — and every merge does a catalogue scan. _Reversal cost:_ High: the executor's contract widens permanently and each new plugin can break a merge.
- **Forbid plugin references to entities entirely** — plugins/rss and Apollo lose the ability to record which record an item was about, which is their point. _Reversal cost:_ Moderate.

**Recommendation:** Option 1, carried by sdk-24a (which defines what a plugin schema may do) with the per-column entries landing in each column's own slice. Correct spec-plugin-sdk §8's FK sentence in sdk-24a's PR.  
The merge executor and the delete executor are the two consumers CLAUDE.md built the registry for, and both are core-only by design; a cross-schema FK quietly makes them plugin-aware. Deciding it now costs a spec sentence, deciding it after the first PluginDb tenant ships costs a migration in someone else's schema.

_Carried by_ `sdk-24a`. _Blocks_ `sdk-24b`, `sdk-9`, `clean-7`, `clean-2b`, `ai-12a`, `storage-8a`, `notes-5`, `ai-5`.

### D8-api-substrate

**Does the external API ride the `@orpc/experimental-effect` bridge, or on `effect/unstable/httpapi`, which is already installed?**

`@orpc/*` appears nowhere in package.json; the bridge was chosen 2026-09-04 against Effect v3's service APIs and is @beta, while the repo now runs `effect@4.0.0-rc.112`. I verified that the installed effect ships `effect/unstable/httpapi` with HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity, HttpApiScalar, OpenApi and HttpApiTest, plus `effect/unstable/rpc` beside it. oRPC's internal half — typed TanStack Query hooks — is already served by `createServerFn` across twenty modules in src/lib/server, so nothing internal is waiting on it. This is the concrete form of the risk CONTEXT recorded as "the Effect bridge is @beta", and nothing else in the api area can be specified until it is answered.

- **Build the external door on effect/unstable/httpapi; keep server-fns for internal calls; amend CONTEXT decision 3** — Zero new dependencies, version-matched to the Effect the repo already pins, OpenAPI and a Scalar page generated from the same definition, HttpApiTest for the tests. "One procedure serves both audiences" becomes "one HttpApi definition serves every external audience; internal calls stay server-fns" — which is what the repo already does. Settles the Zod-vs-Schema question with it: Effect Schema at the HttpApi boundary (it generates the OpenAPI), Zod stays at the server-fn boundary and in valueValidator, and the two never meet in one file. _Reversal cost:_ Moderate but bounded: handlers are Effect programs either way, so moving to oRPC later rewrites the definition shell, not the logic — provided handlers are written as bare programs the shell calls.
- **Spike @orpc/experimental-effect against the v4 rc first** — If it passes, one vocabulary for internal and external; if it fails, the whole external surface (capture, webhooks, MCP, n8n) waits on a @beta package's v4 support. Adds a dependency whose Effect-version coupling is the thing that already broke once. _Reversal cost:_ The spike is cheap; adopting it and reversing is not.
- **Pin an older Effect in the web process** — Two Effect versions in one repo, against the Effect ratchet CONTEXT records as the backend contract. _Reversal cost:_ High and compounding.

**Recommendation:** Option 1. Rewrite api-1 from "oRPC spike" to "HttpApi door — one definition, OpenAPI out", and record the amendment in CONTEXT with the reason (the named fallback now ships inside the pinned package).  
The bridge's entire advantage was one vocabulary across both audiences, and the internal audience already has a good answer that nobody is proposing to replace — so the bridge is being paid for with a beta dependency and a version-coupling risk in exchange for consistency the repo does not need.

_Carried by_ `api-1`. _Blocks_ `every other api slice`, `sdk-23`, `ai-23a`, `ai-23b`, `ai-24`, `the /api/capture slice`.

### D9-provenance-cardinality

**When the same bytes or the same email arrive twice through different channels, does the row keep one provenance, or does provenance become its own append-only table?**

Two areas hit the identical shape independently. Documents dedupe on sha, so a deck hand-uploaded and later mirrored from Drive reuses the row and keeps saying a person uploaded it — "Open in Drive" never appears on a file that genuinely is in Drive (C3's escalation). Interactions dedupe on a globally unique `message_id` (uniqueIndex in src/db/schema/interactions.ts), so the second mailbox to see a thread is a silent no-op that loses which mailbox saw it (arrival's escalation). Arrival is history, and the house rule says append-only where history is information.

- **First-writer-wins, plus fill-in-the-nulls: a dedupe fills any provenance field that is currently null (external_id, external_url, connection_id, source_path) and never overwrites a non-null one; class, ref and uploader are first-writer-wins** — Cheapest; one row tells one story; "Open in Drive" does appear on the human's row once Drive arrives. Cannot say a deck is mirrored in two places, or that a thread was seen in two mailboxes. _Reversal cost:_ High without a hedge: every arrival caller writes provenance inline, so introducing a table later edits four paths.
- **Ship `document_source` and `interaction_channel` now — append-only rows, one per arrival, with the parent row keeping a `primary_source_id` for the one-line UI** — Correct and symmetrical; a Source column must then choose what to show; two migrations, two ENTITY_REFS entries, and neither table has a second writer until storage-8b and the second mailbox exist. _Reversal cost:_ Low to keep, but it is a horizontal layer with no consumer in projects 5–9, which the slice contract forbids.
- **Option 1 now, with one hedge: every provenance write goes through a single `stampProvenance(rowId, provenance)` function, so the later table has exactly one call site** — Same behaviour and cost as option 1 today; the later table becomes a ~100-line slice plus a backfill that copies each row's current stamp into its first source row. _Reversal cost:_ Low by construction — that is the point of the hedge.

**Recommendation:** Option 3, in both places: storage-6a1 owns `stampProvenance` for documents, arrival-1 owns the same shape for interactions. Record `document_source` / `interaction_channel` as the pre-agreed end state so the slice that needs it does not re-litigate.  
The side table is almost certainly the end state — two mailboxes and a mirrored data room are both planned, not hypothetical — but it cannot be demonstrated by anything shipping before project 14, and a table nobody writes twice is exactly the horizontal layer this pass exists to delete. The hedge buys the reversal for one function.

_Carried by_ `storage-6a1 (documents) · arrival-1 (interactions)`. _Blocks_ `storage-6b`, `storage-8b`, `storage-10b`, `storage-11`, `docsurf-10a`, `sdk-8`, `arrival-2`, `arrival-10`.

### D10-mcp-and-sensitivity

**Does the MCP read surface refuse a sensitive record the way `complete()` does, or does a flagged deal flow to a cloud assistant untouched?**

The sensitivity cluster settled that the flag is an egress guard enforced at `complete()`, `embed()` and vision resolve, with `canRead` remaining the only access control. ai-23a's model is "a teammate's assistant sees what that teammate sees" — an access statement. But MCP is an egress path: a remote model reads raw memo and deck text through the assembler tool. As currently specified, the flag that stops a sensitive deal reaching a cloud model stops nothing the moment MCP ships. Neither the audit nor any resolver names this.

- **`sensitivityFor()` is evaluated in every MCP read tool exactly as in complete(); a sensitive subject returns its existence (name, kind, link) plus a typed refusal, and content is withheld. A per-token `allow_sensitive` switch lets an operator pointing MCP at a local model (Ollama, LM Studio) opt in** — The flag means one thing at all three boundaries. An assistant can still say "there is a deal called X you have flagged" and link to it, which is the useful minimum. _Reversal cost:_ Loosening later is a setting. Tightening later breaks an assistant workflow someone already built against full access.
- **MCP sees everything canRead sees** — Simplest and matches ai-23a as drafted; the sensitivity flag becomes decorative for the one channel most likely to be pointed at a third-party model. _Reversal cost:_ High and user-visible.
- **Hide sensitive rows entirely from MCP** — The assistant answers "no such deal" about a deal that exists, which the box's own dedupe doctrine argues against everywhere else. _Reversal cost:_ Low, but it trains the user to distrust the tool.

**Recommendation:** Option 1, carried by ai-23a. It makes the guard list three boundaries rather than two, which should be written into `src/lib/ai/sensitivity.ts`'s header comment alongside the two the cluster already named.  
Sensitivity is defined as "bytes leaving the box", and MCP is the most literal case of that in the whole plan; leaving it out is not a scoping choice, it is the flag quietly not working.

_Carried by_ `ai-23a`. _Blocks_ `ai-23b`, `ai-24`, `ai-26`.

### D11-sensitive-embeddings

**Do records flagged sensitive simply get no vectors in v1, so semantic search cannot reach them?**

With one pinned embedding dimension (768) and one configured provider, `embed()` refuses on a sensitive subject when the lane routes to a cloud provider — so a flagged deal's chunks land with null embeddings. The roadmap audit already flags "the sensitive embedding slot" (a second, local provider at the same dimension) as having no slice. This is the one consequence of the whole sensitivity design a user actually feels.

- **Accept the hole for v1: refuse rather than fall back, and have ai-9a's Embeddings section carry one line saying sensitive records are not embedded until a local slot is configured** — Flagged records stay reachable by lexical, trigram and graph lanes through the same RRF fusion — the honest statement is "semantic recall is worse on flagged records", not "flagged records are invisible". ai-13's backfill must skip them rather than fail on them. _Reversal cost:_ One slice: a second credential at the pinned dimension plus `aiRoute('embed', 'sensitive')`. No schema change, because the dimension was pinned for exactly this.
- **Fund the local slot now (ai-9b's transformers.js model as the sensitive lane)** — No hole; costs a download-at-click-time flow and a second provider in the routing grid before anyone has flagged anything. _Reversal cost:_ Low, but it front-loads work on a feature with no demand signal.
- **Fall back to the cloud provider with a warning** — The one thing the flag exists to prevent, performed on the user's behalf. _Reversal cost:_ Unrecoverable — the bytes have left.

**Recommendation:** Option 1, and pin the signature now: `embed(input, { sensitivity })` and `aiRoute('embed', sensitivity)` ship in ai-9a even though only one branch is reachable, so the local slot is additive rather than a signature change across every caller.  
Refusing loudly is the correct behaviour under the doctrine, and the pinned dimension already bought the cheap reversal; what would make this expensive is shipping `embed()` without sensitivity in its signature and discovering it at ai-9b.

_Carried by_ `ai-9a`. _Blocks_ `ai-11`, `ai-12b`, `ai-13`, `ai-26`, `storage-18`.

### D12-ledger-correction-policy

**How does anyone fix a wrong investment, mark or distribution, given the portfolio event tables are append-only with no edit or delete path — and an import can commit forty at once?**

CLAUDE.md names the correction policy an open decision and says not to add mutation paths casually. import-9 adds no mutation path, so a wrong imported position is permanent. ai-22 separately proposes ledger events from live-file revisions — an accepted proposal writes into the same doorless tables. This is the one place bulk writing meets append-only and it lands before an angel imports a real portfolio.

- **Reversal by compensating event: add a nullable self-referencing `reverses_id` to each event table and a void flow that appends an exact-negative event citing the original; a batch reversal appends N events under one import_batch reference** — Portfolio math sums as before; the timeline shows both rows; the audit trail survives; a wrong import is a two-click fix. Roughly a 200-line slice. _Reversal cost:_ Low and additive — any future policy can be layered on top.
- **No correction path in v1 (import-9's current state)** — A bad 40-row import is permanent for the life of the workspace; the realistic user fix is to start a new workspace, which is the worst possible answer for the onboarding-critical feature. _Reversal cost:_ Low to add later, but the damaged data is already there and the compensating events have to be hand-written.
- **Allow edit/delete on the ledger tables** — Burns the append-only doctrine for a rare case, and silently invalidates every downstream mark and metric that read the old value. _Reversal cost:_ Very high: once the mutation paths exist, everything that could have used them did.

**Recommendation:** Option 1, as its own slice in the portfolio/import area landing before import-9's commit step. ai-22's accepted proposals write through the same door.  
Reversal-by-append is the only correction that keeps history information rather than overwriting it, and bulk import is what turns "a rare wrong row" into "forty rows and no way back". It is also the smallest of the three answers, which is unusual and worth taking.

_Carried by_ `portfolio-correction (new slice, import area)`. _Blocks_ `import-9`, `ai-22`.

### D13-published-identity

**What name do the published packages, images and domain carry, given `@spaces` on npm is probably taken?**

mono-1 and mono-2 bake `@spaces/*` into every package.json and mono-13a bakes the image name; ship-1 is hitl entirely because of this and it blocks the first slice of the monorepo area. CONTEXT says the rename must land before GHCR images bake the old name in. The repo's package name is still `dealos`.

- **Keep `@spaces/*` as private workspace names and publish nothing to npm in v1 — the packages are `"private": true` and the scope question moves to sdk-3/sdk-21a, where `@spaces/sdk` is the only package that would ever be published** — mono-1 unblocks today with no name research. GHCR's namespace is not a separate choice — it is the GitHub owner, already decided by where the repo lives. A scope rename at publish time is one find-and-replace in a repo with no external consumers. _Reversal cost:_ Low: one sweep, paid once, at the moment there is a reason to pay it.
- **Pick a fallback public scope now (@spacesapp or a vendor scope) and bake it everywhere** — Same sweep, paid now, for a publish event that is in project 11 at the earliest — and risks being paid twice if the name research changes the answer later. _Reversal cost:_ Low but wasteful.
- **Unscoped package names** — Almost certainly unavailable, and gives up the namespace grouping that makes the import zones legible. _Reversal cost:_ Moderate.

**Recommendation:** Option 1. ship-1 records that the workspace names are internal and unpublished, and the public-name decision is explicitly deferred to the slice that first runs `npm publish`.  
The decision is blocking mono-1 only because it was framed as a publishing decision; nothing in projects 1–10 publishes anything, so the honest answer is to stop treating an internal specifier as a public identifier and let mono-1 go.

_Carried by_ `ship-1`. _Blocks_ `mono-1`, `mono-2`, `mono-13a`.

### D14-rename-depth

**How deep into the running box does the DealOS → Spaces rename cut — the Postgres role and database, the compose project, the `dealos.*` localStorage keys?**

docker-compose.yml hardcodes role, password default and database as `dealos` and the volume as `dealos_pgdata`; the compose project name is `dealos`; saved table-column layouts live under `dealos.*` localStorage keys; mono-4 will name a test database. ship-1 pins "rename now, document the two-line ALTER" on the grounds there is one deployment and it never gets cheaper.

- **Rename the infrastructure (compose project, image, role, database, test database) and parameterise them in compose so an existing operator can keep old names; freeze the `dealos.*` localStorage keys with a comment explaining the name** — One documented ALTER for the one existing deployment; no user loses a saved column layout; the only cost is a prefs key nobody sees whose comment explains itself. _Reversal cost:_ Low: a later read-old/write-new shim can migrate the keys inside any slice that already touches useTablePrefs.
- **Rename everything including the prefs keys, with a one-time migration shim** — Fully consistent; the shim is small but it is client-side state with no server truth, so a bug resets someone's layout silently and irreversibly. _Reversal cost:_ A reset layout cannot be recovered.
- **Rename nothing internal; change the docs only** — Published images and the product name diverge from the database the operator sees, permanently, for one deployment's worth of convenience. _Reversal cost:_ Rises with every new deployment.

**Recommendation:** Option 1.  
The infrastructure names are seen by an operator reading a compose file and are worth getting right while there is exactly one of them; the prefs keys are seen by nobody and their only observable behaviour is losing someone's work if the shim misfires. Asymmetric risk, asymmetric answer.

_Carried by_ `ship-1`. _Blocks_ `ship-2`, `ship-10`, `mono-4`, `mono-13a`.

### D15-tags-registries-and-the-upgrade-window

**Does `latest` move, do we publish to Docker Hub as well as GHCR, and how far back does upgrade CI test?**

CONTEXT says multi-arch GHCR + Docker Hub, non-root UID 1000, and docs that tell people to pin tags — publishing a `latest` we then tell people not to use. It also says CI must test "the upgrade path from every prior release", which is unbounded. Three questions, one release pipeline, and they are cheaper answered together.

- **Publish `latest` plus `x`, `x.y` and `x.y.z`; docs pin `x.y.z`; GHCR only for v1; upgrade CI covers every tag in the current major plus the last tag of the previous major** — `docker pull <name>` works for someone evaluating the product in thirty seconds — the adoption moment CONTEXT calls the biggest win. One registry, one credential to rotate, no anonymous pull limits to explain. The upgrade window is affordable and still covers the realistic case (someone upgrading from a six-month-old tag). _Reversal cost:_ Adding Docker Hub later is a CI job. Widening the window later is a matrix entry.
- **No `latest`** — Consistent with pin discipline; surprises everyone who types the obvious command, and the first thing they see is an error. _Reversal cost:_ Low to add later.
- **`latest` plus both registries plus every tag ever in upgrade CI** — Two namespaces to defend, two credentials, and an upgrade matrix that grows without bound and eventually gets disabled — at which point it tests nothing. _Reversal cost:_ Removing a `latest` people already pull, or a registry they already depend on, is a breaking change you cannot take back.

**Recommendation:** Option 1, and correct CONTEXT in ship-11's PR: "every prior release" becomes the stated window, with the reason.  
`latest` is a trap only when the upgrade path is unsafe, and contract 5 plus ship-11 exist precisely to make it safe; refusing to publish it trades a real adoption cost for a hypothetical one. The asymmetry runs the other way for Docker Hub — adding is cheap, removing is not — so ship one registry and wait to be asked.

_Carried by_ `ship-8 (tags, registries) · ship-11 (window)`. _Blocks_ `ship-10`, `mono-13a`.

### D16-signing-scheme

**Do images and plugin tarballs share one signing scheme, or two deliberately different ones?**

ship's open questions ask for cosign + SLSA or nothing on images; sdk-21a is separately choosing between minisign/raw ed25519 and sigstore for plugin tarballs. Neither can be retrofitted gracefully once artifacts circulate. sdk-22 exists specifically for air-gapped installs, which constrains the plugin half.

- **Two schemes, deliberately: cosign keyless (GitHub Actions OIDC identity) plus SLSA provenance for images; a detached ed25519/minisign signature over the plugin tarball verified by the loader** — Images are verified by a human with a tool they already have and a transparency log they can check. Plugins are verified by the box itself, offline, with no sigstore client and no network egress in the install path — which is the only thing that works for an air-gapped install. _Reversal cost:_ Low to add a second scheme later on either side; the already-circulating unsigned artifacts stay unsigned either way.
- **Sigstore for both** — One vocabulary; drags a sigstore client and network access into the plugin install path of a self-hosted, sometimes-air-gapped product. _Reversal cost:_ High: sdk-22's whole premise breaks and the installer is rewritten.
- **Nothing** — Cannot be retrofitted for artifacts already in circulation; the registry sdk-21a signs against has nothing to check. _Reversal cost:_ Permanent for everything already published.

**Recommendation:** Option 1, recorded in CONTEXT with the reason stated as the verifier's identity: the image verifier is a human with cosign, the plugin verifier is our own loader with no network.  
"One answer for both" is appealing until you notice the two verifiers have nothing in common — one is interactive and online, one is a Node process that may have no internet at all. Matching the scheme to the verifier is the whole decision.

_Carried by_ `ship-8 (images) · sdk-21a (tarballs)`. _Blocks_ `sdk-21b`, `sdk-22`.

### D17-supported-container-runtimes

**Is a non-root container start an officially supported, tested deployment target, and does that include OpenShift's arbitrary-UID model?**

Hostability contract 1 says the entrypoint starts as root, repairs /data ownership and drops to UID 1000 via su-exec. Today's docker/entrypoint.sh does none of it. ship-2 additionally handles `user: "1000:1000"`, rootless Podman and userns-remap by skipping the repair when /data is already writable. Whether OpenShift's arbitrary UID is a target is unstated, and it is the difference between a tested path and a best-effort branch.

- **Support and test two starts — root-then-drop (the documented path) and `user: "1000:1000"` — in CI; declare arbitrary-UID unsupported but not broken: the entrypoint must skip the repair and run rather than fail** — Two CI legs covering every deployment an angel fund or a small team actually uses; OpenShift users get something that boots and a documented caveat rather than a promise. _Reversal cost:_ Low: promoting arbitrary UID to supported later is a CI leg plus group-writable /data and fsGroup docs.
- **Fully support arbitrary UID** — A third CI leg and a permanent constraint on every future file the app writes under /data, for a deployment target nobody has asked for. _Reversal cost:_ High: demoting a documented target is a broken promise.
- **Root-only** — Contradicts the published non-root UID 1000 claim and rules out rootless Podman. _Reversal cost:_ Moderate.

**Recommendation:** Option 1, stated explicitly in ship-2's acceptance criteria and in the install docs.  
The repair-then-drop path is the contract; the second start exists because operators already run compose with a `user:` line. Testing those two is proportionate; testing a model nobody in this audience uses is paying for a matrix leg with maintenance forever.

_Carried by_ `ship-2`. _Blocks_ `ship-10`.

### D18-documentation-canon

**When two documents describe the same rule, which one is edited — and does apps/site fork the install docs or read them?**

design-2 makes docs/design-contract.md the operational document and leaves DESIGN.md descriptive, with pointers both ways and no rule about where a new decision is written. ship-10 writes install and upgrade markdown in docs/ while spec-plugin-sdk §2 lists a later `apps/site` for marketing and docs. These are one question asked twice, and D1 in this list is what happens when it goes unanswered: spec-storage-sources §5.3 and spec-plugin-sdk §8 describe one column differently and both are shipping specs.

- **One rule for both pairs: reasoning lives in the human document, the operational artifact is derived from it and never argues. DESIGN.md holds decisions and reasoning; docs/design-contract.md is regenerated from it, with a test asserting every rule in the contract appears in DESIGN.md. docs/\*.md holds install prose; apps/site reads those files at build time and never forks them** — One place to edit, one place that can be wrong, and a test that notices drift in the design pair. _Reversal cost:_ Low while both documents are young.
- **The contract is canonical; DESIGN.md becomes narrative history** — The reasoning rots first and the next contributor cannot tell which rules are load-bearing. _Reversal cost:_ Moderate — the reasoning has to be reconstructed.
- **No rule** — Both drift, exactly as the two specs did. _Reversal cost:_ Paid in decisions like D1, repeatedly.

**Recommendation:** Option 1, recorded in design-2 for the design pair and in ship-10 for the docs pair.  
This pass exists because two documents described one thing and nobody owned the reconciliation. The cheapest possible prevention is a written rule about which file a decision goes into, and a derived artifact that cannot contradict it.

_Carried by_ `design-2 (design pair) · ship-10 (docs pair)`. _Blocks_ `ship-10`, `design-9`.

### D19-icon-set

**Is lucide the sanctioned icon set with a written rule, or a v1 holdover on the deprecation path?**

43 .tsx files import from lucide-react. DESIGN.md never names an icon library — it states a texture doctrine of 1-bit dither, mono glyphs and ink initials squares, and mentions icons only incidentally ("icon-only buttons carry aria-label", "a 1-bit icon grid of 32px tiles"). Roughly forty new surfaces in this plan will each reach for an icon and each decide alone. This is not on CONTEXT's open-questions list.

- **Sanctioned, with a rule written into DESIGN.md §5: one stroke weight (1.5), two sizes (14 and 16), and icons permitted only in the nav chassis, in icon-only buttons with aria-label, and as row-leading affordances in a mono lane — never in prose, never decorative, never as a status where a badge exists** — Forty surfaces inherit a decision instead of making one. Import count per file is lintable; the taste half stays human. _Reversal cost:_ A later move to mono glyphs is the same 43-file port it is today — waiting costs nothing.
- **Deprecate for mono glyphs** — A 43-file port plus a glyph inventory nobody has drawn, blocking or churning every new surface in projects 5–9. _Reversal cost:_ High and immediate.
- **Leave it unstated** — The current failure mode, multiplied by forty. _Reversal cost:_ Moderate but paid as inconsistency that is never quite worth fixing.

**Recommendation:** Option 1, carried by design-2 as a section of the design contract.  
Deprecation and sanction cost exactly the same 43-file port whenever they happen, so there is no option value in waiting — and in the meantime the absence of a rule is producing forty independent answers, which is the specific thing this pass is undoing.

_Carried by_ `design-2`. _Blocks_ `docsurf-5`, `docsurf-6b`, `ai-4b`, `ai-8a`, `sdk-20a`, `sdk-20b`, `storage-3b`, `views-3`.

### D20-routing-grid-pattern

**Is ai-4b's lane × sensitivity routing table drawn as a new matrix pattern, or expressed as a ledger with a second lane?**

ai-4b is the first surface in the product that is not a ledger, a record, a shelf or a queue, and its own body says so. DESIGN.md has eight patterns, P1–P8, and none is a matrix. design-2 can record the absence but cannot decide it, and ai-4b sits on the AI arc that projects 7–9 depend on.

- **Express it as a ledger (P2) with a second lane: one row per lane, cells for default provider and sensitive provider** — No new visual language; the existing ledger-section pattern already handles it; a third column (cap, last used) can be added later, which a matrix cannot absorb gracefully. At four to six lanes and two columns it reads better than a grid anyway. _Reversal cost:_ Low: ledger → grid later is a re-port of one settings section.
- **Draw the matrix on the Paper canvas before ai-4b is coded** — A genuine new pattern with a DESIGN.md sheet; adds a design cycle to the critical AI path for a table that is currently 5×2. _Reversal cost:_ Low, but the cycle is spent.
- **Let ai-4b invent it in code** — Precisely the failure this pass exists to undo — a new visual language shipped inside a feature slice. _Reversal cost:_ High: it becomes the precedent the next matrix copies.

**Recommendation:** Option 1. ai-4b stays hitl (the copy and the provider cells still want a human eye) but ships no new pattern.  
A matrix earns a pattern at 8×8, not 5×2; here the second axis is two values and a ledger row holds them without inventing anything. If the grid is genuinely wanted later, it will be wanted when there are more providers, and then it is a deliberate design slice rather than a rider.

_Carried by_ `ai-4b`. _Blocks_ `ai-4b`.

### D21-dark-theme-shape

**Is the deferred dark theme a token swap, or a real re-port — and should design-9 keep paying for enforcement that assumes the former?**

The `dark` custom-variant exists, no dark token values do, next-themes is already a dependency, and CONTEXT schedules dark post-v1 without saying which kind of job it is. design-9 pays a token-only enforcement cost on every surface on the assumption it is a swap. DESIGN.md's own materials doctrine says bone is a chassis because it is lighter than paper — a relationship that does not survive inversion.

- **Declare dark a re-port; keep token discipline for its own sake (consistency and the gate-5 lint) and delete "so dark is a token swap" from design-9's justification** — Honest scoping; the enforcement stays because it is worth it anyway, but nobody is told it buys something it does not. _Reversal cost:_ Nil — if dark turns out to be a swap, the tokens are already there.
- **Assume token swap and enforce for it** — The same enforcement, justified by a benefit that will not arrive, and a post-v1 surprise when the second ramp produces grey mush. _Reversal cost:_ The surprise is the cost; the tokens survive either way.
- **Build dark now** — Post-v1 by CONTEXT, and forty surfaces are still unported in light. _Reversal cost:_ High opportunity cost.

**Recommendation:** Option 1, carried by design-9 as a one-paragraph scope correction.  
The tokens are worth keeping regardless, so nothing material changes — but the justification does, and an enforcement rule justified by a false promise is the kind of thing that gets dropped the first time it is inconvenient.

_Carried by_ `design-9`. _Blocks_ nothing.

### D22-visual-regression-coverage

**Does the design area get machine coverage — a snapshot suite over forty surfaces — or does visual review stay human at the milestone demos?**

The audit's Playwright slice is a functional smoke (upload, preview, the login gate). Nothing in the plan looks at a pixel, and after this pass forty surfaces ship against a contract enforced by a lint rule that can only read class names. A snapshot suite is a real maintenance tax and the Instrument port is still mid-flight.

- **No snapshot suite. Two machine gates instead: the Playwright functional smoke, and gate 5's class-name lint extended with D19's icon rule. Visual judgement stays human at the milestone demo, revisited at two reviewers** — CI stays fast and its failures stay meaningful. The visual gate depends on the milestone demos actually being run — which risk 9 already names as the plan's only feedback loop. _Reversal cost:_ Low: snapshots are easiest to add once surfaces stop moving, which is after the port.
- **Snapshot suite over the forty surfaces** — Every port slice produces forty expected diffs; a suite whose failures are always expected is a suite nobody reads. _Reversal cost:_ Moderate to remove, and the intervening noise trains people to approve diffs blind.
- **Nothing at all** — No functional browser coverage either, on a product adding four byte-arrival paths and a preview surface. _Reversal cost:_ Low.

**Recommendation:** Option 1.  
Snapshots are worth their tax against a stable design and worthless against one being replaced; this codebase is the second case for the length of this plan, and the honest substitute — a functional smoke plus a lint that reads the token vocabulary — is already half-built.

_Carried by_ `design-2 (records the rule) · the Playwright slice (mono)`. _Blocks_ nothing.

### D23-semantic-lane-trigger

**How does the semantic lane fire in Cmd-K, given the palette has no submit — it debounces per keystroke and Enter opens the highlighted row?**

ai-11 as drafted said the vector lane "runs only on a submitted query", which does not exist. CONTEXT, DESIGN.md's palette sheet and spec-ai-substrate §7 are all silent. This is the only decision in the search cluster a user feels.

- **An idle second wave: lexical as today, then the same fused query re-run with the vector lane 600ms after the last keystroke, replacing the list — suppressed once the user has moved the selection or pressed Enter, so no row moves under the cursor** — No new visual language; one ranking; the palette stays fast because the first wave is unchanged. _Reversal cost:_ Moderate: if (b) or (c) later wins, ai-11 splits into a server slice (CTE, pin guard, cache — pure afk) and a surface slice.
- **An explicit "Search everything" row at the foot of the results, running the semantic pass on Enter** — A new row type and a new DESIGN.md sheet, decided inside a search slice. _Reversal cost:_ Low to remove, but the sheet has been written.
- **Semantic only on a dedicated /search page; Cmd-K stays lexical** — Two surfaces with two different orders for the same corpus, and the user has to know which one they are in. _Reversal cost:_ Moderate.

**Recommendation:** Option 1 — and regardless of which wins, write ai-11's server half (the fourth CTE, the k=60 pin guard, the cache) so it stands alone, because that is the part the other two options reuse unchanged.  
It invents nothing, keeps one ranking, and the suppression rule removes the only real objection (a row moving under a cursor). Writing the server half to stand alone makes the reversal cheap enough that this is a low-stakes call.

_Carried by_ `ai-11`. _Blocks_ `ai-12b`.

### D24-what-kind-other-means

**Does `kind: 'other'` mean "unknown" — so the classify lane proposes on it — or can it mean "a human chose Other"?**

The classify ladder writes a kind deterministically at filing time (folder name, then filename, then 'other') and the model proposes only afterwards on anything still at 'other'. Nothing today records whether a kind was guessed or chosen: document.kind is not an attribute, so kind changes do not appear in attribute_event. The alternative is a `kind_source` column (guessed | chosen | accepted).

- **'other' means unknown. The classify lane proposes once per document; the suggestion row records a rejection, so it never re-proposes** — Someone who deliberately picks "Other" gets exactly one inbox row saying it looks like a cap table, and dismisses it. No new column, no migration, and the once-only property is free because the suggestion table already records rejected. _Reversal cost:_ Low: kind_source is a nullable column added later with no backfill hazard, since nothing reads it.
- **Add `kind_source` now** — A column nothing reads on day one, plus a timeline line saying where a kind came from — which is genuinely nice and genuinely not needed yet. _Reversal cost:_ Low, but it rides in a migration that docsurf-2 is already making to the document enums, so it is nearly free if wanted.
- **Never classify a document a human has touched** — Unimplementable today — there is no record of a human having touched it — so this is option 2 wearing a different name. _Reversal cost:_ n/a

**Recommendation:** Option 1, carried by ai-14.  
The state worth protecting is not recorded anywhere, the cost of not protecting it is a single dismissible row, and the inbox is the surface designed for a machine being wrong in public. If the owner wants the timeline line, option 2 is cheap and additive later.

_Carried by_ `ai-14`. _Blocks_ `storage-9`.

### D25-first-sweep-flood

**How much accumulated history may the nightly duplicate sweep surface on its very first run, and does it announce itself?**

The job has never executed for any kind, so on an established workspace its first 03:30 pass proposes every near-duplicate accumulated since the workspace was created, into a queue the owner reads daily. The objects area left the bound undecided, which is why objects-4 is relabelled hitl. It is a judgement about the owner's own workspace, not an architecture question.

- **Bounded and announced: top 3 candidates per entity, 50 inserts per run, both applied in SQL, and the first-ever run writes a Today cell reading "first duplicate scan — N pairs found"** — The inbox fills at a readable rate and the owner knows why it filled. The cell is one row on a surface built for exactly this kind of unfinished business. _Reversal cost:_ Trivial — the cap is a constant and the cell is one component.
- **Bounded and silent (the resolver's default)** — Same rate; a queue that grows overnight with no explanation reads as a bug the first time. _Reversal cost:_ Trivial.
- **Unbounded first pass** — An inbox with several hundred pairs on day one, which is how a daily queue stops being read at all. _Reversal cost:_ Dismissing them is per-pair; the damage is to the habit, not the data.

**Recommendation:** Option 1.  
The cap and the announcement are the same two lines of work, and the announcement is what converts a surprise into a feature; the only reason this needs the owner is that only the owner knows how many pairs "N" will actually be in their workspace.

_Carried by_ `objects-4`. _Blocks_ nothing.

### D26-worker-bundler

**Which bundler produces the source-free worker image — tsup, which is not installed, or `vite build --ssr`, which is already in the toolchain?**

mono-13b removes src/ and tsx from the image, and docker/entrypoint.sh currently runs `node_modules/.bin/tsx` for both the migrate step and the worker, plus sdk-2's ROLE=worker health command. The spec names tsup; package.json has vite 8 (rolldown-backed) and no tsup. Adding a second bundler to the image build is an architecture commitment CONTEXT has not recorded.

- **`vite build --ssr` with three entries — worker, migrate, ROLE=worker health** — No new dependency, one bundler in the repo, same rolldown pipeline the web build already uses. _Reversal cost:_ Trivial: a build script and a config file.
- **tsup** — A second bundler and its config idiom, for a build the existing one can do. _Reversal cost:_ Trivial.

**Recommendation:** Option 1, with whichever wins recorded in CONTEXT and the reason stated.  
Nothing distinguishes the two for three Node entry points, and the tiebreaker is the frozen-dependency instinct the whole hostability contract runs on. The slice stays hitl only because someone should confirm the three entries actually boot in the pruned image.

_Carried by_ `mono-13b`. _Blocks_ nothing.

### D27-api-versioning

**One `/api/v1` namespace for everything external, or per-surface versions like `/api/capture/v1`?**

CONTEXT promises a versioned capture API, and the capture payload carries its own schema version — so there are already two clocks. The rule for which one moves, and what a v2 costs an extension installed on someone's laptop, should be written once rather than inferred by the third caller.

- **One `/api/v1` for every external procedure, plus the payload's own `schema_version`. The URL version moves only when an existing field changes meaning or disappears; additive fields never move it. The payload version moves when the extension's own shape changes** — An installed extension pins /api/v1 and keeps working for the life of v1; the two clocks have non-overlapping jobs, written down. _Reversal cost:_ Splitting one namespace later is a routing change plus a doc note.
- **Per-surface versions** — Capture, webhooks and MCP each version independently — flexible, and it means the answer to "what version am I on" is three answers. _Reversal cost:_ Merging two namespaces later is breaking for whoever adopted the second.
- **No version at all** — The first breaking change breaks an extension in the field with no migration path. _Reversal cost:_ High.

**Recommendation:** Option 1.  
There is one publisher and one consumer for the foreseeable future; the value of independent version clocks is entirely theoretical, while the cost of explaining three of them to the first integrator is not.

_Carried by_ `api-1`. _Blocks_ `the /api/capture slice`, `sdk-23`, `ai-23a`.

### D28-outbound-delivery

**Does the box ever POST events out, or is polling the read API the whole answer for n8n and the digest?**

CONTEXT's integration map #11 pairs "generic webhooks/API" and nothing in the 153 slices owns outbound event delivery or the digest channel. Outbound is a new subsystem — retries, per-endpoint secrets, a delivery log — and one that would want the same job_run table clean-2b is creating.

- **No outbound in v1. Ship the read API with a `?since=` cursor so polling is cheap and correct, and ship the digest as an internal consumer that sends through the existing optional SMTP_URL** — n8n polls, which is what n8n is good at; the digest needs no new transport. Record outbound webhooks as the deferred shape, reusing job_run for retries when it lands. _Reversal cost:_ Adding outbound later is additive. Note the ordering constraint: a cursor added later is a breaking read-API change, which is why it ships now.
- **Outbound webhooks now** — A retry subsystem, per-endpoint secret storage (needing D3's `webhook` kind) and a delivery ledger, for zero known consumers. _Reversal cost:_ Moderate, and it is a permanent surface once someone points an endpoint at it.
- **Neither — no read cursor, no outbound** — Polling means refetching everything, which is what makes people ask for webhooks. _Reversal cost:_ The cursor becomes a breaking change.

**Recommendation:** Option 1. The cursor is the load-bearing half and it is nearly free today.  
Outbound delivery is a subsystem justified by demand nobody has expressed, while the cursor is the cheap thing that makes its absence tolerable — and the one piece that becomes expensive if it is skipped.

_Carried by_ `api read-API slice`. _Blocks_ `the digest channel work`, `arrival-8`.

### D29-public-door-safety

**What stops abuse of a token-authenticated endpoint on a box that may sit on the open internet — and is a capture token allowed to read everything its owner can?**

There is no rate-limit code anywhere in src today; required env is frozen at {DATABASE_URL, APP_URL} so there is no Redis; and the endpoint being opened enqueues AI work the operator pays for. Separately, ai-23a's model is "a teammate's assistant sees what that teammate sees" — scopes narrow verbs, not rows — and a capture-only token lives in a browser extension on a laptop, the most exposed credential in the product.

- **Per-token counters in Postgres (one upsert per token per minute window) enforced in the HttpApi middleware, plus a documented Caddy rate-limit directive as the second layer; and PATs gain a write-only shape, so a capture token may write captures and read nothing** — Works with or without a proxy, adds no env and no service, and the extension's credential stops being a full read key on a laptop. One extra write on the hot path, which at this scale is free. _Reversal cost:_ Adding counters later is one middleware. Narrowing a token type that already shipped is breaking for installed extensions — which is the reason the write-only shape ships with the first PAT.
- **Delegate entirely to the reverse proxy** — The default compose has no proxy, so the default deployment has no limit at all; and the Caddy overlay then has to document something load-bearing. _Reversal cost:_ Low to add counters later, after the first surprise bill.
- **Nothing until someone is abused** — An endpoint that spends the operator's money, reachable by anyone holding one leaked token. _Reversal cost:_ Low technically; the incident is the cost.

**Recommendation:** Option 1, carried by the PAT slice (ai-23a today).  
The two halves are properties of the same object — the token — and both are cheap now and breaking later. The write-only shape in particular is the difference between a leaked extension key being an annoyance and being a full export of the workspace.

_Carried by_ `ai-23a`. _Blocks_ `the /api/capture slice`, `ai-24`, `sdk-23`.

### D30-mail-body-and-privacy

**Where does a forwarded or synced email body live, and who can see it before the thread is attached to a deal?**

These two are entangled and must be answered together. CONTEXT's privacy block presumes bodies are stored and records the default as "decide deliberately"; notes-5 deliberately moved bodies out of `interaction` into notes via `note_id`; storing every forwarded mail as a note fills /notes with mail. The repo already has `visibility: shared | private` on note and a private-note carve-out enforced in SQL (see the `not exists … visibility = 'private'` clause in searchEntities).

- **The body is a note via `interaction.note_id`, born `visibility: 'private'` to the connecting user and flipped to `'shared'` when the thread is attached to a record. /notes excludes mail-born notes by default with a filter to include them** — Reuses the privacy machinery that already exists and is already enforced in search — no second access model. The body is searchable, embeddable and mentionable, which is the reason to store it at all. The /notes flooding problem becomes a query, not a schema decision. _Reversal cost:_ Moderate: unwinding to metadata-only means deleting note rows; going the other way is impossible because the bodies were never kept.
- **A body column on `interaction`** — Contradicts notes-5, splits body storage across two tables, and gets none of search, embedding or mentions for free. _Reversal cost:_ High — a migration plus two readers.
- **Metadata and attachments only** — Cheapest and the safest privacy answer; loses the one sentence in a forwarded intro that actually matters ("intro from X, raising Y at Z"). _Reversal cost:_ Unrecoverable: bodies not stored cannot be recovered later.

**Recommendation:** Option 1, carried by arrival-1, with the workspace default expressed as a single setting (bodies private-until-attached) rather than a per-connection exclude list in v1.  
The privacy question already has a shipped answer in this codebase — private notes — and mapping mail onto it means one visibility model instead of two, with the search carve-out already written. It also makes the escalation's two questions collapse into one setting.

_Carried by_ `arrival-1`. _Blocks_ `arrival-2`, `arrival-10`, `notes-5`.

### D31-forwarding-transport

**How do forwarded emails actually reach the box — IMAP poll of an operator-owned mailbox, an inbound SMTP listener, or a provider webhook?**

A forward IS the consent model, which is why this is the first arrival channel in CONTEXT's sequencing instinct. Nothing in CONTEXT or the specs picks a transport, and the required-env set is frozen at {DATABASE_URL, APP_URL} with every feature shipping a working default or being optional.

- **IMAP poll of an operator-owned mailbox** — Zero OAuth, one app password, no new port, no MX record, no external account — and it is optional by construction (no mailbox configured, no lane). Costs polling latency, measured in a minute or two. _Reversal cost:_ Low by construction: the parser and the filing path are identical under all three options; only the transport module changes.
- **Inbound SMTP listener with MX records** — A real MTA and a second exposed port on a two-container product, plus spam handling the operator now owns. _Reversal cost:_ Low code-wise, high operationally once an address is published.
- **An inbound-email provider webhook (SES/Postmark)** — Best latency and no mailbox to own; requires an external account, which breaks "every feature ships a working default or is optional" for the first arrival channel. _Reversal cost:_ Low.

**Recommendation:** Option 1.  
It is the only option that satisfies the frozen-env rule for the channel CONTEXT wants first, and because all three share the parser and the filing path, picking the cheapest now costs almost nothing if it later proves too slow.

_Carried by_ `arrival-1`. _Blocks_ `arrival-2`, `arrival-10`.

### D32-headless-browser

**Does a headless browser ship in the default image so DocSend and Pitch links can be snapshotted to PDF?**

No playwright, puppeteer or chromium appears in package.json, CONTEXT.md or ARCHITECTURE.md. Bundled Chromium is roughly 400 MB on a product whose pitch is two containers and `docker compose up`. docsurf-10a's clip handles articles and PDF responses; a DocSend link is neither and will fail its guard. Deck-link ingestion is sequenced first alongside forwarding.

- **Not in the default image. Three tiers: a PDF response is filed directly; an article is clipped by readability; a deck link becomes a document row with `external_url` and a "snapshot unavailable" state plus a one-line instruction to print-to-PDF and drop it in. An optional `spaces-snapshot` companion container, documented and not default, fills the gap behind one port with two implementations** — The image stays small, the row still exists so the deal has its link and its timeline entry, and nobody is told a snapshot happened when it did not. Anyone who wants automated snapshots adds one compose service. _Reversal cost:_ Low both ways: adding the companion is a compose overlay; removing Chromium from a published image later is a breaking size change people already sized their box for.
- **Bundle Chromium** — Automatic snapshots, a ~400 MB image, and a dependency that still fails on DocSend's email gate a good share of the time. _Reversal cost:_ High — image size is a promise people plan around.
- **Refuse politely with no row** — The link is lost and so is the fact that someone sent it. _Reversal cost:_ Low.

**Recommendation:** Option 1, carried by the deck-links slice with arrival-4 written against the same port.  
The single largest violation of the hostability contract available in this plan, traded for a capability that is unreliable even when it works — and the two-implementation port means the capable version is one optional container away for whoever wants it.

_Carried by_ `the deck-links slice (docsurf) · arrival-4`. _Blocks_ `arrival-4`.

### D33-feeds-core-or-plugin

**Is the RSS feed poller a plugin, or core?**

CONTEXT calls feeds "the one capability with no vault dependency; dormant until the first feed URL", which reads core; spec-plugin-sdk §5 lists `poller: { poll() → Item[] } // RSS`, which reads plugin. arrival-8 assumes the plugin, which means a deployment with no plugins installed can attach a feed and never poll it — the slice makes that state legible rather than silent, but it is still a feature that does nothing.

- **Core owns a default RSS fetcher; the SDK's `poller` kind stays for feeds that need credentials or a vendor API** — Attaching a feed works on a box with zero plugins, which is what the CONTEXT sentence promises. RSS parsing is a small, dependency-light amount of code. _Reversal cost:_ Low: moving core RSS into a plugin later is a file move.
- **Plugin only (arrival-8's assumption)** — A legible failure is still a failure — the user attaches a feed, sees an explanation, and installs a plugin to make a URL poll. _Reversal cost:_ Low, but the support conversation happened.
- **Both, core as fallback** — Two code paths for one behaviour and an ambiguous answer to "which one polled this?" _Reversal cost:_ Moderate.

**Recommendation:** Option 1, carried by arrival-8, with spec-plugin-sdk §5's poller example changed from RSS to something that actually needs the port.  
"Dormant until the first feed URL" is a core-capability sentence, and a capability whose default state is inert unless you install something is the kind of quiet disappointment that makes a self-hosted product feel unfinished.

_Carried by_ `arrival-8`. _Blocks_ `the feed-scopes slice`.

### D34-participants-and-interactions

**Which email participants become people, and does an all-internal calendar meeting become an interaction at all?**

Two halves of one policy. CONTEXT says forward-only sync makes "create all, visible" obvious; the Twenty survey's takeaway is SENT-only creation plus a free-email-provider list — and a forwarding mailbox has no sent folder for the SENT rule to read. Separately arrival-5 assumes an all-internal meeting is noise, but that rule silently drops the partner-meeting record of an IC discussion, which is precisely the kind of thing a fund wants on a deal's timeline. The free-email-domain list would be a new in-repo data file nobody currently owns.

- **Create-all-visible for people, minus a shipped free-email-domain list (gmail, outlook, yahoo, proton, icloud and ~30 more) which never mints a company — only a person; and a meeting becomes an interaction when it touches the graph (an attendee or the title resolves to a record), not when an external attendee is present** — The IC discussion lands on the deal's timeline; no "gmail.com" company is ever created; the domain list is a tested data file owned by the arrival area. _Reversal cost:_ The list is data and the rule is a predicate — both cheap. What is not cheap is the thousand junk rows created under a wrong rule before it is fixed.
- **Create-all with no domain list** — Companies named after email providers, and a dedupe inbox full of them. _Reversal cost:_ Merging or deleting them by hand.
- **SENT-only creation** — Unimplementable on the first channel — a forwarding mailbox has no sent folder — so it can only ever be a later Gmail-sync refinement. _Reversal cost:_ n/a

**Recommendation:** Option 1, carried by arrival-2, with the domain list landing as a tested data file in the same slice.  
Create-all is right for forward-only consent, the domain list is the one cheap guard that prevents the characteristic failure, and reframing the calendar rule from "are all attendees internal" to "does it touch the graph" keeps the case the naive rule loses.

_Carried by_ `arrival-2`. _Blocks_ `arrival-5`, `arrival-10`.

### D35-list-query-state

**Do ad-hoc filter conditions belong in the URL, and does the global text box on a paged table survive as a server-side search?**

Only `?view=` is linkable today. Typed search params are one of the recorded reasons for choosing TanStack Start, and a pasteable filtered list is nearly free once filtering is server-side — but it makes every keystroke in the condition editor a navigation. Separately, the text box cannot stay client-side once the table holds one page of rows; views-3 carries the call and it is named in two areas so it is not answered twice.

- **Conditions stay out of the URL for v1 (refetch keyed on the condition array); the text box stays and becomes a server ILIKE over canonical_name plus name aliases** — No navigation per keystroke in the editor; "narrow this list" stays a distinct gesture from "go somewhere" (Cmd-K). When shareable filtered links are wanted, the same text can join a search param later without touching the evaluator. _Reversal cost:_ Adding search params later is additive and does not change the evaluator.
- **Conditions in typed search params now** — Shareable filtered lists immediately; every keystroke in the condition editor is a history entry, and the back button starts undoing filter edits. _Reversal cost:_ Once people share links, the param shape is a contract.
- **Delete the text box in favour of Cmd-K** — One fewer thing to build; filtering a table now costs a navigation away from the table. _Reversal cost:_ Low to restore.

**Recommendation:** Option 1.  
The two gestures are genuinely different — Cmd-K takes you somewhere, the box narrows what you are looking at — and collapsing them makes the most-used table worse to save one server function. The URL question has a cheap later answer and no cheap way back.

_Carried by_ `views-2 (conditions) · views-3 (text box)`. _Blocks_ `views-3`, `docsurf-5`.

### D36-filterable-sortable-flags

**What happens when someone sorts or filters by an attribute that is not flagged, and which system attributes are flagged at seed?**

Per-attribute expression indexes on `(values->>'slug')` are minted behind a filterable/sortable flag. Default-off means a fresh install mints no indexes and the first filter on `stage` is a seq scan; flagging at seed means the reconciler mints those indexes at first boot against an empty table, which is free then and is the only moment it is free.

- **Offer only flagged attributes in the sort and filter menus (no silent slow path, no auto-flag); a saved view whose attribute loses its flag keeps the condition, marks it unavailable in the bar and falls back to unfiltered rather than erroring; seed `stage`, `status`, `owner` and `close_date` as filterable** — Indexes exist before there is data to index; a cleared flag degrades a saved view visibly instead of breaking it; conditions are treated as user intent and a flag as an index, which is what it is. _Reversal cost:_ Flags are booleans and indexes are mintable and droppable — cheap in every direction, which is why the seed choice is the only part that matters.
- **Default-off everywhere** — The first filter on stage on a real workspace is a seq scan and a support question. _Reversal cost:_ Low, but the index is then minted against a populated table.
- **Auto-flag on first use** — An index minted inside a user's click, possibly on a large table, with no warning. _Reversal cost:_ Low, but the pause is felt by the user.

**Recommendation:** Option 1.  
Flagging the four attributes the product ships opinions about costs nothing at seed and removes the only realistic first-filter-is-slow complaint; treating a cleared flag as "unavailable" rather than "invalid" is the behaviour that does not lose someone's saved view.

_Carried by_ `views-1 (flags) · views-2 (evaluator honouring them)`. _Blocks_ `views-2`, `views-3`, `ai-18`.

### D37-deals-board-pagination

**Is the deals board permanently exempt from pagination, and what do the stage chip counts mean if it is not?**

The board's stage chips count over every deal, so a page makes them lie. CONTEXT's kanban group-by entry assumed the values-jsonb index would serve the board. Whether a board ever pages per column is open, and it is the one list surface where the count is the point.

- **Permanently exempt: load all deals in open stages, page nothing, and collapse closed/passed stages behind a separate `count(*)`** — Chips are always honest because nothing is hidden; the one genuinely unbounded stage is the one nobody scrolls, and it is counted rather than loaded. A fund has hundreds of open deals, not hundreds of thousands. _Reversal cost:_ Adding per-column paging later is additive.
- **Page per column with counts from a separate count query** — Counts are right and the column reads "20 of 340", at which point it is a list with chips, not a board. _Reversal cost:_ Low.
- **Page the board like every other list** — The chips lie, which is the one thing the board is for. _Reversal cost:_ Low technically; the trust is the cost.

**Recommendation:** Option 1.  
The board's value is the whole pipeline at a glance; the scale argument that justifies pagination elsewhere does not apply to open deals, and the stage that could grow without bound is exactly the one worth collapsing rather than paging.

_Carried by_ `views-3`. _Blocks_ nothing.

### D38-retention-of-derived-layers-and-payloads

**When `retain: text` throws the bytes away, what happens to the page-image cache, the extraction cache, the import payload blob, and the import_batch/import_row rows?**

storage-12's retain policy is per storage binding and says nothing about anything derived. The page-image cache can be larger than its source blob; the extraction cache is sha-keyed so re-asking is free; a portfolio spreadsheet sitting in the blob store forever is both the audit trail and the most sensitive object in the workspace; and import_batch/import_row hold a verbatim copy of every cell of the user's file in Postgres indefinitely. Three areas raised this independently.

- **One rule: derived layers are sha-keyed caches — bounded by a size budget (a setting, default 2 GB), LRU-evicted, rebuildable, and simply absent under retain:text, which is the policy working rather than a bug. Authored inputs are records: the import payload follows retain:full for 90 days then drops to text (the grid lives in import_row anyway); import_batch/import_row are kept until the batch is reversed or explicitly pruned, because the per-row receipt is what makes D12's reversal legible** — A tar of ./data stays a sane size; the audit trail survives; the one sensitive artifact (the raw spreadsheet) ages out while its structured record stays. _Reversal cost:_ Raising a bound later is a setting; data deleted under a bound that was too tight is gone — which is why import_row is on the keep side of the line.
- **Keep everything forever** — A page-image cache larger than its source in a product whose backup story is tarring a directory. _Reversal cost:_ Low to bound later, but the disk was already full.
- **Bound everything including import_row** — The per-row receipt disappears and a reversal cannot name what it reverses. _Reversal cost:_ High — the receipts are unrecoverable.

**Recommendation:** Option 1, carried by storage-12 so the retain policy covers derived layers in the same sentence it covers bytes.  
The distinction that makes all four cases fall out is cache versus record: anything rebuildable from bytes or from a model is a cache and gets a bound, anything a human typed or uploaded is a record and gets kept. Both import questions and the backfill question are the same question under that rule.

_Carried by_ `storage-12`. _Blocks_ `import-9`, `ai-21`, `ai-6`, `the page-image slice`.

### D39-importer-parse-signature

**Does a plugin importer's `parse(file)` return a grid for the mapping wizard, or Claims?**

This is called out as the hitl decision inside import-10, and it also pins `parse`'s signature in a semver-frozen SDK surface — so it is really an sdk-4a decision that import-10 inherits. spec-plugin-sdk §5 already describes the importer kind as `parse(file) → Claim[]`.

- **Claims. The core CSV path keeps its grid internally and converts to claims at the same seam, so there is one commit path** — Claims are the vocabulary every other plugin kind already speaks; they route through the same resolve, dedupe and suggestion machinery; a dialect plugin (Airtable, Notion) knows its own semantics better than a column-mapping UI can infer them. _Reversal cost:_ Widening later to `Claim[] | Grid` is additive.
- **A grid** — The mapping wizard works for plugin dialects too — the one real argument — at the cost of freezing a UI's internal shape into a permanent contract. _Reversal cost:_ High: narrowing a frozen SDK return type is breaking for every installed plugin.
- **A union of both** — Two commit paths and two failure modes inside a semver-frozen surface. _Reversal cost:_ Very high — you can never remove either arm.

**Recommendation:** Option 1, carried by sdk-4a since that is where the kind interfaces freeze; import-10 becomes a consumer.  
The asymmetry decides it: claims can grow into a grid later, a grid can never shrink into claims, and the surface is explicitly semver-frozen. It also matches what the spec already wrote.

_Carried by_ `sdk-4a`. _Blocks_ `import-10`.

### D40-safe-instrument-default

**Should an unmapped "SAFE" in an imported sheet be refused, or default to post-money?**

import-8 refuses rather than guessing, which is right for correctness but costs a click on nearly every angel sheet. Post-money has been YC's standard since 2018; pre-money SAFEs dominate 2016–2018 vintages, which is exactly the back-catalogue a bootstrap import contains. This is a domain call, not an implementation one.

- **Keep the refusal, and add a workspace-level declared default (`safe_default: post | pre | none`, default none) set once in the import wizard** — Correctness stays the shipped behaviour; the click is paid once per workspace rather than once per row; the setting is visible so nobody is surprised by what was assumed. _Reversal cost:_ A setting is a setting; wrongly imported instruments are a ledger correction under D12.
- **Default to post-money silently** — One less click on modern sheets, and every pre-money SAFE in an older portfolio is mis-valued with no signal. _Reversal cost:_ High — it produces exactly the wrong committed ledger rows D12 exists to fix.
- **Refuse always with no setting** — Correct and tedious; a 40-row import becomes 40 clicks. _Reversal cost:_ Low.

**Recommendation:** Option 1.  
The refusal is the right default and the setting is the right escape; guessing silently on the one field that changes a valuation is how an import quietly produces a wrong portfolio.

_Carried by_ `import-8`. _Blocks_ `import-9`.

### D41-ai-mapping-write-doctrine

**When AI proposes a column mapping, is that a `suggestion` row or a pre-selected control the human confirms?**

Every import slice is deterministic today, so import works with no provider configured and required env stays frozen — deliberate. When AI mapping arrives, the answer decides whether the mapping step is ever a machine write, and the same question returns for ai-17's and ai-18's cell-level proposals, so the doctrine sentence is worth writing once.

- **A pre-selection the human confirms, plus one written doctrine line: an AI proposal becomes a `suggestion` row when it would otherwise write without a human present; a pre-filled control in front of a human is not a machine write** — No queue entry per column per import; the doctrine's actual purpose (never silent) is satisfied by the confirmation screen itself. The line then answers the same question for ai-17 and ai-18. _Reversal cost:_ Promoting a pre-selection to a suggestion row later is additive.
- **Suggestion rows for mappings** — /inbox fills with rows the user already answered in the wizard, and "accept all" starts operating on decisions that were already accepted. _Reversal cost:_ Low, but the inbox's credibility is the cost.
- **No AI mapping** — Fine today; the question returns unanswered the moment anyone asks for it. _Reversal cost:_ n/a

**Recommendation:** Option 1 — and land the doctrine sentence in CONTEXT before ai-17 and ai-18 ship, not when AI mapping is built.  
"AI writes are suggestions, never silent" is about absence of a human, not about the existence of a model; without that distinction written down, every future confirmation screen argues about whether it needs a queue.

_Carried by_ `the AI-mapping slice (deferred); the doctrine line lands in CONTEXT with ai-17`. _Blocks_ `ai-17`, `ai-18`.

### D42-export

**Can a user get their data back out, and who owns that?**

The import area is migration-in only; nothing in CONTEXT or the specs covers migration-out. A self-hosted product whose pitch is "you own your data" and which cannot hand the data back is making a lock-in claim it presumably does not intend. The attribute registry already describes every column, so the work is mostly enumeration.

- **One v1 slice: a workspace export writing a zip of CSVs (one per object, from the same registry the import reads), notes as markdown, documents as a manifest plus the blob tree** — The ownership claim becomes true; it doubles as the user-facing half of the backup story beside pg_dump; it is cheap because the registry is the schema. _Reversal cost:_ Additive, but the longer it waits the more surfaces it must cover.
- **pg_dump is the export** — True for the operator, useless for a user who wants their deal flow in a spreadsheet. _Reversal cost:_ Low.
- **Defer** — The claim stays unbacked for the whole of v1 — and it is the claim the product is sold on. _Reversal cost:_ Low technically; it is a credibility cost.

**Recommendation:** Option 1, as a new slice in the import area (which should be renamed "import and export").  
It is the obvious twin of the work already being planned, it reuses the same registry walk, and it is the cheapest possible defence of the sentence the whole product rests on.

_Carried by_ `a new export slice (import area)`. _Blocks_ nothing.

### D43-import-entry-point

**Does the getting-started card gain an Import step, and does /today surface a staged-but-uncommitted batch?**

The import is the first thing a real user does and it currently has no entry point on the landing page. The getting-started card is 5/5 today, and Today is the surface built for unfinished business.

- **Yes to both: Import becomes a step (5/5 → 6/6) and a staged batch shows on Today as "42 rows staged — finish import"** — The onboarding-critical feature is findable, and an abandoned half-import is visible rather than silent. _Reversal cost:_ Trivial.
- **Settings only** — The wizard exists and nobody finds it in the first session, which is the only session that matters for it. _Reversal cost:_ Trivial.
- **Card step but no Today cell** — A half-finished import goes quiet, and staged rows sit in import_batch forever. _Reversal cost:_ Trivial.

**Recommendation:** Option 1.  
Both halves are small and both address the same failure — an import that is hard to start or easy to abandon silently. There is no argument against except step-count tidiness.

_Carried by_ `the import wizard slice`. _Blocks_ nothing.

### D44-suggestion-chips

**May a suggestion chip on the record rail carry inline accept and reject, or is it a read-only pointer into /inbox?**

The recorded decision is "chips on the record rail + a review inbox" — two surfaces. backfill-5 pins inbox-only for v1 so ai-8b's bulk accept keeps one path. DESIGN.md's Micro-interactions sheet has four proposals and none is a chip with an action, so inline accept is new visual language as well as a second write path.

- **Read-only chip: "3 waiting" on the rail, opening /inbox filtered to that record** — One accept path, so refs rendering, per-row failure handling and bulk accept all live in one card. The chip still solves the real gap — the deck reader's output being invisible where someone is actually reading. _Reversal cost:_ Adding inline accept later is additive and can reuse the inbox's accept function.
- **Inline accept on the chip** — Faster for the single-suggestion case; the Micro-interactions sheet gains a fifth proposal and ai-8b's shape changes to accommodate two entry points to one write. _Reversal cost:_ Moderate — two write paths are hard to re-merge once both have users.
- **No chip** — The inbox is the only way to notice a suggestion, and nothing on the record says there is one. _Reversal cost:_ Low.

**Recommendation:** Option 1, carried by backfill-5.  
The chip's job is discovery, not action; giving it an action duplicates the one write path the doctrine cares most about protecting, for a saving of one click.

_Carried by_ `backfill-5`. _Blocks_ `ai-8b`.

### D45-space-tag-classify-vocabulary

**When the model proposes space tags, what is the candidate vocabulary — the whole space tree, or a bounded slice of it?**

backfill-6 pins the whole space tree as the enum, which is right at seed scale and wrong at a few hundred nodes. The cut becomes real the first time a fund models its taxonomy properly, and the obvious alternative (embedding similarity to the record) depends on vectors that a sensitive record will not have under D11.

- **The record's existing space subtree(s) plus their siblings, capped at 40 nodes in ltree depth-first order** — At seed scale (≤40 spaces) this is the whole tree, so nothing changes visibly today; at a few hundred nodes the prompt stays bounded and deterministic, and it works for sensitive records with no embeddings. _Reversal cost:_ Swapping the selector is one function; tags already written are suggestions, so there is no data to migrate.
- **The whole tree, always** — An unbounded prompt and a model picking a leaf it half-understands, exactly when the taxonomy gets interesting. _Reversal cost:_ Low.
- **Embedding-similarity top-N now** — Better selection where vectors exist; silently degrades to nothing on a record with no embeddings — including every sensitive record under D11. _Reversal cost:_ Low.

**Recommendation:** Option 1, carried by backfill-6.  
A deterministic bound that is a no-op at today's scale is free insurance, and it does not inherit the embedding hole that the similarity approach would.

_Carried by_ `backfill-6`. _Blocks_ nothing.

### D46-caps-and-usage-accounting

**What unit does the AI cap count, is there a second ceiling per integration, and does a cache hit appear in Usage?**

Three questions about one surface. backfill-4 pins daily tokens workspace-wide because ai_usage stores tokens and prices are per-provider; sdk-16's credit cap is per integration, so a runaway researcher can spend the human's whole day of tokens before anything refuses; and backfill-8 pins a cache hit as writing no ai_usage row, which makes the Usage surface under-report activity while the run log may want the opposite.

- **Daily tokens as the one unit, with two ceilings (workspace and per integration) in that unit; no bundled price table, but an optional operator-entered $/Mtok per provider in credential.meta that turns the number into a labelled estimate; a cache hit writes no ai_usage row but does open an `ai_run` with a `cached: true` step** — One unit everywhere, so sdk-16 and backfill-4 stop being two mechanisms; the box never states a price it cannot verify; Usage reports activity and provenance from the run log while spend stays exactly what was spent. No new table. _Reversal cost:_ Adding a price field is additive; changing the cap unit later is a settings migration plus every operator's mental model.
- **Cap in currency with a bundled price table** — The operator reads the number they think in; the table rots the first time a provider changes prices, and the number becomes confidently wrong. _Reversal cost:_ High — you cannot un-tell someone a wrong dollar figure.
- **Cap in requests** — Meaningless across a 400-token classify and a 100k-token deck read. _Reversal cost:_ Low.

**Recommendation:** Option 1, carried by backfill-4 for the ceilings and ai-25a for the run-log half.  
Tokens are the only unit the box can measure honestly, and the split between ai_usage (spend) and ai_run (activity) already exists — using it is what lets the Usage surface be complete without the spend number being inflated by cache hits.

_Carried by_ `backfill-4 · ai-25a`. _Blocks_ `sdk-16`, `ai-13`, `ai-17`, `ai-18`.

### D47-plugin-rollback-entry-point

**How does an operator roll back a bad plugin upgrade on a box that ships no CLI?**

Spec §10 names `plugin rollback` as a command and this product ships no CLI; backfill-13 pins "no CLI, the ledger says whether restore is required", which leaves the genuinely safe case — a rollback where no forward migration ran — with no one-click path. The upgrade flow keeps the previous version directory one back.

- **A button on the Integrations ledger row — "Roll back to <version>" — shown only when the previous version directory exists AND no forward migration ran; when a migration did run, the button is absent and the row says restore-from-backup is the only rollback** — The safe case is one click; the unsafe case is told the truth rather than offered a button that would silently revert a schema the new version wrote. _Reversal cost:_ Additive either way.
- **Ledger text only, no action (backfill-13's pin)** — An operator facing a broken plugin uninstalls instead, losing the plugin's data — the worse outcome the button exists to prevent. _Reversal cost:_ Low.
- **Always allow rollback** — Reverts code against a schema the new version already migrated, which is data loss dressed as a safety feature. _Reversal cost:_ Unrecoverable.

**Recommendation:** Option 1, carried by the plugin-upgrade slice the audit adds (not by backfill-13 alone, since the version directory and the migration ledger are that slice's).  
The condition that makes rollback safe — no migration ran — is already recorded, so gating the button on it costs a predicate and converts a documented dead end into a click.

_Carried by_ `the plugin-upgrade slice (sdk area)`. _Blocks_ nothing.

### D48-space-crumb-line

**How many terms does the space page's crumb count line carry?**

backfill-10 pins contacts counted separately from sources, subspaces, companies and filed notes, which makes the line five terms long. Every one of those sections already carries its own count in its header.

- **Two terms on the crumb line (sources, contacts); the rest stay on their section headers** — The line stays readable and says the two things that answer "is there anything here"; nothing is lost because the other counts are visible one scroll down. _Reversal cost:_ Copy.
- **Five terms** — A sentence nobody reads, duplicating four numbers that appear again immediately below. _Reversal cost:_ Copy.
- **No count line** — The space page's header stops answering whether the space has content at all. _Reversal cost:_ Copy.

**Recommendation:** Option 1.  
Duplicated counts earn their place only when the duplicate answers a question the original cannot; two of these do and three do not.

_Carried by_ `backfill-10`. _Blocks_ nothing.

---

## 4. Second audit

### New collisions introduced by this pass (11)

- `backfill-3` `import-2` `backfill-9` `storage-12` — Three subsystems deliberately create blobs with no document row, and only one of them is known to the sweep that reclaims blobs with no document row. backfill-3 (P8) ships the orphan-blob sweep with a 'pending_blob intent row on both writers' and 'one shared is-any-row-on-this-sha helper'. import-2 (P14) stages the import payload as a blob that deliberately never becomes a document and is kept forever as the audit trail. backfill-9 (P12) writes one blob per page image with its own mapping table. The sweep ships six projects before the first violator and twelve before the second.  
  **Fix:** Make the ownership helper an interface, not a list: backfill-3 defines blobOwners[] and its acceptance requires every later blob writer to register. Add import-2 and backfill-9 as declared owners in their own acceptance criteria, and extend the D38 sentence in storage-12 to say the sweep, not only retain policy, must honour them.
- `import-5` `storage-9` `arrival-2` — Three areas each build a match-only / dry-run resolve over src/lib/entities/resolve.ts. storage-9's body already ships `resolveEntity({createIfMissing:false})` returning `{action:'attached'|'fuzzy'|'no_match', candidates}`. import-5's own notes say 'resolveEntity has no dry-run mode... the spec's resolve-preview needs a read-only twin over the same normalizers'. arrival-2 owns src/lib/arrival/participants.ts as 'the single creation policy for mail, calendar, recorder and Gmail'. Nothing blocks any of them on the others. This is the duplicate-evaluator failure repeating on the identity door.  
  **Fix:** import-5 (P14) is the first to land and becomes the owner of the createIfMissing:false seam with the return shape pinned; storage-9 (P21) is blockedBy import-5 and deletes that criterion; arrival-2 (P13) — which lands earliest of all — either owns the seam instead or is blockedBy nothing and calls it, but one of the three must be named in the other two's bodies.
- `api-6` `views-3` — api-6 pages through records for external consumers; views-3 (P9) builds keyset pagination with a server-computed honest count for the same rows. The api area was written before the views area existed — its collisionsAvoided names docsurf-12b and ai-18 but not views at all — so api-6 has no views-3 edge and will invent a second cursor scheme over the same query.  
  **Fix:** api-6 ← views-3, and its acceptance states it returns views-3's keyset cursor verbatim rather than a page/offset or an opaque id of its own. Same edge for api-6 ← views-2 if any external filter ever lands (today api-6 correctly ships none).
- `arrival-4` `ship-6` `mono-13a` `ship-8` — Two new areas each introduce a headless browser without seeing the other. arrival-4 (P13) snapshots DocSend/Pitch links and carries D32, 'does a headless browser ship in the default image'. ship-6 (P16) installs Playwright and a real Chromium for CI. mono-13a/ship-8 own the image contents and its size. Nobody reconciles one browser dependency across runtime and test, and the ship area's notes never mention arrival-4.  
  **Fix:** Answer D32 in ship-8 (image contents) rather than in arrival-4, and record the answer in arrival-4; if Chromium ships, ship-6 reuses the image's browser instead of installing a second one, and the 400 MB is charged once in the before/after size record mono-13a already owes.
- `design-2` `docsurf-5` `views-1` `docsurf-12a` — The documents shelf's chrome is decided twice, one project apart. design-2's contract (P4) answers docsurf-5 with '/portfolio pattern, hand-declared columns, useTablePrefs, no ViewBar'; docsurf-12a (P9) then replaces useTablePrefs with a real saved view and a ViewBar on the same page. The design area raised exactly this as its open question #4 ('what happens when a ViewBar lands on a surface with no object row... worth deciding before docsurf-5 rather than after') and the merge did not answer it, so P8 builds a shelf P9 rebuilds.  
  **Fix:** Answer it in views-1 (which now owns the surface discriminator) and write the answer into design-2's contract before docsurf-5 is written, so docsurf-5 either ships the ViewBar shape from the start or docsurf-12a's diff is explicitly declared as the replacement and sized for it.
- `ship-1` `ship-3` `ship-8` `sdk-2` `mono-13a` `ship-10` — Five slices across two new areas and one old one author the compose overlay set and the README with no stated ownership. sdk-2 (P2) ships docker-compose.split.yml and 'references it from the README'. ship-1 (P1) rewrites the README, which the ship notes record is still the TanStack Start template verbatim including a section on removing Tailwind. ship-3 (P1) adds docker-compose.tls.yml against `build: .`. mono-13a (P16) re-points both compose build contexts. ship-8 (P16) pins published tags in compose. ship-10 (P16) writes install docs and its own open question asks where docs live.  
  **Fix:** Name ship-1 the owner of README structure (it already owns the wordmark), give it a named section sdk-2 appends to, and give ship-8 one criterion that re-points every overlay file by name (docker-compose.yml, .tls.yml, .split.yml) when the build context becomes an image tag.
- `objects-3` `ai-8a` `design-2` `design-6` — The merge moved surface ownership from ai-8a to objects-3 but left the design blockers on ai-8a. objects-3 now owns /inbox, the route rename and redirect, the RENDERERS map, the row contract every later kind inherits, and Today's readout count — and has no design dependency and is afk. ai-8a, reduced to one row kind plus filter tabs, keeps ← design-2 + design-6 and stays hitl. The design rule the merge applied everywhere else (docsurf-5, ai-17, notes-2/3, docsurf-9, sdk-20b, every settings surface) is not applied to the one slice that now creates a surface.  
  **Fix:** objects-3 ← design-2 + design-6 (the nav row and chord for /inbox are design-6's data), and relabel it hitl or explicitly declare the row-card treatment as 'same card, same rails' with no new language. ai-8a keeps design-2 only if its filter tabs are genuinely new; otherwise the HeaderTab precedent it cites makes it afk.
- `arrival-9` `backfill-12` `sdk-7b` `arrival-8` — Two writers of `signal` on a record, and the decision that separates them (D33, is the feed poller core or a plugin) is unresolved. arrival-9 owns src/lib/arrival/match.ts as 'the only deterministic graph matcher' writing signals from feed items; backfill-12's Exa researcher produces 'five web signals on a record' through sdk-7b's signal lane. Both land in P23. If feeds are core, arrival-9 is a second signal writer beside sdk-7b's port; if they are a plugin, arrival-8's core feed/feed_item tables have no fetcher.  
  **Fix:** Answer D33 in arrival-8 before P19 (sdk-24b already depends on it), and state in arrival-9's body whether it writes signals directly or through sdk-7b's Content port, so the repo has one signal writer per actor class rather than two per row.
- `design-5` `api-3` `backfill-4` — The settings-shell dependency list is incomplete. The dep-fix routes ai-3a, ai-4b, ai-25, sdk-20a, storage-1, storage-3b, storage-17, ai-9a, ai-13 and sdk-21b through design-5, but omits api-3 (mints a personal token from a settings surface) and backfill-4, which is literally the missing fifth section of Settings → AI (Providers · Routing · Embeddings · Usage · Caps). Two more settings surfaces get to invent their own home.  
  **Fix:** api-3 ← design-5 and backfill-4 ← design-5, with backfill-4's Caps section declared as a SettingsSection in the ai group so the five-section spec is closed by construction.
- `storage-6a1` `storage-6a2` `api-4` `import-2` `arrival-3` `arrival-10` — The one-time widening of document birth and server intake names two future callers and misses two. The changeLog says storage-6a1/6a2 'must accept an in-memory payload with a caller-supplied name and mime (api-4 and import-2 both arrive with no stream and no content-length)'. arrival-3 (mail attachments, decoded MIME parts) and arrival-10 (Gmail attachments) have exactly the same shape and both land in P13/P23, after the widening is frozen. The whole point of widening once was to avoid a second widening.  
  **Fix:** Add arrival-3 and arrival-10 to the named callers in storage-6a1/6a2's acceptance so the signature is widened once for four callers, not twice for two.
- `import-2` `views-3` — Two new areas take opposite positions on holding every row in the browser. views-3 establishes that a table cannot hold every row and pages on a keyset cursor with an honest count; import-2 renders the whole parsed spreadsheet as one client-side grid with no row bound stated anywhere, and import-1's parse loads the file into memory. A 20,000-row xlsx is exactly the onboarding case the area exists for.  
  **Fix:** import-2 states a row cap and what happens above it (preview the first N with the count, or refuse with the number), and import-1 states a file-size guard reusing docsurf-6a's existing MAX_UPLOAD_BYTES rather than inventing a second one.

### Still missing (10)

- Opt-in nightly conformance against real provider sandboxes — a dedicated Google Cloud project and a Box developer account, secrets in CI, failures open an issue and never block PRs. This was audit missing[] #32 and it is the only entry of the 34 with no carrier after the merge. storage-4a/4b and sdk-25 test fakes only; ship-11 is upgrade CI; sdk-25 is explicitly 'with no API keys anywhere and the network off'. The backfill area listed 'nightly provider sandboxes' in its deliberately-not-sliced hand-off to the new areas, and none of the seven new areas picked it up. Without it the claim 'a plugin passes or does not ship' and the whole StorageSource port conformance story rest entirely on our own fakes. — storage-20 — Nightly sandboxes: the conformance suite against a real Drive and a real Box, non-blocking, issue on failure (project 20 or 22)
- Changesets itself. Audit missing[] #31 asked for 'changesets versioning and tag-driven release CI (image on core@x tags, plugin release on plugin-<id>@x tags)'. The merge covers only the second half: ship-8 publishes images on a tag and ship-9 publishes a plugin tarball on a plugin tag. Nothing installs changesets, bumps versions across the workspace packages, or generates a changelog — and project 19's milestone text already says 'Merge a changeset and a plugin-<id>@x tag builds...', i.e. it assumes a tool no slice adds. mono-1b owns turbo.json and the task graph but not versioning. — mono-1c or ship-8b — Changesets in the workspace: version bumps, changelog, and the core@x / plugin-<id>@x tags the two release jobs consume
- The two acceptance-criterion edits the backfill area explicitly handed back for gateway passthrough (audit missing[] #22) were dropped in the merge. backfill wrote no slice because ai-3a/ai-3b already ship baseURL + headers, but it handed back: (a) ai-3b's criteria test only baseURL, so add one for the extra-header rows round-tripping through credential.meta; (b) ai-9a must thread the same credential.meta into the embed adapters or the gateway rule holds for llm providers only. The reconciled dep-fix edits ai-9a's signature for sensitivity and says nothing about meta. — No new slice — two acceptance bullets: one on ai-3b (header rows round-trip), one on ai-9a (embed adapters read credential.meta baseURL + headers)
- MIS + runway lens. ARCHITECTURE §12's post-v1 backlog reads 'dark theme · MIS + runway lens · scorecards · meeting-prep briefs, pass-letter drafting...'. backfill-14 records four banked features as deferred (meeting-prep brief, pass-letter drafting, the Monday brief/digest, deal scorecards) per audit #33, and project 12's milestone text says 'four banked features'. MIS + runway lens is the fifth and appears in neither the plan nor the deferral register — despite CONTEXT carrying a fully-formed shape for it (Visible-style: standard six metrics, tokenized founder links, dual-path structured requests plus parsing what founders send). — No new build slice — backfill-14 records five banked features, not four, with MIS + runway lens and its trigger (the first portfolio a fund actually monitors)
- DESIGN.md §5 (Components) — the '/impeccable document' item in CONTEXT's UI craft debt 'Still open, in order', explicitly sequenced after the sweep. design-2 writes docs/design-contract.md (an operational document for agents choosing a pattern) and design-4 adds three primitives; nothing documents the component inventory in DESIGN.md. The design area's own open question #6 asks which of the two files is source of truth once both exist and proposes a rule — that rule is not written into any slice either. — design-11 — DESIGN.md §5: the component inventory after the sweep, and the one rule for which document new decisions land in
- The design deferral list, and CSV's reversal out of it. CONTEXT says 'Also carry into any design run: the deferral list, or an Attio-shaped brief will propose most of it back. Deferred by name: saved/shared views, bulk edit, calculations row, CSV, virtualization + keyboard-grid, kanban, drawer-over-table, Overview/Highlight cards.' Nothing in design-2's contract is said to carry that list. Separately, the plan reverses one entry — CSV becomes an entire twelve-slice project 14 — and no slice amends CONTEXT to record the reversal, while views-3 quietly answers 'virtualization' with pagination instead and views-5 documents 'kanban' as the deals-board exception. — No new slice — design-2's contract carries the deferral list verbatim, and import-1 amends CONTEXT to record CSV moving from deferred to shipped with the reason
- CLAUDE.md gate 5 and mono-6's gate-5 CI step after design-1. design-1 turns the banned-token grep into lint rules, but the merge only adds mono-6 ← design-1 'or its gate-5 CI step ships permanently red'. mono-6's acceptance on disk still reads 'ci.yml runs all five gates as separately named steps: prettier, eslint, tsc, the gate-5 token grep, and vitest' and 'the gate-5 step passes on a clean tree (the grep-exits-1 inversion is in place)'. Nobody rewrites CLAUDE.md's gate-5 block either — the text every agent reads, and the text the slice contract's last acceptance line points at. The design area's own finding is that the grep bans a vocabulary already at zero and misses what is live (border-sidebar-border at _app.tsx:61, bg-sidebar, the --color-sidebar-_/chart-_/card*/accent*/secondary* exports at styles.css:238-250), so leaving it in CI is a permanent false gate. — No new slice — design-1's acceptance rewrites CLAUDE.md gate 5 to 'the rules are in pnpm lint' and mono-6 drops the grep step, leaving four named gates
- apps/site. spec-plugin-sdk §2's monorepo layout lists apps/site (marketing/docs, on Vercel, never in the image) as a later app, and ship-10's own open question asks whether install/upgrade docs should live in docs/ or be read by apps/site. mono-1 creates apps/web only. Unlike apps/extension — which the api area deliberately and explicitly defers with its reason recorded — apps/site appears in neither the plan nor any deferral note. — No new slice — ship-10 records apps/site as deferred with its trigger (the first doc page that needs to be public), and says docs/ is the source those pages would read
- Rate limiting on the public door. api's own open question: there is no rate-limit code anywhere in src, required env is frozen at {DATABASE_URL, APP_URL} so there is no Redis, and api-3/api-4/api-5 open a token-authenticated endpoint on a self-hosted box that enqueues AI work. The merge neither slices it nor records it as deliberately deferred, while ship-3's Caddy overlay — the natural place to delegate it — is authored fifteen projects earlier with no mention. — No new slice if deferred — api-3 records the decision (per-token Postgres counters vs delegate to the proxy vs nothing) and ship-3's Caddyfile carries the commented-out rate-limit stanza if the answer is 'the proxy'
- sdk-15's split. The reconciled plan itself flags this as the one audit finding it did not answer: sdk-15 is an undeclared L carrying the provider client, the header-driven self-throttle, bulk endpoints, response normalisation into claims, receipts, Apollo's own error text and the wired job. It gates sdk-16, sdk-17, sdk-19 and sdk-25 and sits at the head of project 18. — sdk-15a — Apollo provider client and claim mapping, cassette-tested with no DB; sdk-15b — the wired enrich job, receipts and the visible error text

### Ordering violations (10)

- sdk-24b (project 19) is blockedBy arrival-8 (project 23) — the only backward cross-project edge in the merged graph, and it comes straight from the arrival dep-fix ('sdk-24b ← arrival-8, with feeds and per-guid dedupe moving to core feed/feed_item'). Either arrival-8 moves into project 19 beside sdk-24a/sdk-24b, or sdk-24b ships plugin_rss with its own feed_item and arrival-8 later migrates it — which is the two-feed_item-tables outcome the dep-fix exists to prevent.
- mono-7 (project 2) is given a move list containing files that do not exist until projects 9 and 14. The dep-fixes say 'mono-7's move list gains import/read.ts, coerce.ts and ledger.ts' (import-1/import-8, project 14) and 'mono-7's move list gains the shared fixture file views-2 adds beside filter.ts' (project 9). mono-7 cannot move either. The views half needs no fix at all — views-2 can write its fixture beside filter.ts, which is already inside packages/core after mono-7 — and the import half must instead be an acceptance bullet on import-1/import-8 saying the pure modules are born in packages/core.
- mono-9c (project 2) is told 'QUEUES gains import.commit' — a queue whose job is created in project 14 — and this directly contradicts mono-9c's own acceptance criterion on disk: 'Queue name strings are unchanged in this slice — grep the four values before and after and diff empty'. Drop the instruction; import-6/import-9 append to QUEUES when they land.
- mono-11a (project 15) is now the one-time queue rename, but projects 5-14 add roughly ten more queues before it: document.clip (docsurf-10a), the blob sweep (backfill-3), the classify/summarize/extract/vision lanes (ai-14/15/16/21), the embed backfill (ai-13), import.commit (import-6/9), the mail, calendar and feed pollers (arrival-1/5/8), the snapshot job (arrival-4). Its acceptance still says 'registers the four queues' and 'behaviour untouched'. Worse, no convention is stated for queues created in between — storage-8b's acceptance already writes core.storage.sync at project 21 — so mono-11a inherits a half-renamed tree rather than a clean one.
- docsurf-6b is blockedBy backfill-3 but backfill-3 is listed after it inside the same milestone (project 8, positions 5 and 7), and the milestone narration puts the sweep last ('Then bytes stop needing a record: global upload... and a scheduled sweep that reclaims bytes whose finalize never arrived'). Either reorder the milestone so backfill-3 precedes docsurf-6b, or drop the edge and let docsurf-6b state 'aborted uploads are reclaimed by backfill-3' as a forward reference rather than a blocker.
- All three publishNow projects have blockedBy edges into projects that are explicitly not publishable. Project 2: mono-1 ← ship-1 and mono-6 ← design-1, both in project 1, whose bodies are owed. Project 5: objects-2/objects-1a ← clean-1 and objects-7 ← clean-3, both project 3, waiting on clean-2c's body and D1. Project 6: notes-5 ← clean-4 (project 3) and notes-2/notes-3 ← design-8a (project 4, nine unwritten bodies). Publishing 2, 5 and 6 now creates Linear relations pointing at issues that do not exist — the same dangling-relation failure the placeholder-resolution gate was raised to prevent.
- Project 2's summary still reads 'The first ten, one agent at a time, is now sdk-1 · sdk-2 · mono-1a · mono-1 · mono-1b · mono-2 · mono-3 · mono-4 · mono-5 · mono-6' — written before project 1 existed. mono-1 ← ship-1 and mono-6 ← design-1, so the true serial head is ship-1 · ship-2 · design-1 · sdk-1 · sdk-2 · mono-1a · mono-1 ... The ship area's own note agrees ('ship-1 and ship-2 have zero blockers and should go before anything else in the whole roadmap').
- The installable image is outside the initiative it makes installable. Projects 1-14 are 'Spaces v1' (144 slices) and ship-8 / ship-10 — published multi-arch tags and the install docs, what CONTEXT calls the biggest adoption win — are in project 16, inside 'Extensibility'. The non-negotiable 'ship is not last' holds literally (16 of 23), but v1 completes with compose still saying build: . Move ship-8 and ship-10 into project 1 or 2 alongside mono-13a, or move project 16 ahead of project 15.
- ship-3 writes docker-compose.tls.yml in project 1 against `build: .`, and the compose files are then restructured twice — mono-13a re-points both build contexts (project 16) and ship-8 replaces the build with a pinned tag (project 16). No carry-forward criterion is recorded on either, unlike the one the merge correctly wrote for ship-2 into mono-13a ('must carry the root-start, su-exec drop and boot write-probe forward rather than restoring USER node').
- objects-4 is hitl precisely so a human pins the first sweep's flood bound (D25), and the import dep-fix adds 'objects-4's flood bound must cover a 400-row import, the second way a quiet inbox floods'. objects-4 is project 5 and import-7 is project 14 — the decision is made nine projects before the workload that motivates half of it. Either state the caps as a configurable ceiling objects-4 ships and import-7 reads, or record in import-7 that it must re-open D25.

### Orphaned references (7)

- storage-6b ← storage-6a, and storage-6a is deleted. The fold entry lists storage-6b only for absorbing docsurf-11's Source column, gone marker and Open-in-source action; it never remaps the blocker. Its acceptance text is dangling too: 'the path storage-6a built' and 'a Drive file larger than MAX_UPLOAD_BYTES is refused before the blob is written, using storage-6a's streaming guard'. Correct target: storage-6a2 (the streaming guard) plus storage-6a1 (the row), with storage-5, storage-3a, clean-2a and docsurf-11 retained.
- storage-8b ← storage-6a, and storage-6a is deleted. Not remapped anywhere in the changeLog. Its acceptance carries two more dangling references: 'files every file through the storage-6a arrival path' and 'a file whose sha already exists on the target attaches rather than duplicating, reusing the arrival module's dedupe' — the dedupe now lives in storage-6a1 (birth) and the streaming in storage-6a2. Correct target: storage-6a1 + storage-6a2.
- storage-18 ← storage-6a, and storage-6a is deleted. The dep-fix adds ai-26 + ai-12a and is silent on the dangling edge. Its acceptance says 'the stamp is written at arrival time by the storage-6a module' — and which half stamps sensitivity is a real open question, since only storage-6a1 writes the document row. Correct target: storage-6a1, with a criterion moved into storage-6a1 saying birth accepts and persists the sensitivity stamp.
- storage-2b and storage-3a still point at storage-2a after the OAuth split, but storage-2a is now only the outbound leg (PKCE, signed state, the Connect control, the authorize endpoint). Incremental scopes (storage-2b) and refresh-under-a-row-lock (storage-3a) both need the grant row, the encrypted bundle and the expires_at columns that live in storage-2a2. Both edges should be storage-2a2.
- mono-6's acceptance references a CI step design-1 abolishes: 'ci.yml runs all five gates as separately named steps: prettier --check, eslint, tsc --noEmit, the gate-5 token grep, and vitest' and 'The gate-5 step passes on a clean tree (the grep-exits-1 inversion is in place)'. After design-1 there is no grep and no fifth gate. The merge added the blocker but not the body edit.
- ai-8a's body still owns two things the merge gave to objects-3: '/dedupe stays as a redirect so existing links and the keyboard help survive' and the Today ReadoutStrip rewrite ('Dedupe inbox → /dedupe' with duplicates.length at today.tsx:313 becomes 'Review inbox → /inbox' with the combined open count). Unedited, two slices ship the same redirect and the same strip. The changeLog's prose says ai-8a shrinks to the row kind; the body on disk does not.
- Positive confirmations, so these are not re-raised: mono-13a ← mono-12 and mono-13b ← mono-11b are both correctly remapped, and all sixteen placeholder strings in the JSON (mono-workspace-scaffold, mono-packages, mono-test-db-harness, sdk-sdk-package, sdk-loader, sdk-runjob, sdk-integration-row, clean-integration-table, clean-source-class, clean-job-run-table, clean:job-run-table, clean-credential-kind, docsurf-space-filing, docsurf-document-birth, ai-suggestion-inbox, storage:document-revisions) resolve to real keys. No other slice references a deleted or never-created key.

### Size and label drift (14)

- objects-3 — S → M is the merge's biggest understatement. The body on disk is genuinely small (add objectSlug/objectSingular to entityContext, render the singular, link both sides through recordPath, two .at(0) cleanups). The merge adds on top: /dedupe → /inbox with a permanent redirect, git mv dedupe.ts → inbox.ts, listInbox() returning a kind-discriminated InboxRow[], a RENDERERS map with a payload fallback, countOpenInbox() → {open, byKind} in one grouped query, Today's strip, and 'inbox' into RESERVED. That is the whole /inbox architecture plus a route rename: L, not M. And it is afk with no design blocker while defining the row contract every later kind inherits.
- mono-11a — stays S but is no longer 'behaviour untouched'. It now owns the core.<domain>.<verb> rename across every queue created in projects 3-14, the drain-or-abandon policy for in-flight pg-boss jobs, and the 03:30 schedule row. Its acceptance ('registers the four queues', 'a document upload still extracts end to end with the same log lines', 'git diff -M shows the worker move as renames plus import-specifier lines') describes the pre-merge slice. M at minimum, and the rename arguably wants its own slice so the package move stays reviewable as a move — which is the exact argument its own body makes for splitting from the wrapper.
- sdk-2 — S → M is right for the code, but it also now ships docker-compose.split.yml and a README reference, which is ship-1/ship-3/ship-10 territory (see collisions). Either the overlay moves to ship-3, which already owns an overlay, or sdk-2's criterion is reworded to 'appends a named section to the README structure ship-1 establishes'.
- sdk-15 — still an undeclared L, and the plan says so itself. Provider HTTP client, header-driven self-throttle, bulk endpoints, response normalisation into claims, receipts, the wired enrich job, and Apollo's own error text surfaced. It heads project 18 and gates sdk-16, sdk-17, sdk-19 and sdk-25. Split at the cassette-testable provider-client seam before project 18 is published.
- import-9 — almost certainly an undeclared L, against the import area's claim of 'no L'. It writes dated rounds, investments, marks and FX across four append-only tables, surfaces missing FX rather than faking it, and first extracts the write programs out of src/lib/server/portfolio.ts (whose logic is inline in serverFn handlers) so that ai-22 can call them later. That refactor alone is a slice.
- api-1 — likely L and it is also the slice that answers D8. It stands up the first Layer and runtime on the web side (the repo has zero Layer, Context.Tag or Effect.Service today), defines the HttpApi door, mounts the versioned namespace, emits OpenAPI, and ships the first procedure. It should be hitl for D8 regardless of size.
- ship-6 — likely L. Playwright from zero: the dependency, the config, a database and DATA_DIR it creates and drops itself, a global setup, four auth specs, and a new CI job. It is also the first browser coverage the project has ever had, so there is no harness to add to.
- arrival-1 — likely L and hitl. IMAP polling, MIME parsing, the noise-refusal module, a credential of a new kind, the poll job, thread → interaction, and the participants seam — plus it carries D30 (where a forwarded mail body lives, which contradicts notes-5's move of bodies out of interaction) and D31 (the transport choice among IMAP poll, inbound SMTP and a provider webhook).
- import-11 — label unstated and it cannot be afk. CLAUDE.md names the correction policy for the append-only portfolio tables an open decision and says 'don't add mutation paths casually'; import-11 is that door, and ai-22 inherits it. hitl.
- clean-2c — label unstated. The backfill author's own reasoning for the credential.kind decision was 'this is one of the four ownerless decisions the audit says to answer before publishing, which is why that slice is hitl rather than afk'. It also rebuilds a unique key on live rows. hitl.
- arrival-4 — label unstated and it carries D32 (headless browser in the default image), which changes the published image. Cannot be afk.
- backfill-5 — a new suggestion-chip pattern on the record rail with no design blocker, while the merge routed docsurf-5, ai-8a, ai-17, notes-2, notes-3, docsurf-9 and sdk-20b through design-2/4/6/8. Its own open question notes DESIGN.md's Micro-interactions sheet has four proposals and none is a chip carrying an action. backfill-5 ← design-2 (and design-10 if the chip animates), or state explicitly that it is an inert mirror of a shipped control.
- import-2 and arrival-8 add routed surfaces (/import, the feed surface on a space and record page) with no design-6 edge, while docsurf-5 and ai-8a were given one so that 'a nav row is data with a collision test instead of a hand audit'. NAV_ITEMS still groups by index arithmetic (slice(0,4)/slice(4,7)/slice(7)) until design-6 lands, so any insert that is not at the end silently moves a page between groups.
- storage-11b and storage-11c carry asserted sizes with no bodies — the plan admits the prose was truncated. Do not treat their sizes as spot-checked; the gone-pointer half looks S and the resurrection half (app-side tombstone plus expired-cursor re-list, tested against each other) looks M.

---

## 5. Scale and what to cut

230 slices across 23 projects, 144 of them inside the initiative that is supposed to be v1. Of the 150 surviving original slices the split is 54 hitl / 96 afk and 106 M / 42 S / 2 declared L; adding the relabels (objects-4, clean-5, ai-15, mono-13a to hitl; notes-3 to afk) and the new areas' own hitl slices puts the plan at roughly 80 human decision points and, at M ≈ 200-500 changed lines, somewhere around 70,000-90,000 changed lines across 230 gate-passing PRs. That is a backlog with an order, not a commitment. It is also demonstrably not schedulable as written: three of the projects the plan says to publish now have blockedBy edges into projects it says are not ready, 80 of the 230 slices have no body, and two of the six framed decisions that gate the first two projects (D13 published identity, D14 rename depth) are unanswered. The honest framing is that projects 1-9 — ship polish, the worker spine and workspace, provenance, the design port, custom objects and the inbox, notes, documents into spaces, the shelf and the byte lanes, and views — are about 81 slices and a real commitment; everything from project 17 onward (70 slices of plugin SDK, Apollo, install-from-the-app, storage sources, bound data rooms, the archive, and the researcher/syncer/recorder/feed lane) is an ordered backlog whose first slice should not be scheduled until a user has asked for something in it. Two structural notes on shape: project 10 (15 slices) and project 12 (14) are above the 7-15 band's top and both mix substrate with surfaces; and the plan's own risk — five slices from three areas rewriting one 234-line CTE — is now spread across projects 7, 11 and 12 rather than serialised into one, which the views-3 note half-acknowledges by keeping its text box out of the fusion.

**Cut first, in order:**

- Project 22 in full (storage-13 through storage-19b, 9 slices) — the plan's own summary says 'Half of this is speculative until a real user asks — treat it as a backlog with an order.' Take it at its word and stop the storage arc at project 21. That also removes storage-19a/19b, whose deliverable is a git diff --stat proving the port abstraction held: valuable as architecture validation, worthless to a user, and unbuyable at two slices before a second provider is asked for.
- Project 23 in full (8 slices: backfill-11, backfill-12, arrival-5 through arrival-10) — every slice needs OAuth, the loader and the fakes, which is three projects of prerequisite for a calendar sync. Keep arrival-1 through arrival-4 (project 13), which need none of that and are the channel CONTEXT sequences first. Cut the rest to the backlog with arrival-8's D33 recorded so the feed tables are not built twice later.
- ship-12 (PaaS templates) — the ship area names this itself as the one slice that could be dropped without leaving a contract unimplemented: it is a CONTEXT Hosting bullet, not a locked decision. Cut it, not ship-11.
- import-10 and import-12 — the only two slices in project 14 gated on the SDK (import-10) or unspecified in shape (import-12, D42). The pipeline's value is projects 14 milestones 1-3; the Airtable dialect proves an abstraction nobody has asked for yet, and export should be one slice re-scoped after a user asks to leave.
- ai-27 (judgment memory) and ai-9b (local embeddings) — both are second-order: ai-27 is an assembler mode nobody has asked for, ai-9b is a keyless alternative to a lane that already works with a pasted key. Keep ai-9a's sensitivity argument, which is what makes ai-9b additive later.
- sdk-18 and sdk-19 (LISTEN/NOTIFY to SSE, enrich-on-create) — polish on an enrichment arc whose first real tenant (sdk-15) is still an undeclared L. A cell that resolves on refresh is acceptable until someone complains.
- If more must go: project 19's ship-9 and backfill-13 (plugin release tags and plugin upgrade). Nothing can be released or upgraded until a plugin exists that someone outside the repo wants, and both are cheap to add the week that happens.
- Do NOT cut: ship-1 through ship-5 (project 1), design-1 through design-10 (projects 1 and 4), views-1 through views-5 (project 9), or mono-4/mono-5 (the test database). These are the four things the first audit was right about — the box has to install, the surfaces have to be born ported, the lists have to leave the browser, and 150 unattended agent runs are unsafe against the dev database.

**Verdict**

The merge did what merges do: it fixed the nine named duplicates and introduced a new generation of them at the seams between the seven areas that could not see each other. Structurally the graph is in better shape than the prose claims and worse shape than the readiness note admits — exactly one backward cross-project blockedBy edge exists (sdk-24b ← arrival-8), all sixteen placeholders resolve, and no slice key is referenced that was never created; but three live edges still point at deleted storage-6a (storage-6b, storage-8b, storage-18), three acceptance bodies cite it by name, and the two OAuth-split consumers (storage-2b, storage-3a) point at the half of storage-2a that no longer contains what they need. The worse class of error is the one a graph check cannot see: four dep-fixes write content into slices that cannot hold it — mono-7 (project 2) is told to move files import-1/import-8 create in project 14 and a fixture views-2 creates in project 9, and mono-9c (project 2) is told to add a queue import-6 creates in project 14, in direct contradiction of its own acceptance criterion. Of the 34 originally-missing decisions, 33 now have a carrier; audit #32 (nightly conformance against real provider sandboxes) has none, #31 (changesets) is half-covered by two tag-triggered publish jobs, and #22's two hand-back acceptance edits were dropped in transit. Beyond the 34: MIS + runway lens is absent from both the plan and backfill-14's four-item deferral register, DESIGN.md §5 has no owner, and nobody rewrites CLAUDE.md gate 5 or mono-6's grep step after design-1 abolishes them. The two non-negotiables hold on the surface and leak underneath — design is project 4 ahead of the surface-adding projects, but the one slice the merge turned into a surface owner (objects-3) is the only new surface without a design blocker, while ai-8a keeps the blockers it no longer needs; ship is project 1 and 16 rather than last, but the installable image sits outside the v1 initiative and the 'first ten, one agent at a time' list still starts at sdk-1 when mono-1 is blockedBy ship-1. My three highest-priority fixes before anything is published: (1) do not publish projects 2, 5 and 6 — all three have edges into unpublished projects 1, 3 and 4, which is the dangling-Linear-relation failure the placeholder gate was raised to prevent; publish project 1 first, which means writing ship-1..5 and design-1/design-3's bodies and answering D13 and D14. (2) Resolve the three-way match-only-resolve collision (import-5, storage-9, arrival-2) and the three-way blob-ownership collision (backfill-3, import-2, backfill-9) now, in the bodies, because both are the first-pass failure repeating one layer down. (3) Fix objects-3: it is an L labelled M, afk while owning a new surface's row contract, and it inherited the design dependencies ai-8a is still holding.

---

## 6. Readiness (the merge's own account)

Structurally this is publishable: 230 slices across 23 projects in two initiatives, every project between 7 and 15 slices, every milestone demoable, all sixteen placeholder blocker strings resolved to real keys, twenty of the twenty-nine recorded dependency corrections applied and nine dropped as already handled by the collision resolvers. The two non-negotiables hold — design lands as project 4, ahead of the ten projects that add roughly forty surfaces, and ship is split so the rename is project 1 (mono-1 is blockedBy ship-1) and the published image is project 16 rather than last. The six previously ownerless decisions now have carriers in slices that are hitl for that reason: source_ref in clean-3, the view discriminator in views-1, the filter evaluator in views-2, credential.kind in the new clean-2c, the citation grammar in ai-5, and run-vs-job_run in clean-2b. What is left is mostly writing, not deciding: 80 of the 230 slices reached me as key, title, type, size, blockedBy and demo only — every ship, design, api, arrival, views, import and backfill slice, plus clean-2c, import-11 and import-12 — so their what-prose, acceptance criteria and specRefs must be written into research/roadmap-slices-2026-09.json before those projects become Linear issues. Three gaps I could not close and am handing back: storage-11b's and storage-11c's bodies were truncated in my input (keys, seam and chain order survived, the prose did not), the same truncation cut C3's docsurf-9 body mid-sentence, and sdk-15 remains an undeclared L that the audit flags and no resolver addressed — split it at the provider-client seam before project 18 is published.
