# Codebase map

_A navigation aid: where things live, how a request flows, and where each
architectural decision is recorded. Mechanics/conventions live in `CLAUDE.md`;
the decision record is `CONTEXT.md`; product synthesis is
`docs/ARCHITECTURE.md`. Reading order for a newcomer: `ARCHITECTURE.md` →
this file → CONTEXT.md blocks as needed._

## Top-level layout

```
CLAUDE.md               agent/dev mechanics card (gates, traps, commands)
CONTEXT.md              THE decision record — every design block, dated
DESIGN.md / PRODUCT.md  early shaping docs (CONTEXT.md supersedes on conflict)
docs/
  ARCHITECTURE.md       full product synthesis (fastest onboarding read)
  adr/                  formal ADRs (e.g. 0001 deals-are-an-object)
  survey-*.md           prior-art studies (Twenty sync; Attio attribute model)
  spec-*.md             buildable specs (attribute engine / custom objects; AI substrate)
  tour/                 file-by-file walkthrough (deeper than this map)
  CODEBASE.md           this file
drizzle/                generated SQL migrations, numbered (0001…0023)
docker-compose.yml      production self-host (app + pgvector), build-from-source
docker-compose.dev.yml  dev Postgres :5432 + MinIO :9000
Dockerfile + docker/entrypoint.sh   web+worker supervision, auto-migrate on boot
scripts/backup.sh       both-or-neither backup (pg_dump + ./data tarball)
src/                    everything below
```

## The layers (and the request flow)

A page load or mutation flows: **route → server function → domain lib → db**,
with the worker handling anything CPU-bound asynchronously.

### 1. Routes — `src/routes/` (TanStack Router, file-based)

- `__root.tsx`, `_app.tsx` — shells; `_app/` is the authenticated app.
- Top-level: `index.tsx` (redirects → /today), `login.tsx`, `setup.tsx`
  (first-run wizard, setup-token), `join.tsx` (invites).
- `_app/`: one file per surface — `today` (attention landing), `spaces` +
  `spaces_.$spaceId`, `companies`, `people`, `deals` (table/board toggle),
  `portfolio` + `portfolio_.$holdingId`, `notes`, `tasks`, `mandate`,
  `dedupe`, `settings` + `settings_.objects.$objectSlug`. Custom objects
  share two generic routes — `o.$objectSlug` (the table) and
  `o_.$objectSlug.$recordId` (the record). The `x_.$xId` convention =
  detail page.
- `api/`: `health.ts` (checks DB), `auth/`, `blob/` (document serving).
- Route changes require `pnpm generate-routes` (see CLAUDE.md).

### 2. Server functions — `src/lib/server/` (one file per domain)

The only write path. Auth checks live here — never in the client. Files:
`companies` `people` `deals` `objects` `attributes` `views` `notes`
`documents` `spaces` `interactions` `timeline` `search` `dedupe` `glossary`
`mandate` `members` `portfolio` `tasks` `templates` `settings` — plus
**`shared.ts`** for private cross-domain helpers (e.g. `birthHolding`, the
Invested→holding seam).

**Trap:** `src/lib/server-fns.ts` is the barrel call sites import from, and it
is **client-imported** — serverFns + types only, helpers go in `shared.ts`.

New server code is Effect-first (CLAUDE.md "Backend paradigm"); `effect.ts`
holds the one `effectFn()` seam that runs an Effect program inside a
server-fn handler. Effect never crosses into React.

### 3. Domain libs — `src/lib/*/` (pure logic, unit-tested, no db)

- `attributes/` — **the attribute engine.** `registry.ts` holds
  `SYSTEM_ATTRIBUTES`, `CORE_OBJECTS`, and per-type config; the registry
  generates table columns, create-modal fields, and record rails. Since
  0016, attributes key on the `object` table (`object_id` FK, three seeded
  system rows) rather than a kind enum — `objects.ts` resolves kind →
  object id (Effect-first, the repo's first Effect module). Adding a system
  attribute: registry + `pnpm db:migrate:run` (reseeds insert-if-absent).
- `entities/` — identity: `resolve.ts` (aliases → entity, collisions →
  duplicate_candidates), `normalize.ts`, `merge.ts` (**the merge executor** —
  it iterates `ENTITY_REFS` (`src/db/entity-refs.ts`) for generic repoints
  and keeps a hand-written section per `custom` strategy; no unmerge exists,
  so the snapshot is the only contract).
- `context/` — **the context assembler** (`docs/spec-ai-substrate.md` §1):
  `types.ts` (the `ContextItem` shape, kinds, hops, edges), `ref.ts` (the
  citation-ref grammar — one builder, one parser), `render.ts` (values →
  the plain-text line a model sees), `rank.ts` (pure ranker: hop × edge ×
  kind prior × recency, RRF lexical lane, standing slice for
  mandate/glossary; `asOf` is an input, so it is snapshot-tested), and
  `assemble.ts` — the db half, Effect-first: it walks the graph outward from
  one record, applies `canRead` in SQL, and re-checks every item against
  visibility before returning (the output-leak invariant). No model, no key.
- `views/` — saved views: `filter.ts` (typed condition ops, evaluated over
  loaded rows — tables aren't paginated), `store.ts`.
- `portfolio/` — pure math, takes numbers: `xirr.ts` (Newton+bisection),
  `metrics.ts` (MOIC/TVPI/DPI kit), `ownership.ts` (tiered: actual / implied
  / cost-basis-only — never fake a %), `fx.ts`, `format.ts`.
- `tasks/parse-due.ts` — NL date parser for the task composer.
- `documents/`, `glossary/` (Aho-Corasick term autolink), `storage/`
  (local/S3 drivers), `vault/` (BYOK key encryption; `key.ts` =
  MASTER_KEY/secret.key), `seeds/` (demo data).
- Root of lib: `auth.ts`/`auth-client.ts`, `format.ts` (**`fmtMoney`
  hand-rolls compact — never Intl compact**), `queue.ts` (pg-boss),
  `setup-token.ts`, `utils.ts`.
- Tests are colocated (`*.test.ts`); suite needs Postgres up.

### 4. Database — `src/db/schema/` (drizzle, one file per domain)

`entities.ts` (the spine: entity + kind side tables + link + entity_space +
alias + duplicate_candidate), `objects.ts` (the object registry — three
seeded system rows plus custom objects), `attributes.ts` (registry rows +
values + attribute_event log), `views.ts` (saved filters/columns/sort per
object; `lists.ts` died in 0023 — lists are views), `portfolio.ts`
(holding/round/investment/mark/distribution/fx_rate — **append-only**),
`tasks.ts`, `interactions.ts`, `activity.ts`, `workspace.ts`, `auth.ts`,
`vault.ts`, `templates.ts`, `kinds.ts`, `helpers.ts`. Migrations generate
into `drizzle/` — hand-inspect the SQL every time.

**`entity-refs.ts` sits beside the schema, not in it:** `ENTITY_REFS` is the
one list of every column that points at an entity, each entry declaring a
merge strategy (`repoint` / `repoint-or-drop` / `custom` / `none`) and a
context role (`item` with a kind + hop, `traverse`, or an explicit `null` =
never AI-visible). `merge.ts` iterates it for every generic repoint and
fails at import if a `custom` entry names a handler nobody wrote;
`entity-refs.test.ts` diffs the list against drizzle's FK metadata, so a new
entity-referencing column that skips the registry fails CI by name. The
`context` roles are declared but not yet iterated — `lib/context/assemble.ts`
still hand-walks its tables, and closing that loop is what stops a new edge
table from silently vanishing from "everything about this record".

### 5. Worker — `src/worker/` (pg-boss)

CPU-bound work only; web must never run it inline. Currently
`jobs/extract-document.ts` (text extraction/embedding). Dev runs it as
`pnpm worker`; prod entrypoint supervises both processes (either dies →
container exits).

### 6. Components — `src/components/`

`ui/` (shadcn primitives), `table/` + `attributes/` (registry-driven record
tables and fields), `editor/` (notes editor), and feature components named
what they are: `deal-board`, `record-timeline`, `tasks-rail`,
`task-composer`, `command-palette`, `getting-started`, `space-glossary`,
`document-preview`, `app-sidebar`.

## Feature → files, quick index

| Feature                   | Look at                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deal pipeline/board       | `routes/_app/deals.tsx`, `components/deal-board.tsx`, `lib/server/deals.ts`                          |
| Today page                | `routes/_app/today.tsx`, aggregation in `lib/server/timeline.ts` + domain fns                        |
| Portfolio                 | `routes/_app/portfolio*.tsx`, `lib/server/portfolio.ts`, `lib/portfolio/*`, `db/schema/portfolio.ts` |
| Invested → holding        | `birthHolding` in `lib/server/shared.ts` (both updateRecord and createDeal paths)                    |
| Attribute engine          | `lib/attributes/registry.ts`, `components/attributes/`, `db/schema/attributes.ts`                    |
| Identity / dedupe / merge | `lib/entities/*`, `routes/_app/dedupe.tsx`                                                           |
| Spaces / taxonomy         | `routes/_app/spaces*.tsx`, `lib/server/spaces.ts`, ltree paths in `db/schema/entities.ts`            |
| Notes / memos             | `routes/_app/notes*.tsx`, `components/editor/`, mentions-sync in `lib/server/notes.ts`               |
| Documents pipeline        | `lib/server/documents.ts` → queue → `worker/jobs/extract-document.ts`; `lib/storage/`                |
| Tasks                     | `components/task-composer.tsx`, `lib/tasks/parse-due.ts`, `lib/server/tasks.ts`                      |
| Mandate                   | `routes/_app/mandate.tsx`, `lib/server/mandate.ts`                                                   |
| BYOK / vault              | `lib/vault/`, settings surface in `lib/server/settings.ts`                                           |
| Custom objects            | `db/schema/objects.ts`, `lib/server/objects.ts`, `routes/_app/o.$objectSlug.tsx`                     |
| Saved views               | `db/schema/views.ts`, `lib/views/filter.ts`, `lib/server/views.ts`                                   |
| AI context assembly       | `lib/context/` (ranker + assembler), `db/entity-refs.ts`, spec in `docs/spec-ai-substrate.md`        |
| Auth / setup / invites    | `routes/setup.tsx`, `routes/join.tsx`, `lib/auth.ts`, `lib/setup-token.ts`, `lib/server/members.ts`  |

## The architectural spine (with pointers into CONTEXT.md)

These six decisions shape everything; each has a dated CONTEXT.md block with
the full reasoning:

1. **One entity graph.** Every kind (company, person, org, space, note,
   document) is a row in `entity` with a side table; relationships are `link`
   rows; space membership is `entity_space` (many-to-many, with
   source/confidence). Deals are an object, not list entries (ADR 0001).
2. **The attribute engine grows, objects don't.** Fixed type menu, user-owned
   vocabulary, registry-generated UI. Spaces-vs-attributes boundary: markets
   and approaches are spaces (hierarchical, researchable); business facets
   are attributes. Industry never becomes an attribute.
3. **Spaces are a tree; the graph lives in membership.** Mono-hierarchy +
   many-to-many tagging, polyhierarchy rejected; symlink nodes are the
   designated future escape hatch.
4. **Append-only events + per-field history.** Portfolio tables and
   `attribute_event` are logs, not state; ownership is computed, never faked.
   Money = numeric strings at the boundary, numbers in pure libs.
5. **Machine writes are gated by claim type** (decided 2026-08-08): sourced
   facts fill blanks with receipts; generated or conflicting values wait in a
   `suggestion` table for a human. AI context assembly routes through
   canRead. This doctrine governs the whole integrations phase (suggestion
   substrate → BYOK AI → Apollo → Google Workspace).
6. **Self-host contract.** `docker compose up` first try; required env frozen
   at `{DATABASE_URL, APP_URL}`; migrations auto-run; no build-time env; the
   app never terminates TLS; backup is both-or-neither (see the six
   hostability contracts in CONTEXT.md).

## Where to look when…

- _…adding any column that references an entity_ → `db/entity-refs.ts`
  first (merge strategy + context role), then the schema; a `custom`
  strategy also needs its section in `lib/entities/merge.ts` and its
  snapshot.
- _…adding a system attribute_ → `lib/attributes/registry.ts`.
- _…touching money display_ → `lib/format.ts` (`fmtMoney`), never Intl compact.
- _…adding a route_ → `routes/_app/`, then `pnpm generate-routes`.
- _…adding background work_ → `lib/queue.ts` + `worker/jobs/`.
- _…deciding anything_ → search CONTEXT.md first; if it's a new decision,
  record it there with a date.
