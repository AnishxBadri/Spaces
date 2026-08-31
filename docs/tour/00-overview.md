# Codebase tour — start here

This folder is a file-by-file walkthrough of the repo, written for reading the
code alongside it. It goes deeper than `docs/CODEBASE.md` (the one-page
navigation map): every file gets its role, its exports, and the reasoning you
can't see from the code alone. The decision record behind all of it is
`CONTEXT.md`; the product synthesis is `docs/ARCHITECTURE.md`.

## What you're looking at

A self-hosted deal-management OS for angel investors and small funds. Two
halves on one entity graph:

- a research half (spaces, memos, glossary, documents), shaped like a PKM tool
- a deal half (companies, people, deals, pipeline), shaped like a CRM

plus a financial layer (holdings, checks, marks, distributions) that turns the
CRM into fund management. One Postgres database carries everything: relational
data, background jobs (pg-boss), search (tsvector + pg_trgm), hierarchy
(ltree), and eventually vectors (pgvector).

Two Node processes, one database, one blob location:

```
Browser (React SPA) ── typed server functions ──┐
                                                ├── Postgres 17
Worker (pg-boss consumer) ──────────────────────┘
                                                └── blobs: local disk or S3
```

## The request flow

Every page load and mutation flows the same way:

```
route (src/routes/) → server function (src/lib/server/) → domain lib (src/lib/*/) → db (src/db/)
```

The worker picks up anything CPU-bound (document text extraction) through
pg-boss, which is itself just Postgres tables. There is no third service.

## Reading order

Each chapter is self-contained, but they build on each other in this order:

1. **[01-foundation.md](01-foundation.md)** — boot, env, the database schema
   (all tables), migrations, the queue, the worker. Read the schema chapter
   slowly; every other layer is a view over these tables.
2. **[02-entity-graph.md](02-entity-graph.md)** — the identity layer:
   `entity`, `link`, aliases, `resolveEntity()`, normalization, merge. The
   part most code depends on.
3. **[03-attribute-engine.md](03-attribute-engine.md)** — the registry that
   generates table columns, create modals, and record rails from one
   definition; the `setValues` write path; `attribute_event` history.
4. **[04-server-functions.md](04-server-functions.md)** — the only write
   path. One file per domain under `src/lib/server/`, the auth model, and the
   `server-fns.ts` barrel trap.
5. **[05-pure-libs.md](05-pure-libs.md)** — the unit-tested logic with no db:
   portfolio math (XIRR, ownership tiers), storage drivers, the vault,
   document extraction, formatting.
6. **[06-routes.md](06-routes.md)** — every URL, its loader, its search-param
   state, and which server functions it calls.
7. **[07-components.md](07-components.md)** — the record table, the editor,
   the deal board, and the smaller feature components.

If you want the fastest possible orientation instead: read chapter 1's schema
section, then chapter 2, then open `src/lib/server/deals.ts` and trace one
mutation end to end.

## Six decisions that explain most of the code

You'll hit these over and over; each has a dated block in `CONTEXT.md` with
the full reasoning.

1. **One entity graph.** Everything linkable is a row in `entity(id, kind)`
   with a side table per kind; relationships are rows in one `link` table;
   space membership is `entity_space`. Deals are objects, not list entries.
2. **Attributes grow, objects don't.** Users define attributes from a fixed
   type menu; they never define new object types. All values live in one
   jsonb column, validated by one Zod validator per type.
3. **Spaces are a tree.** ltree mono-hierarchy for filing, many-to-many
   tagging for everything cross-cutting. Deliberately a taxonomy, not an
   ontology.
4. **Append-only where history is information.** Portfolio events and
   `attribute_event` are logs, not state. Ownership and every fund metric are
   computed live, never stored. Money is a numeric string until the server
   boundary parses it.
5. **Machine writes are gated by claim type.** Sourced facts can fill blanks
   with receipts; generated judgment waits in a suggestion queue for a human.
   Nothing AI-written lands silently.
6. **The self-host contract.** Two containers, required env frozen at
   `{DATABASE_URL, APP_URL}`, migrations auto-run, TLS always behind a proxy.

## Conventions to know before reading code

- **Money** is drizzle `numeric`, which means strings in JS. Server functions
  parse with `Number()` at the boundary; pure libs under `src/lib/portfolio/`
  take numbers. Dates are ISO strings compared lexically.
- **`src/lib/server-fns.ts` is client-imported.** It may contain serverFn
  wrappers and types only. Server-side helpers live in
  `src/lib/server/shared.ts`.
- **Never `Intl.NumberFormat` compact notation.** Node and Chrome disagree,
  which breaks hydration. `fmtMoney` in `src/lib/format.ts` hand-rolls it.
- **New table referencing entities** → add it to the merge executor
  (`src/lib/entities/merge.ts`), both the repoint section and the snapshot.
- **Route changed** → `pnpm generate-routes`. **Schema changed** →
  `pnpm db:generate --name <x>`, then read the generated SQL yourself.
- Tests are colocated (`*.test.ts`) and the suite needs the dev Postgres up.
