# CLAUDE.md

Self-hosted deal management for angel/private-capital investing (product name:
Spaces; code still says DealOS). This file is _mechanics only_. Decisions and
domain language live in `CONTEXT.md` (the decision record — read the relevant
block before designing anything); synthesis in `docs/ARCHITECTURE.md`; ADRs in
`docs/adr/`.

## Dev environment

```
docker compose -f docker-compose.dev.yml up -d   # Postgres :5432 + MinIO :9000
pnpm dev                                          # vite, port 3000
pnpm worker                                       # background worker
```

- If the Docker daemon is down: `open -a Docker` first.
- Dev login: `anish@fund.example` (user knows the password). Login lands on
  `/today`; first-run setup lands on `/spaces`.
- The test suite needs Postgres up (8 tests fail without it).

## Gates before any commit

1. `pnpm exec tsc --noEmit`
2. `pnpm exec vitest run` — must be fully green
3. prettier on touched files
4. eslint: a baseline of `no-unnecessary-condition` / `no-unnecessary-type-assertion`
   errors exists and is tolerated — **new error TYPES are not accepted**. If
   unsure whether an error is pre-existing, compare via `git stash`.

## After specific change kinds

- Routes changed → `pnpm generate-routes`
- Schema changed → `pnpm db:generate --name <x>`, then hand-inspect the SQL
- New system attribute → add to `SYSTEM_ATTRIBUTES` in
  `src/lib/attributes/registry.ts`; `pnpm db:migrate:run` reseeds
  insert-if-absent
- New table referencing entities → add it to the merge executor
  (`src/lib/entities/merge.ts`) repoint sections **and** its snapshot. This
  was the worst bug of a review cycle; there is no unmerge executor — the
  snapshot convention is the only contract.

## Git

- One-line commit messages, no co-author trailer.
- Never push unless explicitly asked.

## Traps (each of these has already cost a session)

- `src/lib/server-fns.ts` is a **client-imported barrel**: serverFns + types
  only. Server-side helpers go in `server/shared.ts` (that's why
  `birthHolding` lives there).
- **Never use `Intl.NumberFormat` compact notation** — Node vs Chrome output
  differs → hydration failures. `fmtMoney` hand-rolls compact; use it.
- Radix `asChild` with a custom trigger component: forward `{...props}` or the
  dialog silently never opens.
- Money is drizzle `numeric` → **strings in JS**. Parse with `Number()` at the
  server boundary; pure libs (`src/lib/portfolio/`) take numbers. Dates are
  ISO strings compared lexically.
- The portfolio event tables (investment/mark/distribution/fx_rate) are
  **append-only by design** — no edit/delete paths. The correction policy is
  an open decision; don't add mutation paths casually.

## Browser verification (Chrome MCP)

- MCP synthetic clicks **don't open Radix dialogs** — use `javascript_tool`
  with `element.click()`.
- Beware stale closures when clicking + submitting in the same JS tick (caused
  a phantom "bug" during tasks verification).
- The project verify convention: drive the real dev-DB app for feature
  increments; scratch-env for auth/onboarding flows.
