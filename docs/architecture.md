# Architecture

How Spaces is put together now: what it models, the domain language, how the code is laid out, and where to look. Decisions and their reasons are in `docs/decisions.md`; build mechanics and the gates are in `CLAUDE.md`; the plugin contract is `docs/spec-plugin-sdk.md`; the design system is `DESIGN.md` and `docs/design-contract.md`.

## What it is

A self-hosted deal-management system for angel investors and small funds: one investor by design, up to about fifteen users on one deployment. Two halves on one graph:

- **Research** — spaces, notes and memos, documents, glossary. Slow and exploratory.
- **Deals** — companies, people, deals, interactions. Fast and structured.

A company entering the pipeline already carries the research filed against its spaces. On top sits a **portfolio layer** (rounds, checks, ownership, marks, returns). Everything is BYOK — models, enrichment, storage — and nothing phones home. Opinionated for investors, not a horizontal CRM: that constraint is the product.

- **Why self-hosting wins here:** funds won't put deal terms, decks and cap tables in someone else's SaaS; local models (Ollama) keep confidential decks off third-party APIs; enrichment terms sit between the operator and the provider, not with us; the schema is open.
- **Non-goals:** a hosted SaaS for now (recorded intent, gated on its own design and security pass), stranger-tenancy isolation (RLS) until then, LP reporting, portfolio MIS collection, mobile, sequences, dashboards and workflow automation.
- **License:** AGPL-3.0; it can be relicensed permissively later, never the reverse once contributors arrive.

## System shape

```
Browser ── server functions ──┐
                              ├── Postgres 17: data · jobs · search · vectors · plugin schemas
Worker ── jobs · plugins ─────┘
                              └── ./data: blobs (local or S3) · secret.key · plugins/
```

- Two Node processes (web, worker), one database, one `./data` directory. Production is three containers, web app, worker and Postgres, all but Postgres from one image; `ROLE=all` runs web and worker in one container for single-container hosts. TLS comes from an optional Caddy overlay.
- Required env is `DATABASE_URL` and `APP_URL`. Migrations run at boot. Backup is the database and `./data` together, or neither.
- **Plugins are not in the image.** They install from the running app into `./data/plugins`; only the worker runs them, and they write only through the SDK's ports. The web process reads their manifests and never runs their code. Contract: `docs/spec-plugin-sdk.md`.

| Layer      | Choice                              | Why                                                                                                                |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Framework  | TanStack Start + React 19           | server functions, typed routes and typed search params for saved views                                             |
| Database   | Postgres 17 + Drizzle               | one service for relational data, jobs (pg-boss), search (tsvector, pg_trgm), hierarchy (ltree), vectors (pgvector) |
| Auth       | Better Auth                         | self-hosted sessions                                                                                               |
| Editor     | BlockNote                           | block editing; JSON is authoritative, markdown derived                                                             |
| Table      | TanStack Table                      | headless grid; the hardest UI, owned                                                                               |
| Storage    | local FS or S3                      | content-addressed sha256 blobs; presigned PUTs; the worker re-verifies digests                                     |
| Extraction | unpdf · mammoth · fflate            | in-process on the worker                                                                                           |
| UI         | Tailwind 4 + Radix                  | the Instrument design system (`DESIGN.md`)                                                                         |
| Validation | Effect Schema at boundaries         | hand-written, so validators carry business rules; zod is leaving                                                   |
| Backend    | Effect v4                           | typed errors; Layers are the plugin port model and per-job privilege; never crosses into React                     |
| AI         | core substrate over AI SDK adapters | `complete` and `embed`, lanes routed by sensitivity, propose-only writes, embeddings pinned at one dimension       |

Doctrines: append-only where history is information · machine writes are suggestions, never silent · structure fixed, content free · plugins feed the graph, never extend the product · a storage source is not the blob backend.

## Packages

```
apps/web        @spaces/web     the app: routes, server functions, components
apps/worker     @spaces/worker  pg-boss host, jobs, the plugin loader
apps/e2e        @spaces/e2e     Playwright: the browser suite and the screenshot pipeline
apps/site       @spaces/site    marketing and operator docs (Astro on Vercel, never in the image)
packages/db     @spaces/db      drizzle schema, migrations, ENTITY_REFS, heartbeat, runMigrations
packages/core   @spaces/core    the domain: pure logic, and writes/ (the only db-coupled half)
packages/sdk    @spaces/sdk     the plugin contract: manifest, ports, testing kit, build, packer
packages/config @spaces/config  tsconfig base, eslint base and rules, prettier base
plugins/*                       apollo, box, exa, gmail, google-calendar, google-drive, granola, rss, airtable
plugins/_fixtures/*             test plugins for the loader and the ports
docker/                         Dockerfile (turbo prune) and the entrypoint
deploy/                         one-click templates: coolify, railway, render, unraid
scripts/                        backup.sh, restore.sh, screenshots
```

What the less obvious packages hold:

- **core `writes/`** — the attribute engine and seed, the identity write path (resolve, merge, sweep, delete, rename, provenance), the view store, chunk sources, the BYOK vault, the blob backend, the graph's read half (MCP's `get_record`, entity search, the lexical fused search with `canReadNoteSql`), the interaction writer (row, body note, edges, dedupe by `message_id`), document birth, intake and prepare, `proposeProgram` (a partial unique index makes an identical open integration proposal a no-op), the db-coupled context assembler, and boot (`writes/boot.ts` with the starter taxonomy; `apps/web/src/db/boot.ts` is the process shell that runs it).
- **core ports** (`writes/ports/`) — Layer constructors over the bound `integration` row: Config, Secrets, Log, Http (with a per-process throttle), Read, Identity, Receipts, Content and the rest. Provenance (`source_ref`, `enrichment_record.integration_id`, `signal.source_class`) comes from the row, never the plugin. Work a port hands back goes through core's `Enqueue` service (`@spaces/core/queue/enqueue`); the worker's Live is `apps/worker/src/plugins/enqueue.ts`, the web's `webEnqueue` in `lib/enqueue-live.ts`.
- **core pure half** — also the context ranker, ref grammar and renderer (`context/`), `canRead` (`read-policy.ts`) and the `SimilarLane` service tag, whose one live Layer is `apps/web/src/lib/ai/similar.ts` beside the embedding pin.
- **sdk** — the manifest (`manifestSchema`, `defineManifest`), `SDK_VERSION` and `satisfiesSdk`, `definePlugin`, the port tags and `@spaces/sdk/testing`, the identity-key normalizers (`@spaces/sdk/identity`, imported by core and web too), the plugin build (`@spaces/sdk/build`) and the packer (`@spaces/sdk/pack`: ustar + ed25519). Core's `plugins/verify.ts` is the other half of the packer; `registry.json` and `plugin-keys/` are copied into the image.
- **db** — the column owns the type: a jsonb payload's shape lives beside its column and app modules re-export it. `runMigrations()` is a library function core's boot composes (migrate, seed system attributes, seed the starter taxonomy, reconcile value indexes); the schema package never grows a seed, or it would depend on the product. The migrations folder resolves from `import.meta.url`, never cwd. Drizzle records each applied migration as `(hash of the .sql, created_at = the journal's when)`, which is what the downgrade guard compares.
- **worker `plugins/`** — boot reconciles enabled `integration` rows against `<dataDir>/plugins/<id>/current/` before any queue registers; a `node:module` resolve hook (`host-resolve.ts`) hands a bundle's bare `effect` and `@spaces/sdk` imports the worker's own copies, which is why the worker build leaves `@spaces/sdk` external.

Boundaries, enforced by eslint zones in `packages/config`: `db` imports nothing internal; `core` reaches `db` for values only inside `writes/`; `sdk` imports nothing internal; the worker reaches `apps/web/src/lib` only through the `#web/*` alias, for modules not yet moved into core; `site` and `e2e` import nothing internal. In `apps/web`, `#/` means `apps/web/src`.

## How a request flows

**Route → server function → core → database**, with anything slow or CPU-bound queued to the worker.

1. **Routes** — `apps/web/src/routes/`, file-based. `_app.tsx` is the authenticated shell; `_app/` holds one file per surface (`today`, `spaces`, `companies`, `people`, `deals`, `portfolio`, `notes`, `files`, `meetings`, `tasks`, `mandate`, `review`, `ask`, `import`, `settings/*`). A trailing `_` (`companies_.$companyId`) is a detail page outside its list's layout. Custom objects share `o.$objectSlug` and `o_.$objectSlug.$recordId`. `api/` holds the server routes: health, auth, blob, MCP, the external `v1` API, webhooks, OAuth connections, job status.
2. **Server functions** — `apps/web/src/lib/server/`, one file per domain. Auth checks live here, never in the client. `lib/server-fns.ts` is a client-imported barrel: server functions and types only.
3. **Core** — `packages/core/src/`. Everything outside `writes/` is pure and unit-tested: the attribute registry, portfolio maths, the context ranker, the view compiler, date parsing, `canRead`. `writes/` holds the db-coupled half: the attribute write path, identity (resolve, merge, sweep), documents, interactions, the vault, the blob backend, the plugin ports, boot.
4. **Database** — `packages/db/src/schema/`, one file per domain. Migrations generate into `packages/db/drizzle/`.
5. **Worker** — `apps/worker/src/`. `index.ts` registers every queue and runs each job through `run-job.ts`; jobs live in `jobs/` (extraction, embeddings, deck reading, summaries, attribute runs, mailbox and storage polling, sweeps, import commits). `plugins/` loads installed plugins at boot.
6. **Components** — `apps/web/src/components/`: `ui/` primitives, `table/` and `attributes/` (registry-driven tables and fields), `record/`, `editor/`, and one folder per feature. Tables are spreadsheet-grade (inline typed edit, resizable and reorderable columns, keyboard navigation) and saves are optimistic.

Data on a page comes from its route loader, which calls server functions; a save calls a server function, then `router.invalidate()` re-runs the active loaders. TanStack Query serves client-driven fetches (the sidebar, Cmd-K, infinite lists).

## Backend paradigm

A typed effect-system backend over one relational coordinator.

1. **I/O is Effect** (D84). A module that queries, writes, fetches or enqueues is built from `Effect.fn` programs; pure helpers, type modules, validator shapes and client code stay plain. Effect never crosses into React: the seam is `effectFn()` for server functions and HttpApi handlers for the external door.
2. **Effect Schema is the schema language** (D85). Server-fn inputs go through `input(schema)`; zod leaves file by file.
3. **The external door is `effect/unstable/httpapi`** (D8): one definition, OpenAPI out, at `/api/v1` (D27, `docs/api-versioning.md`). `effect/unstable/rpc` is the native answer if a typed client from one definition is ever wanted internally. No oRPC, tRPC or GraphQL.
4. **The internal interactive path is server functions**: in-process and typed end to end. An operation that must be callable from outside is born on `/api/v1`.
5. **Seam rules.** A server function never does slow work (more than ~200 ms, or any external API): it enqueues and returns. Workers write through the same one-write paths (`setValues`, `resolveEntity`, suggestions) as the typed actor `integration`. UI freshness comes from invalidation; the one push channel is the job-status stream (D64).
6. **pg-boss is the queue and Postgres the only coordinator**: queue, staging, cursors, vectors and full-text in one database. No Redis until a measured reason.
7. **Gating.** No row, no feature: an integration with no `integration` row, or a feature with no key, is absent, not dormant. External extensibility is MCP, webhooks and the API, for anything that is not an ingestion plugin.
8. **Dual-end doctrine.** Postgres is the only mandatory dependency; scale is replicas of the same processes; capabilities, never forks; no new global state, so tenancy stays cheap.
9. **One write path, enforced by lint**: `no-restricted-syntax` bans writing `entity.values` outside `setValues`.

## Stack choices

- **TanStack Start over Next.js.** The app is almost all authenticated, interactive UI, so React Server Components buy little. Start gives one data model (TanStack Query plus server functions, including rapid cell edits with optimistic rollback), typed and validated search params (a saved view is serialized filter, sort and column state), plain Node output from Nitro's `node-server` preset, and a worker that is just a second Node process. Accepted costs: thinner docs, more churn, a smaller contributor pool. Do not relitigate without new information.
- **One language.** No Rust or Go service: for 1–15 users the bottlenecks are Postgres, mail and model calls. CPU-bound extraction is solved by splitting the process, not the language; a job that truly needs native speed becomes a sidecar, preferably an existing binary (Ollama).
- **Postgres does everything**: relational data, jobs (pg-boss), full-text (`tsvector`), fuzzy names (`pg_trgm`), hierarchy (`ltree`), vectors (`pgvector`), `unaccent`. No Redis, separate vector database, Elasticsearch or Trigger.dev until a measured reason. Not SQLite: it lacks those extensions and concurrent sync workers.
- **Editor: BlockNote** on ProseMirror, for Notion-grade block UX. `note.body_json` is authoritative; `note.body_md` is derived on every save (BlockNote's markdown export is lossy) and feeds search, embeddings and export, with mentions written `[[Label|entity:uuid]]`. Mentions are inline-content nodes `{entityId, label}`; links sync from the JSON, never from markdown. The escape hatch, if the glossary fights BlockNote, is its TipTap layer. TipTap core and the mention extension are MIT; nothing here uses the paid Pro extensions or Hocuspocus.
- **Grid: TanStack Table + TanStack Virtual**, DOM-based. Not AG Grid (its useful features are enterprise-licensed, poison for AGPL) or Glide (canvas makes editors and accessibility painful at ~2k rows).
- **Auth: Better Auth** with the `tanstackStartCookies` plugin and the Postgres adapter. Not Clerk or Auth0: a SaaS dependency kills self-hosting.
- **Smaller picks.** Cmd-K is `cmdk`. URL clipping is `@mozilla/readability` plus `linkedom` (not jsdom: ten times the weight). Glossary auto-link is a hand-written Aho-Corasick over the space's terms. LLM calls go through the Vercel AI SDK, keyed from the vault.
- **Pins.** No `latest` specifiers; upgrades are deliberate. `packageManager` in the root `package.json` is the only place a pnpm version lives: corepack in the Dockerfile, CI and lefthook all resolve from it.
- **Frozen old names.** Three strings keep the product's earlier name on purpose: the `'dealos:better-auth-secret'` HKDF label (a key-derivation input), the `dealos.*` localStorage prefs keys (changing them resets layouts) and the `dealos-glossary` ProseMirror plugin key.
- **License: AGPL-3.0.** It can be relicensed permissively later; the reverse is impossible once contributors arrive.

## The domain model

**Two halves, one graph.** The research half (spaces, notes, documents, glossary) is slow and exploratory, with no pipeline and no stages. The deal half (companies, people, deals, interactions) is fast and structured. Most tools do one well and fake the other; the seam is the product: a company entering the pipeline already carries the notes, sources and contacts filed against its spaces.

### Workspace and access

- One investor is the design target, with up to about fifteen users on one deployment. Today there is one workspace (a singleton row); several workspaces per install is decided, not built (see _Team, auth and tokens_).
- First-run signup is open only while no user exists, gated by a setup token printed to the logs; after that, invites only. Setup ends on `/today` (Start empty) or `/spaces` (Load demo data).
- Roles are `admin` and `member`. Every read goes through `canRead`, every mutation through `canWrite` (see _Team, auth and tokens_).
- **Enforcement details.** The setup token and invite checks live in the Better Auth database hook, not in routes, because the public signup endpoint would bypass a route check. `canRead` is enforced in SQL wherever a title or body could surface (lists, search, the space page, autocomplete); a private row reads as "not found", never 403. Visibility is its author's alone: not even an admin flips someone's private note. `updateAttribute` is admin (it reshapes shared vocabulary); `createAttribute` stays member. `setValues` reads the row `FOR UPDATE`, so two partners editing at once never lose each other's edits.

### The entity graph

- Everything linkable is an `entity` with a fixed kind: `company`, `person`, `deal`, `space`, `note`, `document`, `term`, or `custom` (a custom object's record, told apart by `object_id`). Each kind has a side table: `company` and `person` are markers only (their values live in `entity.values`); `space(parent_id, slug, path, is_seeded)`; `note(title, body_json, body_md, tsv, kind, author_id, visibility)`; `document(blob_sha, filename, mime, kind, source_class, source_ref, extracted_text, tsv, extraction_status, …)` with `document_chunk(idx, text, embedding)`; `term(name, aliases, definition_md, space_id)`. A document's or note's `entity_id` is its own identity; what it belongs to goes through `link`.
- One edge table, `link(from, to, relation, attr_slug, source)`, relations `mentions`, `tagged_in`, `derived_from`, `supersedes`, `references` (and the retired `contact_at`, which nothing writes). Real FKs on both sides. Typing `[[Orbital Composites]]` in a note writes a link, so backlinks come free.
- **Record references materialize into the graph.** The uuid in `values` is the truth; every reference write syncs a `link(references, attr_slug)` in the same transaction, unique on `(from, to, relation, attr_slug)`. Backlinks, rails, inverse relationships (D69) and merge all read one graph.
- **Filed vs referenced**, never conflated:

|                        | meaning                                                   | mechanism                             |
| ---------------------- | --------------------------------------------------------- | ------------------------------------- |
| Filed in a space       | you put it there                                          | `entity_space`                        |
| Filed against a record | it belongs to this company, person, deal or custom record | `link(tagged_in)`                     |
| Referenced             | the body happens to mention it                            | `link(mentions)`, diff-synced on save |

- Space membership goes through `entity_space` for every kind, because it carries `source` (`manual | ai | inherited`) and `confidence`, which is what lets an AI suggestion wait in Review instead of being written.
- Rejected shapes: a nullable FK per type, and an untyped `(src_type, src_id)` pair.

### Objects and attributes

- **Two tiers.** Companies, people and deals are system objects; users can create custom objects as attribute bags: an `object` row (slug, singular and plural nouns), records as entities carrying `object_id`, the full attribute engine, references both ways, registry-generated routes. Every object gets spaces tagging, mentions, notes, search, activity, fuzzy-name dedupe and merge. A custom object may declare `domain` or `linkedin` identity keys at creation, which creates the backing attribute in the same transaction through `createAttributeProgram` (an ordinary `is_system: false` attribute, not seeded). Enrichment, interactions and seeded attributes stay with system objects. There is no fourth system object: a user models co-investors as companies or a custom object.
- **Unified storage.** Every value, system or custom, lives in `entity.values` (jsonb, keyed by slug) and changes only through `setValues`, which validates per type, writes `attribute_event` and syncs reference links in one transaction. Never attributes: `kind`, `canonical_name`, `merged_into_id`.
- **The type menu is fixed**; users define attributes, never types: text, number, currency, date, checkbox, select, multi-select, status (options carry a group: active, parked, closed), domain, email, url, phone, rating, record reference, actor reference. The engine grows by release (descriptions, then timestamp, then structured location; formula deferred); objects don't. A custom attribute that proves universal is promoted to system in a release.
- **System attributes** (`SYSTEM_ATTRIBUTES` in the registry) are non-deletable and never archivable (D69). Company: description, business_model (multi-select), funding_stage, location, founded_year, domains (identity), linkedin. Person: first_name, last_name, job_title, description, location, twitter, phone (multi, E.164), emails (identity), linkedin, companies (D60). Deal: stage, value, company (required, single), people, owner, close_date, source, close_reason, referred_by. Enrichment-fed fields arrive linked to the enrichment vocabulary (D76), never as empty boxes.
- **A person's name has two parts.** `canonical_name` stays a column; `setValues` keeps it the join of `first_name` and `last_name`, and a whole name splits on its last space.
- **Identity is a unique attribute** (D75). Each element of an identity value is claimed in `entity_alias` before the value is written, inside a savepoint: an element another record holds is left out of the value and raised as a `duplicate_candidate`, while the rest of the patch writes, so the stored array and the aliases never disagree. Elements are stored as written and compared on the identity normal form. On an identity-key attribute, a value that normalizes to null ("gmail.com") is refused. Clearing or changing a value retires its claim. Name aliases are history and never retire; identity aliases are claims and do. A merge unions both sides' arrays on the survivor.
- **History.** `attribute_event(entity_id, attr_slug, from, to, actor_type, actor_id, actor_ref, source, suggestion_id, batch_id, refs, at)`, one row per change in the value's transaction. `actor_type` is `user | integration | system`; `actor_id` (a user FK) and `actor_ref` (an integration FK) are each set iff their type. Stage history is `attr_slug = 'stage'`, so time-in-stage comes free. `activity` holds macro verbs only (created, merged, tagged, note created). Condensing a burst ("changed 8 attributes") is read-time display. `refs` is a jsonb payload; `suggestion.refs` is a `text[]` of context ids filtered with `= ANY(refs)`; "what did this import write" is the indexed `batch_id`.
- **Indexes.** Attributes flagged filterable or sortable (`attribute.filterable` and `.sortable`, real boolean columns set by one control) get an expression index from the reconciler, never from a migration (see `CLAUDE.md`). The index is composite, `(object_id, <expression>)`, because list reads pass the object id as a bind parameter and a partial index on a literal id is unusable by a generic plan. It buys the sort, not the filter: conditions are wrapped in `coalesce(…, false)`, which the planner cannot match through. Only `deal.stage` is flagged at seed. The registry generates the UI: table columns, create fields and the record rail all read it.
- **Machine writes.** The line is the kind of claim, not the vendor: a sourced fact may fill an empty field; anything generated, or anything that conflicts with what a person wrote, waits for a person. Deterministic facts (an enrichment lookup with its receipt in `enrichment_record`) write fill-blanks-only through `setValues`; a conflict with a person's value becomes a Review card. Generated judgment (AI classify, summarize, prompt) goes through the `suggestion` table; accepting writes with the accepter as actor; a dismissal persists. AI-enhanceable types are text, select, multi-select and number; never status (the funnel is judgment), currency, references or identity types. AI attribute runs are manual (per cell or column). The context builder goes through `canRead`, so a private note never reaches a prompt whose suggestion a teammate reads.
- **The classification boundary.** A space answers "could I write a memo about it and track companies in it?": where a company competes and how. Industry and sector are never attributes. An attribute is a property of the business true in any market (B2B or B2C, hardware, capital intensity). Cross-cutting is tagging, not the tree: `entity_space` is many-to-many. The one seeded facet is company `business_model`. No sectors or categories attribute ships, ever.
- **Doctrine: structure fixed, content free, defaults curated.** Object kinds, the type menu, identity rules and the engine's shape are code. The space tree, custom attributes and every seeded attribute's options are the user's vocabulary. The litmus test is guidance in docs and seed data, never validation.

### Identity, resolution and merge

- **Deterministic auto, probabilistic suggest.** Identity comes only from deterministic keys: a company's domains, a person's emails, and a custom object's declared `domain` or `linkedin`. An exact key match auto-attaches. A fuzzy name match only suggests: no threshold is safe ("Stripe" the payments company and "Stripe" the agency). Fuzzy matches feed Review; a person decides.
- **One choke point.** `resolveEntity({ kind, keys, name?, source })` is the door every creator uses: manual create, deck upload, `[[mention]]`, URL clip, plugins, mail, import. Exact identity key → alias → create; fuzzy runs after and only writes `duplicate_candidate` rows.
- **Tables.** `entity_alias(entity_id, kind: name|domain|email|linkedin, value, value_norm, is_identity, source_class, source_ref)` with a unique partial index on `(kind, value_norm) WHERE is_identity`; name aliases are never identity and never unique. `duplicate_candidate(entity_a, entity_b, score, reason, status: open|merged|dismissed)`: a dismissal persists forever, or the sweep would re-suggest the pair. `merge_event(winner_id, loser_id, merged_by, snapshot, unmerged_at)`.
- **Normalization.** Domain → registrable domain (eTLD+1), lowercase, no `www`; free-mail domains never create or match a company. Email → lowercase exact, with Gmail dot and `+tag` stripping for matching only; role prefixes are never person identity (D75). Name → unaccent, lowercase, legal suffixes stripped, for `pg_trgm` only.
- **The organic dedupe engine.** An identity alias that collides with the unique index never errors: it becomes a `duplicate_candidate` with `reason: { shared: 'domain', value }`, so enrichment finds duplicates as a side effect. Two entities that legitimately share a domain flip `is_identity` off on one alias.
- **Fuzzy sweep.** `pg_trgm` over name aliases at create and in a nightly sweep, bounded (D25); an exact normalized-name collision outranks a trigram score.
- **Merge repoints at write and resolves nothing at read.**
  1. Every entity-referencing column is declared in `ENTITY_REFS` and the executor iterates it; every moved row goes into `merge_event.snapshot` as `{ table, pk, old_value }`.
  2. The loser's aliases move to the winner as `source_class: merge` with `source_ref` cleared, identity flags intact.
  3. Values: the winner keeps its own, the loser fills the winner's nulls, conflicts stay with the winner and land in the snapshot.
  4. The loser row survives with `merged_into_id`, so stale URLs redirect; chains flatten at write. Duplicate links dedupe on repoint.
- **Unmerge** would clear `merged_into_id` and replay the snapshot backwards; data created after the merge stays with the winner. The snapshot ships; no unmerge executor exists yet, so the snapshot convention is the contract. Any member can merge; the UI previews what moves.
- **Delete walks the registry too.** `ENTITY_REFS` carries a `del` strategy per column: `cascade`, `block` (refuse with a reason), `orphan` (null the column, keep the row) or `none`. `merge_event.winner` and `.loser` are `block` (history is information); `entity.merged_into` blocks while a loser still redirects; `mandate.note` blocks.

### Research

- **Spaces** are the investor's own market taxonomy: an ltree hierarchy plus many-to-many tagging (`entity_space`). The hierarchy decides where a memo files; tagging handles the cross-cutting. Membership is orthogonal to the pipeline: a company sits in a space whether or not a deal exists (tracking, not evaluating), and tags outlive deals. AI-suggested tags land as `source: ai` in Review, never written. Spaces are malleable (D73) and watched by research engines (D72) and feeds (D87). Slugs are unique per parent, not globally (`path` is globally unique by construction; roots get a partial index). The empty /spaces page is a markets creator ("What markets do you look at?"), so a user thinks in spaces from minute one.
- **The seed taxonomy is tiny**: a handful of example nodes, never a curated ontology (no NAICS or SIC). Depth is earned: nobody creates a node before they have companies and a memo for it. `is_seeded` stays as provenance; there is no seed reconciliation. The starter taxonomy seeds on first boot only, so a node the operator deletes stays deleted. First boot is answered by the opt-in demo seed, offered at setup, guarded on no companies existing, and created through `resolveEntity`.
- **Notes.** One table, one editor, three orthogonal axes: _where_ it is filed (`entity_space` for a space, `link(tagged_in)` for a company, person, deal, custom record or the mandate; zero or more places), _what_ genre (`note.kind`: `note` or `memo`, D83), _who_ reads it (`visibility` plus `author_id`; `shared` by default). A memo is a note with the flag up: it pins to the top of wherever it is filed and can be a space's face. Kind never restricts filing; genres such as teardown or IC memo are templates, not kinds; tags that encode where a note lives are rejected. A space holds as many filed notes as the user wants. The deal memo scales `close_reason` → note → memo, the same row promoted.
- **Deleting a note is hard; there is no trash anywhere.** `deleteNote` runs the registry executor: the note, its entity, every link both ways, `entity_space` and `activity` go; what the note fed survives (a document `derived_from` it keeps its blob and text). A private note someone else wrote answers "Note not found".
- **Glossary.** Terms are scoped to a space and inherited down the tree, auto-linked in note bodies at render (hover shows the definition). The same matcher runs on note save and after document extraction, diff-syncing `link(… → term, mentions, source: extracted)`; a deliberate `[[PUE]]` stays `manual` and ranks higher. A term has a page: definition, space, every note and file that mentions it, the companies reached through them, co-mentioned terms. A concept never holds things (no memo, no filing, no tracking); a term can be promoted to a subspace, never the reverse.
  Auto-linking is a ProseMirror decoration, never document content, reached through BlockNote's `_tiptapOptions.extensions`; matching is whole-word and longest-wins with no stemming; terms inherit down the tree, never up; the term set is captured when the editor mounts. `@tiptap/core` and `@tiptap/pm` are pinned to BlockNote's exact version, because two ProseMirror copies break plugin keys.
- **Documents** are entities in their own right, hashed in the browser, uploaded by presigned PUT, text-extracted by the worker. A saved article is a document too (fetched and readability-extracted into the same pipeline), so one search covers decks, mail, notes and articles. Documents file exactly like notes, `tagged_in` a record and `entity_space` a space; a document filed into a space is a source. No folders and no nesting: kind, filed-against and space are the three axes a folder tree encodes, and one file can be filed in N places. `document.kind` is a closed genre enum (`deck · dd · cap_table · legal · article · other`) with code consumers; an exported memo PDF is `derived_from → note`. Documents carry `visibility` and `author_id` (D67). Provenance columns: `source_class`, `source_ref`, `source_path`, `external_id`, `external_url`, `external_status`, `connection_id`, with a unique `(connection_id, external_id)` that write-through loop prevention and cursor re-lists rely on. An unfiled document waits on the Files shelf.
- **A storage source is not the blob backend.** Drive and Box are the fund's archive and an arrival channel; our blob plus its derived layers (text, chunks, vectors, page images, the extraction cache, term links, all keyed by sha and rebuildable) are the index and the AI's working set. The AI reads only the derived layers, so byte retention is per binding (`retain: full | text`, D38). Where our bytes live is always `STORAGE_DRIVER`.

### Deals, mandate, templates

- **One deal is one opportunity (a round or instrument) in one company**; a company has many over time, each with its own arrival context, stage history and pass reasoning. Three states: watching (no deal; the company is tagged into spaces, never a stage), pre-lead (a deal exists, judgment hasn't happened; the high-volume triage bucket), then the funnel. Default stages, editable, each with a group: Pre-lead → Screening → Meeting → Diligence → Term sheet (`active`); Early, revisit (`parked`: a nurture pool, so nobody abuses Passed); Invested, Passed (our no), Lost (their no) (`closed`). Deals close, never delete. The board generalizes to any status attribute; a second pipeline is a second object.
- **Lists are views; records are unique.** A record is one row per real-world thing. A list is a saved view: a filter over one object's records with its own columns, sort and grouping, holding no values and no membership rows. Anything worth saying about a record is an attribute on the record. A view names its surface (D2); column widths stay per browser in `useTablePrefs`.
- **The mandate** is the fund's prescriptive strategy: `mandate(status, note_entity_id, stages, geos, check_min, check_max, currency)`. Its prose is a real memo note; `stages` shares company `funding_stage`'s vocabulary; `geos` are free tags; portfolio construction stays prose. One active mandate per workspace, `archived` for vintages. Its one consumer is a quiet outside-mandate badge on the deal record (`funding_stage ∉ stages`), a hint and never a block, and never in tables. The hint is computed in `getDeal` and is tri-state (nothing renders unless there is a real mismatch). `mandate.stages` stores option ids, so renaming a stage never breaks it. The mandate is member-writable: it is judgment, not settings.
- **Templates** standardize capture, never automate. `template(kind: note|space|record|email, …, suggest_on)`. A note template is a stored document copied into a new note. A space template is a scaffold (memo, glossary terms, subspaces; names and skeletons, never content) captured from a real space ("Save as template"). A record template pre-fills the create window visibly and editably; unknown or archived slugs are skipped. User-created and workspace-shared; we ship none. Instantiation copies; editing a template never rewrites what it stamped. Templates are config, not entities. The picker orders by `suggest_on`; nothing auto-creates. At capture a note template's mentions become plain text (a held reference would mint ghost backlinks) and a record template drops reference and actor slugs; space stamping skips a same-named child rather than duplicating it.

### Interactions and activity

- `interaction(kind: email|meeting|call, message_id, thread_id, subject, occurred_at, note_id, headers/meta, source_class, source_ref)`, `interaction_entity(interaction_id, entity_id)`, `signal(entity_id, source_class, source_ref, payload, observed_at)`, `enrichment_record(entity_id, provider, integration_id, raw, fetched_at, credits_used)`.
- **An interaction's body is a note** (`interaction.note_id`), filed `tagged_in` against every attendee, so meeting notes get mentions, glossary links and search for free. `note_id` is nullable and filled lazily: "Log meeting" makes no empty note, "Log and write up" does. A unique index stops two interactions sharing one body; the `ENTITY_REFS` entry is `merge: none`, `context: null`, `del: orphan`, because a meeting outlives its write-up.
- **Relationship intelligence** is a live query over `interaction_entity` weighted by recency and frequency ("who knows someone at X"). No graph database and no materialized view until measured. Interaction stats (first, last, next) are a derived table the interaction writer keeps (D67).
- **Activity** is one denormalized table, `activity(actor_id, verb, subject_entity_id, object_entity_id, meta, at)`, written by every producer, because timeline reads dominate. Attribute changes are `attribute_event`, not activity rows.

### Portfolio

The tier where an investing CRM stops being a pipeline tracker: pure graph, registry and computed values, with no external dependency.

- **Events.** `round` (a financing event per company: date, kind, raised, pre and post-money, `price_per_share`, fully diluted `shares_outstanding`, co-investors as links), `investment` (our checks: amount, currency, instrument, date, round, optional shares), `mark` (fair value over time with its basis, round price, manual or 409A, and date), `distribution` (exits, secondaries, dividends, write-offs, optional shares), and `fx_rate(currency, date, rate_to_base)` as a sparse manual lookup. Every fact is an append-only dated event and every aggregate is derived, never stored, so "as on <date>" is a filter. Nobody adds a mutable `current_value` column.
- **Corrections** are compensating events (D12): see the trap in `CLAUDE.md` for the reader contract. `fx_rate` is excluded: `setFxRate` upserts on `(currency, date)`, and a corrected rate recomputes every derived number.
- **A deal reaching Invested births a holding** (`birthHolding`), the pipeline→portfolio seam. A follow-on decision is a new deal with its own judgment trail; deal rights (pro-rata, information rights, board seat, MFN) stay prose until the follow-on flow needs them as data.
- **Ownership is instrument-aware.** `priced`, `safe_post_money` (ownership locks at signing: amount ÷ cap, shown as an implied %), `safe_pre_money` and `ccd` (cost basis only until conversion). A % is never faked. Ownership is our position only (our shares ÷ outstanding); an all-shareholder cap table is Carta's job.
- **Metrics** computed live per holding and in roll-up: cost basis, unrealized and realized value, MOIC, TVPI, RVPI, DPI, gross XIRR. Net IRR, fees and carry are out of scope.
- **Currency.** The original currency is the truth: every money event stores amount and currency as entered, converted values are never stored. One workspace `base_currency`. A rate lookup takes the latest rate on or before the event date; a missing rate is surfaced ("N events need a rate"), never 1.0. Cash flows convert at transaction-date rates, marks at the as-of rate, so FX gain lands inside base-currency performance. A holding whose flows share one currency computes natively.
- **`vehicle`** is a nullable label on a money event, never a scope: a workspace is a book, never a fund, and cross-vehicle follow-ons land on one holding. One active mandate assumes serial vintages.
- **Bootstrap import.** An empty financial engine is dead on arrival, so the import wizard takes the universal tracking spreadsheet (company, date, amount, instrument, round, current mark), resolves companies through `resolveEntity`, previews, and commits idempotently as dated `round`, `investment` and `mark` events, with per-row errors.
- **Fenced out:** fund administration (capital ledger, drawdowns, NAV statements, SPVs, fund-of-funds look-through), LP reporting and tax. A lightweight single-vehicle capital ledger may earn a slot if asked. If an LP portal ever comes: LPs are never workspace members, not even read-only; they are data, and a portal reads only immutable snapshots the GP publishes, through tokenized links. MIS collection, if it comes, is dual-path (tokenized founder requests with a standard-six default, and parsing what founders send) into an append-only `kpi_observation`, with AI-extracted numbers entering through Review.

### Tasks and Today

- **A task is a plain table, not an entity**: `task(content, due_date, assignee, done_at, created_by)` plus `task_entity`. It is a verb against a subject and fails the "would you `[[mention]]` it" test; `task_entity`, `ENTITY_REFS` and the assembler's `task` context kind give the graph sight of it. It becomes a system object only on a custom-fields or task-views ask. Tasks are a fourth lane in Cmd-K search, routing to /tasks with the row focused.
- **The composer is one line**: natural-language due dates by a deterministic parser (not AI) with Today, Tomorrow, Next week and No date chips; assignee defaults to the creator; linked records by entity search; `t` everywhere. Dateless tasks are legal. Tasks are the resurrection machinery for parked deals ("revisit when their round closes").
- **Today is the reminder channel**, not email: opening the app is the notification (D79). An SMTP digest is additive and never required.

## Search, AI and arrival

### Search

- One Cmd-K over names, note bodies, extracted document text and tasks, fused in Postgres by reciprocal rank (k=60) over CTEs ranking the same id space; the vector lane joins as one more CTE when embeddings are configured (D23). Ranks fuse where trigram and `ts_rank` scores cannot.
- Names match with `word_similarity` (`<%`), not `similarity`, so a short query reaches a long name ("orbitl" → "Orbital Composites"), on a trigram GIN index over `entity.canonical_name`.
- `note.tsv` is a stored generated column over the derived `body_md` (title weight A, body B), so it cannot drift; `document.tsv` is worker-written because its text arrives later.
- cmdk's client filtering is off: it would drop the server's fuzzy matches. Snippets come from `ts_headline` with `«»` markers rendered as text, never HTML. A document hit routes to the record it is filed against. Private rows are filtered inside the queries (`canReadNoteSql`), because a title in Cmd-K is a leak.

### AI

- AI is core substrate: `complete` and `embed`, lanes routed by sensitivity, propose-only writes, embeddings pinned at one dimension. Every AI feature (the deck reader, AI attributes, Prep, Ask) is a core composition, never a plugin. A gateway is a base-URL passthrough.
- Context for a model comes from the context assembler, which walks the graph from a record through `ENTITY_REFS` context roles and applies `canRead`; one code list of entity-referencing tables serves both merge and the assembler, so a new edge table cannot be missed by either.
- Ask answers through an in-process client of the MCP tool surface, the same tools external agents use (D70). Reading a deck is a manual "Read deck"; reading on upload waits for an opt-in toggle.

### Arrival: mail, calendar, recorders

- **Forward-only.** Sync starts at the connection (`connectedAt`); nothing older is written. That turns three years of mail into a trickle and makes "create all, visible" the right participant policy (D34).
- **Per-user grants, one shared dataset**: `account_connection(user, provider, product, external_email, tokens_enc, status)`, one per provider product (D66). Mail dedupes by RFC 822 `Message-ID`: one thread in two inboxes is one interaction. Outlook is not in v1.
- **Google verification is avoidable** because the fund brings its own GCP project and OAuth client: on Google Workspace the app type is Internal (no verification, unlimited org users); otherwise Testing mode (100 users, refresh tokens expire in 7 days). The redirect URI comes from `APP_URL`.
- **The forwarding lane is core** (D31): an IMAP poll of an operator-owned mailbox the fund forwards or BCCs to, an app password in the vault (`credential.kind = 'mailbox'`), a `mail.poll` job every `mailbox.cadence_minutes`, writing through one core `integration` row (`capability_id = 'core.mailbox'`). The cursor carries its UIDVALIDITY; a change restarts from UID 1 and leans on `interaction_message_id_unique` to write nothing twice. Gmail's own sync is a bundled plugin (D82).
- **Noise** (no Message-ID, `Auto-Submitted`, list mail, machine senders) is refused by pure rules in `lib/arrival/noise.ts`, shared by every lane; each poll's `job_run.summary` says what was written and why the rest was not.
- **A forwarded body** is a note born shared and filed against nothing: it reaches records through the interaction's edges, so mail does not fill every participant's Notes.
- **Participants** are one pure module, `lib/arrival/participants.ts`: addresses in, `create | attach | ignore` out, shared by every lane. A work-domain address makes a person and a company (named after the domain's first label); a free provider (`lib/arrival/free-email-domains.ts`) makes only the person; a shared inbox at a work domain makes only the company. The workspace's own people attach and never create; own domains are derived from members' addresses and the mailbox's own. Machine senders, a role address at a free provider and anything unparseable are ignored. Every create goes through `resolveEntity` with the mailbox integration as source; nothing under `lib/arrival/` inserts into `entity` or `entity_alias` (a grep test).
- **Synced mail privacy** (D67), per connection and set by its owner: shared are the interaction row, its headers, its edges and so the timeline, graph and stats. Private to the owner are the body (a note born `private`) and what is read off it (Gmail's snippet, the cached summary and categories), so Cmd-K, the semantic lane, the assembler and MCP never return it. "Share with the workspace" moves every synced body either way. An exclude list (senders, domains, local parts, Gmail labels; the default `DEFAULT_MAIL_EXCLUDE` covers the category tabs, Spam, machine senders and bounce domains) refuses a message before anything is stored, and adding to it removes what is held. A forward of a privately synced thread widens it (`note.visibility_changed`). Two override tables widen at read time inside `canRead`, `canReadNoteSql` and `canReadDocumentSql`: `email_visibility(entity_id, user_id, scope)` ("my emails with Flent are visible to the workspace") and `email_grant(interaction_id, user_id, granted_by)`; only the body's owner writes either.
- **There is no cheap legal enrichment source for Indian company data** (the MCA registry, Tracxn, Crunchbase licensing), and scraping is a liability: BYOK covers data too.

### The integration map

Every integration classifies into an existing lane: identity → aliases through `resolveEntity`; sourced facts → fill-blanks with receipts; content → the document pipeline; generated judgment → suggestions. No category needs a new lane.

- Built: storage sources (Drive, Box), mail and calendar, recorders, enrichment (Apollo, Exa), AI, import dialects (Airtable through the `Import` port), outbound MCP and `/api/v1`. Feeds are decided as built in (D87).
- Mapped, not built: **native forms** rendered from the registry outward (pitch submission, founder updates, DD questionnaires, referral intake). **WhatsApp**: lane 0 parses the native "export chat" upload (no ToS exposure); lane 1 is an opt-in companion container on the WhatsApp Web protocol, read-only, 1:1 chats, opt-in per chat, documented plainly as ToS-violating at the user's risk, and last on the map; the Business Cloud API is the wrong shape. **A capture extension**: an MV3 thin client that posts visible page text to the user's own instance with a token; extraction happens server-side against the registry; manual and user-initiated only, versioned so drift reads "update me". **Outbound delivery** stays pull (D28).

## Team, auth and tokens

- **Single user first, team ready.** The UI assumes few users; the schema does not. `visibility` (`shared | private`, default shared) applies to note bodies, interaction bodies and documents. Private-by-default is the trap that keeps partner two writing in Apple Notes.
- **Two choke points from day one.** `canRead(entity, user)` (true except private-and-not-yours) on every read path, and `canWrite(entity, user)` on every mutation, so a read-only role (an LP, an advisor) is a one-line change rather than a write-path audit.
- **Multiple workspaces: decided, not built.** An install is one organization holding N workspaces (books). The only global product object is the user (one login, per-workspace membership); instance config (`MASTER_KEY`, SMTP, `APP_URL`) is operator-level; everything else is per workspace, and the same founder in two books is two records. Roles become two layers (instance and workspace admin/member); workspace creation is instance-admin only; at least one admin always at each layer. No `organization` table until a hosted design pass. Discipline that keeps hosting a hardening pass rather than a remodel: uuid workspace ids, all scoping through one choke point (the future RLS site), no query that joins across workspaces, credentials encrypted per workspace. Spaces, terms, the mandate and the taxonomy are never per user: shared vocabulary is the point.
- **Auth** is Better Auth: database-backed revocable sessions, httpOnly, Secure, SameSite=Lax cookies, passwords of at least 12 characters, `admin` and `member` roles enforced on the server. Signup is open only while no user exists, checked server-side, then closed for good. Invites store only `token_hash`, single-use, 7-day expiry, role baked in; with SMTP they are mailed, without it the link is shown to copy. A reset link is issued by an admin (no self-serve reset). Decided, not built: Argon2id, a 5-per-minute login limit per IP and email, optional OIDC from env (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAIN`) beside password login, and TOTP 2FA.
- **Two token stores, never conflated**: `session` (who you are in the app) and `account_connection` (per-user OAuth grants, encrypted). Login with Google is not "sync my Gmail".
- **Two self-host traps.** (1) Behind a TLS-terminating proxy the app sees `http` and refuses Secure cookies, so login loops: `APP_URL` is required and decides cookie security and OAuth redirect URIs; `X-Forwarded-Proto` is trusted only from the proxy. (2) Between `docker compose up` and the first admin, `/setup` is open to anyone who can reach the port, so a one-time setup token is printed to the logs and required.
- **API tokens.** MCP and `/api/v1` authenticate against one table, `api_token`: per-user bearer tokens, hashed, revoked rather than deleted. Per user because `canRead` is per user: a teammate's assistant sees what the teammate sees. No OAuth and no external identity provider, because the required env is frozen. `scopes` governs `/api/v1` only; a token with `'{}'` still opens MCP.

## BYOK and AI providers

- **One vault.** `credential(scope: workspace|user, provider, kind, secret_enc, meta, status, …)`, kinds per D3. Envelope encryption, AES-256-GCM, AAD `scope:provider`. One row per `(scope, provider, kind, user)`: a Gemini `llm` key and the Google `oauth_client` both sit on provider `google`, so every lookup names its kind.
- **The master key** comes from `MASTER_KEY`, else is generated on first boot to `./data/secret.key`. **Losing it makes every stored key unrecoverable**; the install, upgrade and backup docs say so in bold.
- Keys are write-only in the UI (`sk-...4f2a`), redacted in logs, decrypted only in the worker. Resolution order: user key, then workspace key, then none. Pasted keys are workspace-scoped in the UI; the `user` scope exists for later. OAuth grants are per user by nature; the OAuth client is a workspace credential. A provider (Google, Microsoft, Box) is one client under which several uses hang, each asking incremental scopes; the OAuth dance lives in core. Plugin install and workspace keys are admin-only.
- **No key, feature hidden**; everything else works, and every integration is skippable.
- **Models.** The Vercel AI SDK over Anthropic, OpenAI, Google, Ollama and OpenRouter. Lanes map to models (cheap for tagging, frontier for drafting), routed by sensitivity (D20). Ollama is first-class: the self-host audience overlaps the local-model audience. A token counter gives the operator cost visibility (D46).
- **AI proposes, a person accepts.** A model's output (an attribute value, a document kind, a space tag, a note, an identity claim) lands as a `suggestion` row with its rationale, refs and run; a rejection is remembered. A guess on a screen a person is confirming, such as an import column mapping, is a pre-selected control instead, and the import batch records it as AI-proposed (D41).

### Embeddings

- **The dimension trap.** A pgvector column has a fixed dimension, and vectors from another model are silent garbage. One dimension is pinned per deployment, 768 by default, so nomic, bge-base and OpenAI-3 at 768 can serve one column; `document_chunk.embedding_model` records which model wrote each vector. Changing the model enqueues a full re-embed; re-pinning the dimension is the explicit nuclear path (alter column, rebuild index, re-embed). Never mix models in one column.
- **Never forced, automatic once enabled.** With no embedding provider there are no vectors and no semantic lane; lexical, trigram and graph fusion is the floor. With one, a document embeds on extraction; only the bulk backfill asks, with an estimate. Local embeddings are Ollama only (D11); LM Studio is out of scope until asked. Embeddings are core, not a plugin.
- A chunk carries no space path (a document can be filed in many spaces), so space filtering joins `entity_space` at query time. A chunk is the retrieval grain, not the citation grain: a note chunk cites as `note`, a `close_reason` chunk as `attribute`, and only `doc:<id>#<idx>` is a chunk ref.

### Enrichment

Enrichment is a host capability (D76) and an enricher is a plugin: an `action` job with an optional `cost` hook, and optionally an `event` job on `entity.created`, calling `Read`, `Http`, `Receipts`, `Identity` and `Facts`. Apollo is `plugins/apollo`. Credit safety: never bulk auto-enrich; bulk enrich confirms with an estimate; a per-day cap per source enforced in the worker; a cache skips re-enrich within N days (default 90). The raw response is kept (`Receipts`); a person's value is never overwritten. Apollo specifics: enrich by domain and match people with the bulk endpoints, `X-Api-Key`, rate limits read from response headers rather than hard-coded, and Apollo's own error text surfaced.

## Storage

- **Local filesystem by default; S3 opt-in by env** (`STORAGE_DRIVER=local|s3`, `@aws-sdk/client-s3` with `forcePathStyle` for non-AWS, tested against MinIO in CI). No bundled object store: single-node Garage or MinIO writes to the same disk, so it does not solve the problem that motivates it, and it turns `tar` of plain files into an opaque data directory needing a compatible daemon to restore. The one trigger for S3 is an ephemeral host disk (Fly, Railway, Render, Cloud Run). Recommended targets: Cloudflare R2, Backblaze B2, Garage, AWS S3. Mounting S3 at `./data` with rclone works for evaluation only: `rename()` is not atomic there and the local driver streams then renames.
- **The interface** (`Storage` in `@spaces/core/writes/storage`): `put`, `getUploadUrl(key, ttl) → { url, headers }`, `getDownloadUrl(key, ttl, { filename? })`, `getBytes`, `exists`, `delete`. A 200 MB deck never streams through Node: S3 presigns, and the local driver fakes it with a short-lived HMAC token on `/api/blob/:key`.
- **Content-addressed keys**: `sha256(file)`, so the same deck mailed to two partners is one blob and two document rows. The local driver re-hashes on write; a presigned S3 PUT carries a signed `x-amz-checksum-sha256`; the extraction worker re-verifies every digest whatever the driver.
- **Extraction** is in-process on the worker: PDF by `unpdf`, DOCX by `mammoth`, PPTX and XLSX by `fflate` over the OOXML (macro and template variants route to the same extractors). Legacy `.doc` and `.xls` are unsupported (`extraction_status: unsupported`). A scanned PDF goes to a BYOK vision model; with none, "text not extractable". No Tesseract container.
- **Orphan blobs are reclaimed from an intent row.** Upload is prepare → browser PUT → finalize. `pending_blob` is written at prepare and deleted by `birthDocumentProgram`; a sweep reclaims what is older than the grace period and named by no document. Listing the store was rejected: it would add `list()` to the interface, cost a whole-bucket scan nightly, and could not tell an orphan from an arrival in flight. `pending_blob.size_bytes` is `bigint` so the column imposes no 2 GB cap.

## Plugins

The contract is `docs/spec-plugin-sdk.md`. This section holds the decisions behind it and the parts of the runtime the spec points here for.

**Doctrine: plugins feed the graph; they never extend the product.** A plugin is an ingestion adapter. It calls ports, and each port routes into an existing lane with the doctrine enforced in the port. No plugin React, no plugin `db` handle, no plugin edits to `public.*`, no vendor names in shared enums. A third party cannot add a record panel or a new shape of thing; those land in core. Integrations left the image because compiled-in vendors cost image bytes, `node_modules` attack surface and migrations on every box, and baked vendor names into shared enums no third party could migrate.

- **Ports are the contract**: Effect service tags, one per lane, provenance stamped from the bound `integration` row: `Identity`, `Facts`, `Content`, `Judgment`, `Receipts`, `Import`, `Ai` (a lane and a budget, never a model or a key), `Read` (`canRead` as the integration), `Secrets` (worker-only decrypt), `Config`, `PluginDb` (scoped to `plugin_<id>`), `Http` (rate-limited, header-driven throttle), `Log`, plus `Spaces` and `Discover` for watches. Ports are granted per (integration, job) by declaration; the Layer the loader provides holds exactly those, and that is the privilege boundary. Jobs declare triggers, not kinds (D51), and call ports rather than returning claims (D52).
- **AI is substrate, not a plugin.** It sits below the SDK as the `Ai` port: sensitivity routing must bind every caller, and plugins cannot depend on plugins. Providers are core-owned AI SDK adapters keyed from the vault. The MCP server is an outbound head on the substrate.
- **Provenance.** `source_class` (`manual | integration | ai | import | seed | merge | extracted | inherited`) plus `source_ref` (D1), a biconditional held by a check constraint on each table: a `seed` row can never carry an integration id, and an integration row always names one. First-party channels are not integrations: a clip is `manual`, and core never seeds a synthetic `integration` row for its own channels; if one ever needs recording, it gets its own column.
- **Workers and jobs.** Every plugin invocation is a pg-boss job run by `runJob` (parse → provide Layer → run → map the typed failure to retry, fail or the breaker). Plugin failures increment `integration.error_count` and trip a breaker that disables the plugin, never the worker. `job_run` is the worker's attempt ledger with one writer, `runJob`, and no tokens column: a retried attempt would double-count. Token accounting is `ai_usage` per call, rolled up by `ai_run`, a separate table because a run is one logical action of ordered steps and a request-path call (the settings Test call) has no job; both of `ai_usage`'s links are nullable for that reason.

### Runtime, as built

- **Where plugins live.** The image is the immutable core; plugins live in `./data/plugins/<id>/<version>/` beside blobs and `secret.key`, so the both-or-neither backup covers them. `lock.json` (`{ core, plugins: { <id>: { version, sha256 } } }`) pins the set for a reproducible restore.
- **Install, upgrade, uninstall.** One installer, `runInstaller` (`@spaces/core/writes/plugins/install`), behind `installPlugin`, `upgradePlugin` and `uninstallPlugin`; a source-scanning test holds their callers. It takes tarball bytes plus the registry entry naming them, so the registry, the air-gapped upload and first boot share one path. `verifyPlugin` runs before anything is written. Files land by rename from `plugins/.staging/`; `current` is a relative symlink swapped by rename; the row is written `installing` and enabled, then `NOTIFY plugin_changed` after commit. An upgrade keeps one version back. Uninstall soft-deletes the row (`removed_at`), so every `source_ref`, `actor_ref`, `integration_id` and `signal.source_ref` survives and the timeline reads "Apollo, since removed" (`sinceRemoved`); it deletes the files, the lock entry and the key, and drops `plugin_<id>` only when asked. Reinstalling the same id reuses the row.
- **Upgrade rule.** An entry satisfies when it is newer, its `minCore` is at or below this core and its sdk range admits this sdk (`updateFor`, `@spaces/core/plugins/registry`), one rule for the badge, the Update click and boot autoupdate. An upgrade records `upgraded_from` and `upgraded_at`; the loader sets `upgrade_migrated` once a migration applied. The row reads `rollback available` or `rollback unsafe — restore from backup` (D47). `SPACES_PLUGINS_AUTOUPDATE=compatible` (optional, off when unset) runs in the worker at boot, before the first reconcile.
- **Boot reconciliation.** Row present, files present and sdk satisfied → enabled; anything else → `degraded` with the reason, jobs skipped, boot continues. A plugin never crashes the box; `/api/health` lists degraded plugins. An sdk major degrades incompatible plugins with the fix named; core keeps a shim Layer one major back.
- **Containment.** A plugin that ships `migrations/` or declares `PluginDb` runs under the `plugin_runtime` role: `nologin`, created race-safe by the worker as the database owner, granted USAGE on `public`, SELECT on its tables and REFERENCES on `entity(id)`, nothing that writes; SELECT is then revoked on `SECRET_TABLES` (`credential`, `account_connection`, `session`, `verification`, `api_token`, `user`). The loader refuses to continue if the role can create in `public`, write any table there or read a secret table. `drizzle` and `pgboss` grant it nothing. The plugin's schema is `plugin_<id>` (hyphens → underscores), owned by that role; migrations and every `PluginDb` query run after `set local role plugin_runtime` with `search_path = plugin_<id>, public` inside a transaction. A database that refuses `CREATE ROLE` degrades the plugin, never runs it uncontained. Migrations are `migrations/*.sql` in lexical order, statement by statement, all pending files in one transaction under an advisory lock, journaled in `plugin_<id>.spaces_migrations` (name, sha256), forward-only. FKs may point from a plugin schema to `public.entity(id)`, never back. The role guards a plugin's mistakes, not a hostile plugin (SQL can `RESET ROLE`), which is why trust is signing.
- **Signing** (D16, D54). The key id is `ed25519-` plus the first 16 hex digits of sha256 over the raw public key (`keyIdOf`, `@spaces/sdk/pack`); a key file whose key does not hash to its name is not trusted. Keys are PEM SPKI files `plugin-keys/<keyId>.pub`, copied to `/app/plugin-keys` and read by `@spaces/core/plugins/trust`, fail-closed. The tarball is a deterministic hand-rolled ustar (sorted entries, mtime 0, uid/gid 0, fixed modes) gzipped with `node:zlib`; the verifier refuses links, devices, absolute paths and `..`. A release is `<id>-<version>.tgz` plus `.sha256`, `.sig` and the entry `<id>-<version>.json`. `registry.json` is a committed array of entries `{ id, version, sdk, name, description, requires?, tarball, sha256, sig, keyId, minCore? }`. `verifyPlugin` checks the signature over the whole tarball before parsing it and refuses with `sha-mismatch · unknown-key · bad-signature · unsigned · unreadable · unsafe-entry · manifest-missing · manifest-mismatch`. With `.allow-unsigned` present an unsigned archive verifies with a warning. Third-party code or a foreign runtime (a WhatsApp bridge) would be a companion container on a compose profile speaking to the webhook ingress with a token; not designed yet.
- **Webhook ingress.** `POST /api/webhooks/<integration id>` (the row id, never the plugin id). Web runs core's `receiveWebhookProgram` and never plugin code. Anything but an enabled, running, unremoved row whose manifest declares `ingress` and a `webhook` job gets one identical 404. `ingress.signature: 'hmac-sha256'` means `x-spaces-signature: sha256=<hex HMAC of the raw body>`, checked in constant time against a webhook secret stored in the vault as kind `webhook` under provider `<plugin id>:webhook` and bound to `integration.webhook_credential_id`; missing or wrong is 401, over 1 MiB is 413. An accepted delivery is stored raw in `ingress_payload`, enqueued on each webhook job's `plugin.<id>.<job>` queue, and answered 200. Payloads are kept 7 days (`INGRESS_RETENTION_DAYS`, the nightly `ingress.prune`).
- **Testing.** A plugin passes or does not ship. A provider's recorded answers are a cassette beside its plugin (`fixtures/cassette/`), served through the Http port's fetch seam behind a small mutable fake. `SPACES_FAKE_PROVIDERS=1` makes those fakes the dev and demo environment; unset, they are never imported, and the image carries no cassettes. Each port has one conformance file over its live and in-memory implementations. CI's `offline` job runs the worker and plugin suites with egress rejected.

### Releases

Three independent lines (D86): core, the sdk, each plugin.

1. **Bump**: the commit that changes what a line ships runs `pnpm release:bump <core|sdk|plugin id> <patch|minor|major|X.Y.Z>`. A line moves only when its own package does.
2. **Tag**: on main, the Tag workflow pushes one tag per bumped line (`core@X.Y.Z`, `plugin-<id>@X.Y.Z`, `sdk@X.Y.Z`) with `RELEASE_TOKEN`, because a `GITHUB_TOKEN` push starts no workflow.
3. **Build**: `core@` runs `release.yml` (the image). `plugin-<id>@` runs `plugin-release.yml`: the plugin's tests, `pack:plugin` signed with `SPACES_PLUGIN_SIGNING_KEY` (a key `plugin-keys/` must hold), and a GitHub release with the four files. No workflow listens for an `sdk@` tag.
4. **Registry**: the same job checks `registry.json` against the release with `verifyPlugin` and commits the entry on main; the next image carries it. `pnpm exec tsx scripts/release-plugin.ts --no-push <id>` is the dry run.

## Hosting

The target: `docker compose up` works first try. Operator steps are in `docs/install.md` and `docs/upgrade.md`.

- **Three containers** (app, worker, Postgres from `pgvector/pgvector:pg17`), all but Postgres from one image; the worker has its own so its crash or OOM never takes the web app down. `ROLE=all` runs both processes in one container. Web never runs CPU-bound extraction or embedding inline.
- **Rules that decide adoption.** Migrations run at boot, no `docker exec` step. Every env var is optional except `DATABASE_URL` and `APP_URL`. **No build-time env**: Vite bakes `VITE_*` at build, so nothing client-visible may come from one; the browser gets runtime config from the root loader, or a prebuilt image could not be reconfigured at `docker run`. A health endpoint and sane logs.
- **Env surface**: `DATABASE_URL` and `APP_URL` (required); `MASTER_KEY` (generated if absent); `SMTP_URL`; `STORAGE_DRIVER=local|s3` with `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (on by default); the plugin conveniences under contract 6.
- **The image.** Multi-arch (arm64 is the audience's hardware), non-root UID 1000. Node entries are bundled with `vite build --ssr` (D26): the worker (`apps/worker/dist/index.mjs`), its health command (`dist/health.mjs`) and the boot entry (`apps/web/dist/boot.mjs`). Workspace code is inlined; npm packages stay runtime imports from the image's pruned `node_modules` (`turbo prune @spaces/worker`; the web process runs from its self-contained `.output`). The drizzle journal is never bundled: the boot entry is handed `/app/packages/db/drizzle` as argv. tsx is dev-only.
- **Releases** (D15, D16). A `core@X.Y.Z` tag (refused unless it matches the root `package.json`) runs `release.yml`: the commit's whole CI including `image-smoke`, both platforms built once into an OCI archive, amd64 smoked and arm64 booted under QEMU, then pushed unchanged (one digest) to `ghcr.io/anishxbadri/spaces` and Docker Hub as `X.Y.Z` and `X.Y`, never `latest`. The digest is signed with cosign keyless (GitHub Actions OIDC) in both registries, and GHCR carries a SLSA build-provenance attestation. An operator verifies with:

  ```
  cosign verify <image>@<digest> \
    --certificate-identity-regexp '^https://github.com/AnishxBadri/Spaces/\.github/workflows/release\.yml@refs/tags/core@' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  gh attestation verify oci://ghcr.io/anishxbadri/spaces@<digest> --repo AnishxBadri/Spaces
  ```

- **Upgrade CI.** `.github/workflows/upgrade.yml`, on every `core@` tag and nightly (never on a PR), upgrades from a pinned window of published tags to the commit's image: the newest prior tag always, plus every other tag in the same major. The window is `scripts/upgrade-tags.sh`; the run is `scripts/upgrade-check.sh` (old tag boots → plant → `backup.sh` → new image on the same volume → migration count matches → a document downloads → the old image is refused → `restore.sh` brings the old state back). With one published tag it prints that there is nothing to upgrade from and exits 0.
- **One-click templates** for Coolify, Railway, Render and Unraid live under `deploy/`; each must provision pgvector ≥ 0.8, wire `APP_URL` to the platform domain and keep `./data` on a persistent volume.
- **Prior art.** The target is "as simple as Plane or Cal.com". From Wealthfolio: multi-arch images, a non-root UID, pinned tags, platform guides; not its host-side `openssl` and `argon2` first-run, SQLite, or OIDC-only teams.

### Hostability contracts

Six contracts, numbered because code and scripts cite them.

1. **`./data` ownership is fixed structurally.** The entrypoint starts as root, repairs `/data` ownership if wrong and drops to UID 1000 with `su-exec` before running anything. Plain files under `./data` (not a named volume) are the you-own-your-data story.
2. **Either process dies, the container exits.** Under `ROLE=all` a worker death kills the container and `restart: unless-stopped` heals it, so a crashed worker never leaves a "healthy" container with extraction stopped (D62).
3. **The app never terminates TLS.** A reverse proxy is always in front; `APP_URL` is the one source of scheme, cookies and OAuth redirects; `X-Forwarded-Proto` is trusted only from the proxy. `docker-compose.tls.yml` with `docker/Caddyfile` makes HTTPS copy-paste.
4. **`/api/health` checks the database**, not just the process. A `worker_heartbeat` row keyed on `role` gives `ROLE=worker` a real check; `/api/health` and the worker's own health command share `classifyBeat`, which takes the threshold as an argument.
5. **Backup is both-or-neither, and rollback is restore.** `pg_dump` and `./data` (blobs, `secret.key`, plugins) together: content-addressed blobs are worthless without the database and vice versa (`scripts/backup.sh`, `scripts/restore.sh`). Upgrade is backup → pull → up. An older image never runs against a newer schema: the downgrade guard refuses, with no override.
6. **The required env is frozen at `DATABASE_URL` and `APP_URL`, permanently.** Every feature ships with a working default or is optional. Two optional plugin conveniences sit outside it, and a box that sets neither is unaffected (tested: no row, no file, no log line). `SPACES_PLUGINS=apollo,…` installs at boot each named plugin with no live row, from the bundled registry's newest satisfying entry, through `installPlugin`; a live row is skipped, and unsetting it uninstalls nothing. `SPACES_CREDENTIAL_<ID>` seeds the workspace credential for that provider only when none exists, recording the first admin as `created_by`. Both run last in `boot()` and are never fatal.

### Documents served safely

- Downloads are always `attachment` plus `application/octet-stream`, baked into the signed response of every presigned GET too: echoing an upload's content type would make an uploaded `.html` stored XSS on the app's origin.
- The preview renders opaque bytes itself: PDFs through pdf.js to a canvas (the browser never navigates to the file), images through an object URL whose type we choose, Office files from the worker's extracted text (a sheet renders back into a grid). SVG is download-only. The preview is a modal, not a route. Known limit: the whole file loads into memory (no `Range` support).
- `extraction_status` is three-way; `unsupported` is a normal permanent state, not a failure. Deleting a document deletes its blob when no other row shares the digest. CI's `image-smoke` uploads a DOCX and a PDF against the composed image and checks both previews and the download headers (`apps/e2e/specs/image/`).

## Feature → files

| Feature                 | Look at                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Deals and the board     | `routes/_app/deals.tsx`, `components/deal-board.tsx`, `lib/server/deals.ts`                         |
| Today                   | `routes/_app/today.tsx`, `lib/server/today.ts`                                                      |
| Portfolio               | `routes/_app/portfolio*.tsx`, `lib/server/portfolio.ts`, `lib/portfolio/`, `core/src/portfolio/`    |
| Invested → holding      | `birthHolding` in `lib/portfolio/holding.ts`                                                        |
| Attribute engine        | `core/src/attributes/registry.ts`, `core/src/writes/attributes/values.ts`, `components/attributes/` |
| Identity, dedupe, merge | `core/src/writes/entities/`, `routes/_app/review.tsx`                                               |
| Spaces                  | `routes/_app/spaces*.tsx`, `lib/server/spaces.ts`                                                   |
| Notes                   | `routes/_app/notes*.tsx`, `components/editor/`, `lib/server/notes.ts`                               |
| Documents               | `lib/server/documents.ts`, `core/src/writes/documents/`, worker `jobs/extract-document.ts`          |
| Email and meetings      | `lib/server/emails.ts`, `lib/server/meetings.ts`, `components/email/`, `components/meetings/`       |
| Ask and Cmd-K           | `lib/server/ask.ts`, `lib/mcp/`, `components/ask/`, `components/command-palette.tsx`                |
| AI context              | `core/src/context/` (ranker), `core/src/writes/context/` (assembler)                                |
| Views                   | `lib/server/views.ts`, `lib/views/sql.ts`                                                           |
| Custom objects          | `lib/server/objects.ts`, `routes/_app/o.$objectSlug.tsx`                                            |
| Plugins and connections | `lib/server/plugins.ts`, `lib/server/connections.ts`, worker `plugins/`, `packages/sdk/`            |
| Import                  | `lib/import/`, `lib/server/imports.ts`, worker `jobs/import-commit.ts`                              |
| BYOK vault              | `core/src/writes/vault/`, `lib/server/settings.ts`                                                  |
| Auth, setup, invites    | `routes/setup.tsx`, `routes/join.tsx`, `lib/auth.ts`, `lib/setup-token.ts`, `lib/server/members.ts` |

Paths without a package prefix are under `apps/web/src/`; `core/` is `packages/core/`.

## Where to look when…

- **Adding a column that references an entity** → `ENTITY_REFS` first (merge strategy and context role), then the schema. A `custom` strategy also needs its section in the merge executor.
- **Adding a system attribute** → `SYSTEM_ATTRIBUTES` in the attribute registry, then `pnpm db:migrate:run`.
- **Showing money** → `fmtMoney`, never `Intl` compact notation.
- **Adding a route** → `routes/_app/`, then `pnpm generate-routes`.
- **Adding background work** → a queue in core's queue names, a job under the worker's `jobs/`.
- **Installing, upgrading or rolling back** → `docs/install.md`, `docs/upgrade.md`.
- **Deciding anything** → `docs/decisions.md` first, then the section here.
