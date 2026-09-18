# CLAUDE.md

Self-hosted deal management for angel/private-capital investing (product name:
Spaces). This file is _mechanics only_. Decisions and
domain language live in `CONTEXT.md` (the decision record — read the relevant
block before designing anything); synthesis in `docs/ARCHITECTURE.md`; ADRs in
`docs/adr/`.

## Where the work is (read before picking anything up)

- **Linear, team `Spaces` (SPA)** is the store of record for work that is
  scheduled: 134 issues, `SPA-16`…`SPA-150`, across projects 1–13 with 44
  milestones and real blocking relations. An issue body is the spec; do not
  re-derive it. Two saved views are the whole workflow: **grabbable now**
  (`afk`, no open blockers) and **needs me** (`hitl`).
- `docs/roadmap-2026-09.md` — all 23 projects, their order and why, the
  milestones, and the audit findings. Structure only for 1–13, since Linear
  holds those bodies.
- `docs/roadmap-backlog.md` — the 98 slices of projects 14–23, in full. Not in
  Linear on purpose: publish a project when you reach it, not before.
- `docs/decisions-2026-09.md` — the 48 decisions, all closed. A slice labelled
  `hitl` usually is because of one; read its decision before designing.
- Labels that change how you work: **`migration`** means the slice runs
  `db:generate`, and the drizzle journal is a hard serialization point — only
  one migration-bearing issue may be in flight at a time, whatever else is
  running. **`touches:entity-refs`** is the `ENTITY_REFS` class below.

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
4. `pnpm lint` — must be zero errors (the old tolerated baseline was
   eliminated 2026-09; don't reintroduce one). Where drizzle's `const [row] =`
   destructure lies about presence, use the `.at(0)` pattern instead of
   deleting the guard.
5. No v1 design tokens — **`pnpm lint` covers it**, there is no separate gate
   and no grep any more (2026-09-18). `instrument/no-v1-tokens`
   (`eslint-rules/no-v1-tokens.js`) reads className literals and `cn()`/`cva()`
   string arguments in `src/**/*.tsx` and names the Instrument replacement in
   the message, so gate 4 and the pre-commit hook enforce it for free; the dead
   `--color-*` exports are held out of the `@theme` block by
   `src/lib/design-tokens.test.ts` under gate 2. The Instrument vocabulary is
   `text-graphite`, `border-rule`, `bg-bone`, `bg-paper`, `text-label`,
   `rounded-md` (2px) / `rounded-none`.

Pre-commit hooks (lefthook) run prettier + eslint on staged files; pre-push
runs tsc. CI (`.github/workflows/ci.yml`) runs prettier, eslint, tsc and vitest
against a real Postgres — and since gate 5 is an eslint rule, CI enforces all
five.

## After specific change kinds

- Routes changed → `pnpm generate-routes`
- Schema changed → `pnpm db:generate --name <x>`, then hand-inspect the SQL
- New system attribute → add to `SYSTEM_ATTRIBUTES` in
  `src/lib/attributes/registry.ts`; `pnpm db:migrate:run` reseeds
  insert-if-absent
- New column referencing an entity → add an entry to `ENTITY_REFS`
  (`src/db/entity-refs.ts`) declaring both the merge strategy and the
  context role; `entity-refs.test.ts` diffs the list against drizzle's FK
  metadata and fails naming the column otherwise. A `custom` merge strategy
  still needs its section in `src/lib/entities/merge.ts` **and** its
  snapshot. This was the worst bug of a review cycle; there is no unmerge
  executor — the snapshot convention is the only contract.

## Backend paradigm (Effect ratchet — CONTEXT.md "Backend paradigm" is the contract)

- **All new server code is Effect-first** (v4); existing modules convert only
  when already open for behavioral change, in the same PR. Effect never
  crosses into React — the seam is the `effectFn()` adapter (server-fns) /
  HttpApi handlers (`effect/unstable/httpapi`; decision 3 amended 2026-09-16,
  oRPC dropped before it was ever installed).
- Writing Effect: invoke the vendored `effect-ts` skill; it defers to
  `node_modules/effect/AGENTS.md` (version-matched guidance).
- TanStack guidance: the installed packages ship their own `SKILL.md`
  (TanStack Intent) — check `node_modules/@tanstack/*` before guessing APIs.

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
  **append-only by design** — no edit/delete paths. ~~The correction policy is
  an open decision~~ — **decided 2026-09-18 (D12): reversal by compensating
  event.** Each event table gains a nullable self-referencing `reverses_id`;
  a void flow appends an exact-negative event citing the original, and a
  batch reversal undoes a whole import. Portfolio math sums as before, the
  timeline shows both rows, and history stays information. Still never add an
  edit or delete path — the correction is an append like everything else.
  See `docs/decisions-2026-09.md`.

## Browser verification (Chrome MCP)

- MCP synthetic clicks **don't open Radix dialogs** — use `javascript_tool`
  with `element.click()`.
- Beware stale closures when clicking + submitting in the same JS tick (caused
  a phantom "bug" during tasks verification).
- The project verify convention: drive the real dev-DB app for feature
  increments; scratch-env for auth/onboarding flows.
