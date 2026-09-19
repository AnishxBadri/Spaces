# Chapter 1 — foundation: boot, database, worker

Everything in later chapters is a view over the tables described here. Read
the schema section slowly; the rest of this chapter (boot, queue, ops) can be
skimmed and returned to.

## Entry and shell files

**`src/env.ts`** is a t3-oss typed env schema. Honest finding: nothing
imports it. It's vestigial scaffolding from the TanStack Start template; all
real config reads `process.env` directly (`DATABASE_URL`, `MASTER_KEY`,
`STORAGE_DRIVER`). That matches the Dockerfile stance of no build-time env
baking. Safe to ignore, candidate for deletion.

**`src/router.tsx`** exports `getRouter()`: builds the router from the
generated `routeTree`, injects a `QueryClient` context from
`getContext()`, and wires `setupRouterSsrQueryIntegration` so loader-fetched
data dehydrates on the server and rehydrates on the client. Also carries the
`declare module` Register trick that gives the whole app typed routes.

**`src/routeTree.gen.ts`** is generated (`pnpm generate-routes`), 579 lines,
`@ts-nocheck`, never hand-edited. It encodes the route tree you saw in
chapter 6 plus the three API routes.

**`src/integrations/tanstack-query/root-provider.tsx`** exports
`getContext()` returning a fresh `QueryClient` (per request on SSR). The
default export is an empty component; the SSR integration in router.tsx owns
provisioning. `devtools.tsx` is a devtools panel plugin object.

**`src/styles.css`** (352 lines) is the whole design system as CSS custom
properties plus a Tailwind v4 `@theme inline` mapping. Worth knowing:

- Fonts are self-hosted via `@fontsource` (Inter for UI, Source Serif 4 for
  prose). No font CDN, by privacy stance.
- All colors are OKLCH. Primary is "Pine" green; every neutral carries the
  same hue at near-zero chroma. Primary is the only saturated fill; badges
  are pale tint plus same-hue ink, with contrast ratios annotated per pair.
- The 12-hue badge palette lives here as `--badge-slate` … `--badge-cyan`
  with `-ink` partners. Chapter 3's `colors.ts` names these; this file owns
  the values.
- A fixed type scale (`micro` through `display`, 11 to 26px), a `--row-h`
  ledger rhythm, custom `focus-ring` utilities (single outline treatment,
  WCAG-cited), and a `numeric` utility (tabular figures + right alignment,
  applied as one unit).
- `prefers-reduced-motion` kills all animation globally.

## Database core

**`src/db/index.ts`** is five lines: `db = drizzle(DATABASE_URL, {schema})`
over node-postgres. Roughly 25 files import it. The web process and the
worker import the same module; they are two processes sharing one database
and nothing else.

**`src/db/migrate.ts`** is the programmatic migration runner: run
migrations from `./drizzle`, then two seeds with deliberately different
lifetimes:

- `seedSystemAttributes()` runs on **every** boot, insert-if-absent. System
  attributes are code-owned structure; user edits to their options survive
  because existing rows are never overwritten.
- `seedStarterTaxonomy()` runs on **first** boot only (bails if any space
  exists). The taxonomy is user-owned; re-running would resurrect nodes the
  operator deleted.

The entrypoint runs this on every container boot; in dev it's
`pnpm db:migrate:run`.

**`src/db/schema/helpers.ts`** defines two `customType`s drizzle doesn't
ship: `tsvector` and `ltree`, both surfaced as strings in JS. The extensions
themselves (pg_trgm, ltree, unaccent, vector) are created in migration 0000.

## The schema, table by table

One file per domain under `src/db/schema/`. Read them in this order.

### `auth.ts` — Better Auth tables

`user` (with the admin plugin's `role`, default `member`, plus
banned/banReason), `session` (DB rows, so revocation is a delete), `account`
(provider accounts, holds the password hash for email+password), and
`verification`. The interesting one is **`invite`**: the path around
permanently-closed signup. Only the sha256 `tokenHash` is stored (a leaked
DB row is not a working invite); optional email lock; role baked at
creation; single-use via `usedAt`; 7-day expiry enforced app-side. Works
without SMTP because the /join link is copyable.

A doc comment draws the line that matters: this file is the app-session
store. Gmail/Calendar OAuth grants will live in `account_connection`
(vault.ts) and are never conflated with login.

### `workspace.ts` — the singleton and the mandate

`workspace` has `id integer PRIMARY KEY DEFAULT 1` with `CHECK (id = 1)`:
the singleton is structural, not remembered. Read it as current build
state, not as doctrine: the old governance rule — "not a tenancy boundary,
no other table may ever grow a `workspace_id` FK" — was **rescinded
2026-08-15** (CONTEXT.md, _Single user first, team ready_: one install
holds N workspaces (books), and the user account is the only global
product object). Its `settings` jsonb holds things like `base_currency`.

`mandate`: one row per strategy vintage, `status active|archived`, with a
partial unique index on status where active, so exactly one active mandate
can exist. `noteEntityId` points at a real note (the prose is searchable and
mentionable for free); typed facts are `stages text[]`, `geos text[]`,
`checkMin/checkMax bigint` (whole currency units), currency.

### `entities.ts` — the spine

- **`entity`**: uuid id, `kind` enum (company, person, organization, deal,
  space, note, document, term), `canonicalName`, `mergedIntoId` (soft merge:
  loser rows survive as redirects, and chains are flattened at write time so
  a redirect is always one hop), and **`values jsonb`**: every attribute
  value, system and custom, keyed by attribute slug. The registry defines
  the shape; validation happens at write (chapter 3).
- **`entityAlias`**: identity lives here, never on side tables. `kind`
  (name, domain, email, linkedin, cin), `value` raw, `valueNorm`
  normalized, `isIdentity`. The partial unique index on
  `(kind, valueNorm) WHERE is_identity` is the core identity constraint:
  deterministic keys are globally unique, and a colliding write must be
  converted by `resolveEntity()` into a duplicate candidate, not an error.
  Name aliases are never identity; they only feed trigram search.
- **`duplicateCandidate`**: the dedupe inbox. Ordered pair (app convention:
  entityA < entityB), score, jsonb reason, status open/merged/dismissed.
  `dismissed` persists forever, which is what stops a nightly sweep from
  re-suggesting a pair a human already rejected.
- **`mergeEvent`**: winner, loser, who, when, and the **snapshot jsonb**:
  every repointed or dropped row captured at merge time. There is no unmerge
  executor; this snapshot is the only contract that makes one possible
  later.
- **`link`**: the one edge table. `(fromEntityId, toEntityId, relation,
attrSlug)` where relation is mentions / tagged_in / contact_at /
  derived_from / supersedes / references. For `references`, `attrSlug` names
  the record-reference attribute the edge materializes. `attrSlug` defaults
  to `''` rather than null so the unique edge index has no NULL-distinctness
  loophole. Backlinks are one query on `to_entity_id`.

### `kinds.ts` — per-kind side tables

Doctrine: side tables carry structure, never identity.

- `company` and `person` are single-column kind markers (`entityId` PK).
  Their attributes live in `entity.values`.
- **`space`**: `parentId`, `slug`, **`path ltree`** (materialized path, GiST
  indexed). Slugs are unique per parent, not globally, via two partial
  unique indexes (one for roots because NULL parent defeats a plain
  unique). Same label can recur across branches.
- **`entitySpace`**: composite PK (entityId, spaceId), with `source`
  (manual/ai/inherited) and `confidence`. This is space tagging and, since
  migration 0008, also how notes are filed into spaces.
- **`note`**: `bodyJson` (BlockNote doc) is **authoritative**; `bodyMd` is
  derived on save and feeds search. `tsv` is a Postgres STORED generated
  column (title weighted A, body B), never written by the app. `visibility`
  defaults to shared; private is per-note opt-in.
- **`document`**: `blobSha` is the sha256 content address (same deck
  emailed twice is one blob, two rows), extraction fields
  (`extractedText`, `tsv` written by the worker, `extractionStatus`
  pending/done/unsupported/failed, `extractionError` for the operator).
- **`documentChunk`**: text chunks with `embedding vector(768)` and the
  `embeddingModel` recorded (dimension is baked in, so one embedding model
  per deployment; a model change means a full re-embed). HNSW cosine index
  exists already.
- **`term`**: glossary. name, `aliases text[]`, `definitionMd`, scoped to a
  `spaceId` (or null for global vocabulary).

### `objects.ts` and `attributes.ts` — the two registries

`object` (migration 0016) is the object registry: slug, singular/plural
nouns, `isSystem`. Three seeded system rows — companies, people, deals —
sit in the same table future custom objects will, the system-attribute
pattern one level up. Slugs are plural because custom-object slugs derive
from the plural noun.

`attribute` is one registry row per attribute: `objectId` (FK into
`object`; the old object_kind enum died in 0017), slug, name, type (the
fixed 15-type menu), `options jsonb` (per-type config, shapes documented
in the file), `isSystem` (non-deletable, archivable, options stay
editable), sortOrder. Values do not live here; they live in
`entity.values`. Entities of object kinds carry `entity.object_id` too;
research kinds (space/note/document/term) leave it null, and the kind enum
gained a `custom` member that nothing sets yet.

`attributeEvent` is the per-field history: one row per changed attribute,
written in the same transaction as the value write, with `from`/`to` jsonb.
Deal stage history is just `attr_slug = 'stage'`; the funnel analytics in
chapter 4 derive entirely from this table.

### `views.ts`

`view` is a saved way of looking at one object's records: `filter` (an
array of `{slug, op, value?}` conditions), `sort`, `columns` (TanStack's
visibility state), `extra` for surface-specific state (the deals stage
chips), and `visibility` private/shared. Keyed on `object_id`, so custom
objects get views for free.

It replaced an Attio-style list/entry model (`list`, `listAttribute`,
`listEntry` with its own values jsonb, `listEntryEvent`) that shipped in
migration 0001 and never got used: the product went deals-as-objects, and
the membership-vs-instance question closed the other way — **lists are
views, records are unique** (CONTEXT.md, 2026-09-07). A view holds no
values; anything worth saying about a record is an attribute on the
record, where history, provenance and the context assembler can see it.
Migration 0023 dropped the four tables.

### `interactions.ts`

`interaction` (kind email/meeting/call, `messageId` unique, the RFC822
Message-ID, so the same thread synced from two partners' mailboxes dedupes
to one row), `interactionEntity` (composite PK, the relationship-graph
edge), `signal` and `enrichmentRecord` (provider payloads kept whole as
jsonb, projected out later with per-field provenance). Tables exist from
migration one; Gmail sync itself is post-MVP.

### `activity.ts`

One denormalized stream every producer writes into: `actorId`, `verb`
(deliberately open text, not an enum, so new producers need no migration),
`subjectEntityId`, optional `objectEntityId`, `meta jsonb`. Rationale:
timeline reads dominate, so never UNION five tables at read time.

### `vault.ts`

`credential`: BYOK secrets, `secretEnc bytea` encrypted AES-256-GCM with
AAD binding (chapter 5 covers the crypto). Scope workspace or user;
resolution order is user key, then workspace key, then the feature hides.
`accountConnection`: future Gmail/Calendar OAuth grants, kept apart from
auth on purpose ("login with Google" is not "sync my Gmail").

### `portfolio.ts` — the financial engine's event tables

The doctrine sits in a comment at the top: everything is an append-only
dated event; every aggregate is derived at read, never stored; money stays
in its original currency forever, converted at read time.

- **`holding`**: one per company (unique companyId). No status or value
  columns at all; written-off and exited are derived.
- **`round`**: financing events, ours or not (passed rounds still shape
  dilution). `kind` is free text sharing the funding-stage vocabulary, not
  an enum (narrowing an enum later requires hand-written data deletes; the
  thesis removal in migration 0010 taught that lesson).
  `sharesOutstanding` is fully diluted post-round; it powers the ownership
  ledger. `roundCoInvestor` is the join table; the co-investor graph falls
  out of it.
- **`investment`**: our checks. `instrument` enum (priced,
  safe_post_money, safe_pre_money, ccd) drives the ownership tiers.
  `dealId` nullable (the pipeline seam; null for bootstrap imports).
  `vehicle` is a text label, explicitly not tenancy.
- **`mark`**: fair value over time with a `basis` (round_price, manual,
  409a). Append-only so staleness stays visible.
- **`distribution`**: realized proceeds; kind exit/secondary/dividend/
  **writeoff**. A write-off is amount 0 with kind writeoff.
- **`fxRate`**: sparse manual rates, unique (currency, date), CHECK rate
  positive. Lookup is latest rate at-or-before the event date; a missing
  rate is surfaced, never silently 1.0.

All money columns are `numeric`, which drizzle returns as **strings**.
Chapter 4 shows where they get parsed.

### `tasks.ts` and `templates.ts`

`task`: content, nullable `dueDate` (dateless tasks are legal), assignee,
`doneAt`, with a partial index on open tasks. Deliberately not an entity
kind. `taskEntity` joins tasks to records and is the only cascade FK
outside auth.

`template`: one table, three kinds, `body jsonb` whose shape varies by kind
(note body with mentions stripped, record value defaults, recursive space
scaffold). `suggestOn text[]` is the context hint for pickers. Config, not
entities.

## The queue and the worker

**`src/worker/queues.ts`** is the web↔worker seam: a `QUEUES` map of four
names: `document.extract` (live), `document.embed`,
`entity.dedupe-sweep`, `entity.enrich` (registered stubs, so the seam is
pinned before the features exist).

**`src/lib/queue.ts`** is the web-side sender. Its pg-boss instance is
built with `supervise: false, schedule: false, migrate: false` so the
sender never competes with the worker over housekeeping or races it through
a pg-boss schema migration. `enqueue()` **swallows errors and returns null
by design**: a document whose extraction never got queued is still
openable; the row stays `pending` and can be re-queued. A down queue must
never fail an upload.

**`src/worker/index.ts`** is the worker entrypoint: full pg-boss
(supervision, scheduling, migration on), creates every queue, registers
handlers. `document.extract` runs with `batchSize: 1` because extraction is
CPU-bound and a whole batch on one tick would block the process. A cron
schedules the dedupe sweep nightly at 03:30 UTC. Graceful shutdown on
SIGTERM/SIGINT.

**`src/worker/jobs/extract-document.ts`** is the one real job. Flow: parse
payload with zod, load the document row, fetch bytes from storage,
**re-hash the whole blob and compare to `blobSha`** (the integrity backstop
for S3-compatible stores that don't enforce checksums, like Garage), then
`extractDocumentText`, then a single UPDATE writing `extractedText` and
`tsv` together so they can never disagree. The retry semantics are worth
internalizing: business failures (unsupported format, corrupt blob) are
caught and written to the document row, and the pg-boss job _succeeds_, so
there is no retry storm. Only infra exceptions (DB down) escape to
pg-boss's default retry machinery. The app-level recovery path is the
document row's `pending` status plus a re-queue, not pg-boss state.

End to end: `createDocument` writes rows in a transaction, enqueues
**outside** the transaction, pg-boss stores the job in Postgres (no Redis),
the worker picks it up, the row gets text or an error, the UI polls
`extractionStatus`.

## Build, boot, ops

**`apps/web/package.json`**: `@spaces/web` carries the whole dependency list
and the `#/*` alias, declared twice on purpose — as a package.json subpath
import and as a tsconfig `paths` entry. `tsx` is the one that matters at
runtime, and it reads the **tsconfig** entry (Node rejects `#/*` as an
internal-imports key outright), which is why the image ships `tsconfig.json`
alongside `src/`; `tsx` is a **production** dependency so the worker and
migrations run TypeScript with no bundling. Scripts: `dev` (vite :3000),
`worker`, `db:migrate:run`, `generate-routes`, the drizzle-kit family. The
**root `package.json`** owns lefthook, prettier, eslint and a proxy script per
app script that delegates with `pnpm --filter` (turbo takes those over in
`mono-1b`), plus `lint`/`format`/`check` and the two-tsconfig `typecheck`.
`.env.local` stays at the root, and each loader is anchored to its own file
rather than to cwd — the dev/worker/db scripts through
`dotenv -e ../../.env.local`, `vitest.config.ts` and `drizzle.config.ts`
through `import.meta.url`, vite through `envDir`.

**`docker-compose.yml`** (production): two services. `app` builds from
source, binds `./data:/data` (blobs plus the auto-generated `secret.key`;
back up together with pg_dump). `db` is `pgvector/pgvector:pg17`, which
ships vector, pg_trgm, ltree, and unaccent in one image.

**`docker-compose.dev.yml`**: infra only; the app runs on the host. Postgres
:5432 plus MinIO :9000, which exists solely to develop the S3 storage
driver and never appears in prod compose.

**`Dockerfile`**: node:22-alpine, three stages. The runtime image carries
the compiled Nitro output for the web _and_ the raw `src/` + `drizzle/`
trees, because the worker and migrations run TypeScript directly via tsx.
No build-time env vars, non-root user, `VOLUME /data`, healthcheck on
`/api/health`. The **in-image layout is deliberately unchanged** by the
workspace move: `apps/web/src` is copied to `/app/src` and `apps/web/drizzle`
to `/app/drizzle`, so `docker/entrypoint.sh` needed no edit at all. Two
consequences worth knowing: the prod-deps stage installs with
`--node-linker=hoisted`, because pnpm's default isolated layout would put the
worker's dependencies in `apps/web/node_modules` as relative symlinks that
break the moment the directory is copied; and `/packages/config/tsconfig.base.json`
is copied in so the `extends` in `/app/tsconfig.json` still resolves.

**`docker/entrypoint.sh`** encodes two contracts:

1. Migrations auto-run on every boot, before anything serves; a migration
   failure kills the container.
2. With `ROLE=all` (default), it starts worker and web as two processes and
   polls both PIDs every second; **either process dying kills the
   container** so `restart: unless-stopped` heals it. The earlier version
   waited on the web PID only, which left a crashed worker invisible: a
   "healthy" container where extraction silently never ran. Exit code is 0
   only on operator-requested stop, so `docker ps -a` reads the truth.
   `ROLE=web|worker` enables split-container scale-out later.

## The migration ledger

Sixteen migrations, and the names tell the product's history: 0000
extensions, 0001 the core big bang, 0002 the hand-written operator-class
indexes drizzle-kit can't express (trigram GINs, GiST on ltree, HNSW on
embeddings), 0005 the attribute engine (deals become a kind), 0006
document extraction, 0007 slug-per-parent spaces, 0008 a hand-written data
migration moving note filing into `entity_space`, 0009 search (generated
tsv column, name trigram), 0010 dropping Thesis (the instructive
enum-narrowing pattern: data deletes first, then recreate the enum), 0011
workspace + invites, 0012 mandate, 0013 templates, 0014 the whole portfolio
engine, 0015 tasks, 0016+0017 the object registry (additive migration with
hand-written seed + backfill, then a finalize that drops the old enum — the
two-step shape dodges drizzle-kit's interactive rename prompt). Always
hand-inspect generated SQL; 0008 and 0010 are the precedents for why.

## Invariants to carry forward

- Singleton via CHECK (workspace); one-active via partial unique
  (mandate); ordered pair by app convention (duplicate_candidate);
  NULL-distinctness dodged via partial uniques (space roots) and the `''`
  sentinel (link.attrSlug).
- Append-only families: the four portfolio event tables, attribute_event,
  activity, merge_event.
- `note.tsv` is generated in Postgres; `document.tsv` is written by the
  worker in the same statement as the text. Two different mechanisms, one
  rule: text and its index never disagree.
- Web = pg-boss sender with housekeeping off and non-fatal enqueue; worker
  = full pg-boss plus cron. The database is the only channel between them.
