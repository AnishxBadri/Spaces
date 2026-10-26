# Architecture

How Spaces is put together: what it models, how the code is laid out, and where to look. Rules and their reasons live in `CONTEXT.md`; build mechanics and the gates live in `CLAUDE.md`.

## What it is

A self-hosted deal-management system for angel investors and small funds: one investor by design, up to about fifteen users on one deployment. Two halves on one graph:

- **Research** — spaces, notes and memos, documents, glossary. Slow and exploratory.
- **Deals** — companies, people, deals, interactions. Fast and structured.

A company entering the pipeline already carries the research filed against its spaces. On top sits a **portfolio layer** (rounds, checks, ownership, marks, returns). Everything is BYOK — models, enrichment, storage — and nothing phones home.

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
| Validation | Zod at write paths                  | hand-written, so validators carry business rules                                                                   |
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

Boundaries, enforced by eslint zones in `packages/config`: `db` imports nothing internal; `core` reaches `db` for values only inside `writes/`; `sdk` imports nothing internal; the worker reaches `apps/web/src/lib` only through the `#web/*` alias, for modules not yet moved into core; `site` and `e2e` import nothing internal. In `apps/web`, `#/` means `apps/web/src`.

## How a request flows

**Route → server function → core → database**, with anything slow or CPU-bound queued to the worker.

1. **Routes** — `apps/web/src/routes/`, file-based. `_app.tsx` is the authenticated shell; `_app/` holds one file per surface (`today`, `spaces`, `companies`, `people`, `deals`, `portfolio`, `notes`, `files`, `meetings`, `tasks`, `mandate`, `review`, `ask`, `import`, `settings/*`). A trailing `_` (`companies_.$companyId`) is a detail page outside its list's layout. Custom objects share `o.$objectSlug` and `o_.$objectSlug.$recordId`. `api/` holds the server routes: health, auth, blob, MCP, the external `v1` API, webhooks, OAuth connections, job status.
2. **Server functions** — `apps/web/src/lib/server/`, one file per domain. Auth checks live here, never in the client. `lib/server-fns.ts` is a client-imported barrel: server functions and types only.
3. **Core** — `packages/core/src/`. Everything outside `writes/` is pure and unit-tested: the attribute registry, portfolio maths, the context ranker, the view compiler, date parsing, `canRead`. `writes/` holds the db-coupled half: the attribute write path, identity (resolve, merge, sweep), documents, interactions, the vault, the blob backend, the plugin ports, boot.
4. **Database** — `packages/db/src/schema/`, one file per domain. Migrations generate into `packages/db/drizzle/`.
5. **Worker** — `apps/worker/src/`. `index.ts` registers every queue and runs each job through `run-job.ts`; jobs live in `jobs/` (extraction, embeddings, deck reading, summaries, attribute runs, mailbox and storage polling, sweeps, import commits). `plugins/` loads installed plugins at boot.
6. **Components** — `apps/web/src/components/`: `ui/` primitives, `table/` and `attributes/` (registry-driven tables and fields), `record/`, `editor/`, and one folder per feature.

Data on a page comes from its route loader, which calls server functions; a save calls a server function, then `router.invalidate()` re-runs the active loaders. TanStack Query serves client-driven fetches (the sidebar, Cmd-K, infinite lists).

## The domain model

### Workspace and access

- One workspace per deployment today (a singleton row). One install holding several workspaces is decided, not built.
- First-run signup is open only while no user exists, gated by a setup token printed to the logs; after that, invites only.
- Roles are `admin` and `member`. Every mutation goes through `canWrite()`.
- Rows that can be personal carry an author and a visibility. The default is shared; private is per-row opt-in, enforced in SQL wherever a title or body could leak. `canRead` decides visibility, including for AI context.

### The entity graph

- Everything linkable is an `entity` with a fixed kind: company, person, deal, space, note, document, term, or `custom` (a custom object's record, told apart by `object_id`). Each kind has a side table.
- One edge table, `link`, with relations `mentions`, `tagged_in`, `derived_from`, `supersedes`, `references` (and the retired `contact_at`). Typing `[[Orbital Composites]]` in a note writes a link; record-reference attributes write `references` links in the same transaction, so backlinks, rails and merge share one graph.
- **Resolution** — `resolveEntity()` is the one door every creator uses. Identity attributes (a company's domain, a person's email) auto-attach through `entity_alias`; fuzzy name matches only suggest into the review queue.
- **Merge** repoints every entity-referencing column at write time, from `ENTITY_REFS` in `packages/db/src/entity-refs.ts`, and keeps a snapshot. A new column that points at an entity must be added there; a test fails by name otherwise.

### Objects and attributes

- Companies, people and deals are system objects; custom objects join the same `object` table as attribute bags with dedupe and merge. Notes, spaces and terms are the research layer, not objects.
- All values live in `entity.values` (jsonb, keyed by slug) and change through one write path (`setValues`), which validates, logs and links.
- The type menu is fixed; users define attributes, never types: text, number, currency, date, checkbox, select, multi-select, status, domain, email, url, phone, rating, record and actor references.
- `attribute_event` logs every change in the same transaction, so stage history and time-in-stage come free.
- Attributes flagged filterable or sortable get an expression index from the reconciler, never from a migration.

### Research

- **Spaces** — the investor's own market taxonomy: an ltree hierarchy plus many-to-many tagging (`entity_space`). The hierarchy decides where a note files; tagging handles the cross-cutting.
- **Notes** — BlockNote JSON with markdown derived on save; mentions sync to links. A memo is a presentation of a note, not a separate type.
- **Glossary** — terms per space, inherited down the tree, auto-linked in the editor as decorations.
- **Documents** — entities in their own right: hashed in the browser, uploaded by presigned PUT, filed by `tagged_in`, text extracted by the worker. Storage sources (Drive, Box) bind a folder to a record and sync into the same documents.
- **Search** — one Cmd-K over names, note bodies and extracted text, fused by reciprocal rank in one query, with a semantic lane when embeddings are configured.

### Deals, mandate, templates

- **One deal is one opportunity in one company**; a company can have many over time. Watching a company is space tagging, not a stage. Terminal stages are Invested, Passed (our no) and Lost (their no); deals close, never delete.
- **Mandate** — the fund's strategy: a memo plus stages, geographies and check range. Its one consumer is the outside-mandate hint on a deal.
- **Templates** — saved from a real note, record, space or email, never built in a form. A record template pre-fills the create window visibly.

### Portfolio

- Every portfolio fact is an **append-only dated event**: `round`, `investment`, `mark`, `distribution`, plus `fx_rate` as a lookup. Every aggregate is derived, so an as-of date is a filter.
- A deal reaching Invested births a holding.
- A correction is a compensating event that cites the original, never an edit or a delete.
- Ownership is instrument-aware: a post-money SAFE shows an implied %, pre-money SAFEs and CCDs show cost basis until conversion. A % is never faked.
- Metrics are computed live per holding and in roll-up: cost basis, unrealized and realized value, MOIC, TVPI, RVPI, DPI, gross XIRR. Net IRR, fees and carry are out of scope.
- Money is `numeric` in the database, a string at the server boundary, a number in core.

### AI and integrations

- AI writes are proposals into the review queue, never silent writes. Context for a model comes from the context assembler, which walks the graph from a record and applies `canRead`.
- Ask answers through an in-process client of the MCP tool surface, the same tools external agents use.
- Integrations are plugins (enrichment, mail, calendar, storage, recorders, research). They write through the SDK's ports, which stamp provenance from the installed integration row, never from the plugin.

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
- **Deciding anything** → search `CONTEXT.md` first.
