# CLAUDE.md

Self-hosted deal management for angel and private-capital investing (product name: Spaces). This file is mechanics only.

## Where things are

- `docs/architecture.md`: how the system is now, packages, request flow, the domain model and its language. Read the relevant section before designing anything.
- `docs/decisions.md`: the decision ledger, each decision's current answer and reason. A `hitl` slice usually waits on one.
- `docs/roadmap.md`: shipped, open (one line and the Linear id per slice), next. `docs/considerations.md`: undecided ideas only.
- `docs/spec-plugin-sdk.md`: the plugin contract. `docs/design-contract.md`: what to do before writing tsx.
- **Linear, team `Spaces` (SPA)**, is a rolling window of live work: new and unfinished projects and what is in build. An open slice's spec is its issue body; do not re-derive it. Shipped issues are closed and archived; the repo holds the history. Saved views: **grabbable now** (`afk`, no open blockers) and **needs me** (`hitl`). A cloud agent without Linear gets the body in its dispatch prompt.
- Labels: **`migration`** runs `db:generate`, and the drizzle journal is a hard serialization point: one migration-bearing issue in flight at a time. **`touches:entity-refs`** is the `ENTITY_REFS` class below.

## Dev environment

```
docker compose -f docker-compose.dev.yml up -d   # Postgres :5432 + MinIO :9000
pnpm dev                                          # turbo `dev`: vite on :3000 and the worker in watch mode
pnpm worker                                       # the worker alone, no watch
pnpm e2e                                          # Playwright, not a gate
```

- Docker daemon down: `open -a Docker`. Dev login `anish@fund.example` (the user knows the password).
- Run everything from the root. One package: `pnpm exec turbo run test --filter=@spaces/web`. `worker`, `preview` and `db:*` are plain `--filter` proxies outside turbo. The turbo cache is local (`.turbo/`).
- `.env.local` lives at the repo root; every loader is anchored to its own file, not to cwd. `dataDir()` is anchored to the directory holding `pnpm-workspace.yaml`, so an unset `DATA_DIR` means `<repo>/data` and `secret.key` survives a cwd change.
- e2e creates and drops its own `spaces_e2e_<pid>_*` databases. With `E2E_IMAGE_URL` set it runs `specs/image/` against a composed container (CI's `image-smoke`, required for a release). First run: `pnpm --filter @spaces/e2e exec playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Package fences

The package map is in `docs/architecture.md`. What bites when you edit:

- `packages/core` is two halves that `src/purity.test.ts` keeps apart by directory: outside `src/writes/` is pure and takes `@spaces/db` types only; `src/writes/` is the only place a `drizzle-orm` or `db` value import passes. Only `writes/vault/`, `writes/storage/` and `writes/plugins/first-boot.ts` read `process.env`, so an env-reading enqueue such as `enqueueSourceEmbed` stays in apps/web.
- `apps/worker` reaches `apps/web/src/lib` and `test/` only through the `#web/*` alias. The eslint zone `WORKER_NEVER_WEB_NEVER_PLUGINS` lists every crossing and bans `#/` and relative climbs. Run `pnpm run knip` before adding a crossing or pushing a deletion.
- `packages/sdk` exports `dist/` (a plugin bundle imports it bare at runtime), so turbo's `^build` builds it before any dependent task. The worker's `host-resolve.ts` hands a bundle's `effect`/`@spaces/sdk` imports the worker's copies. `packages/sdk/src/fence.test.ts` proves the sdk and plugin zones.
- `plugins/*` depend on `@spaces/sdk` only. The root `eslint.config.js` and `prettier.config.js` are one-line shims over `packages/config`, because both tools resolve config from cwd and the zone globs are root-relative.

### Test databases

- The suite needs Postgres and never touches the dev database. Each package's `globalSetup` derives `DATABASE_URL_TEST` (default: `DATABASE_URL` with `_test` appended), creates, migrates and seeds it. `spaces_test` is the reference database; no test writes it.
- Isolation is per file: a `setupFiles` entry truncates every `public` table and reseeds before each file. Add no cleanup and no delete list.
- One database per vitest worker (web and worker: `TEST_WORKERS` in `packages/db/src/test-db.ts`; db and core: `fileParallelism: false`), so a truncate never reaches another running file. Drop any `spaces_test*` database any time.
- The harness never drops a database. A global setup that seeds the reference database passes its seed to `prepareTestDatabase`, which holds the harness advisory lock.

## Gates before any commit

1. `pnpm typecheck` (`turbo run typecheck typecheck:root`). A bare root `tsc` checks only `scripts/` and the shims.
2. `pnpm test` (`turbo run test test:root`), fully green.
3. `pnpm exec prettier --check <touched files>` from the root.
4. `pnpm lint` (`turbo run lint lint:root`), zero errors, no baseline. Where drizzle's `const [row] =` lies about presence, use `.at(0)` rather than deleting the guard.
5. Instrument vocabulary, inside gate 4: `instrument/vocabulary` (`packages/config/eslint-rules/vocabulary.js`) checks className literals and `cn()`/`cva()` strings in `apps/web/src/**/*.tsx`, raw colours included; `apps/web/src/lib/design-tokens.test.ts` keeps dead `--color-*` exports out of `@theme`. Vocabulary: `text-graphite`, `border-rule`, `bg-bone`, `bg-paper`, `text-label`, `rounded-md` (2px) / `rounded-none`.

- A repeat run with nothing changed replays the cache. That is honest only because `turbo.json` names every input outside the package; a gate that reads a new outside file needs it added there. `--force` re-runs.
- lefthook: pre-commit runs prettier and eslint on staged files, pre-push `pnpm run typecheck`. CI (`.github/workflows/ci.yml`) runs one named step per gate on a real Postgres: prettier, lint, knip, typecheck, `boot.ts` on an empty database, test, `turbo run build`. CI writes no `.env.local`.

## Principles (each has an enforcer)

- A type is a claim the compiler checked (`@typescript-eslint/consistent-type-assertions: never`).
- Boundary data is typed once, at the column or a decode (`jsonb().$type<…>()` on every jsonb column; `packages/db/src/json.ts`).
- `undefined` is a type, not a state (`exactOptionalPropertyTypes`).
- Attribute values have one write path that validates, logs and links (`no-restricted-syntax` on `entity.values`; `packages/core/src/writes/attributes/values.ts`).
- Portfolio history is append-only; a correction is a compensating event (`apps/web/src/lib/portfolio/reverse.ts`, the `<table>_reverses_unique` partial indexes, `packages/core/src/portfolio/reversal.ts`).
- Effect never crosses into React; the seam is `effectFn()` (`no-restricted-imports` on `effect` in `apps/web/src/routes/**` and `apps/web/src/components/**`).
- I/O is an Effect program; pure helpers, type modules and client code stay plain (`effect/io-is-effect`, `packages/config/eslint-rules/io-is-effect.js`; an exempt file says why in an `eslint-disable`).
- A server-fn `.validator()` is an Effect schema through `input()` (`apps/web/src/lib/server/input.ts`; `lib/server/tasks.ts` is the reference). No new file imports `zod`.
- `noUncheckedIndexedAccess` stays off; production uses `.at(0)`. Don't re-litigate it.

Writing Effect: invoke the `effect-ts` skill (it defers to `node_modules/effect/AGENTS.md`). TanStack packages ship their own `SKILL.md` under `node_modules/@tanstack/*`.

## Comments

- The why, not the what: intent, assumptions, trade-offs. Keep every warning and invariant.
- `/** */` on an export describes it for its caller; `//` in a body explains a non-obvious step.
- Write for the reader of the current code: no issue or decision ids, dates, "used to", "moved from". `comments/no-history` (gate 4) rejects ids and ISO dates.
- Don't repeat the types. One line ideal, five max. Name symbols, not paths. Link out only for external facts. Leave a correct, short comment alone.

## After specific change kinds

- **Routes** → `pnpm generate-routes`. `build` does not depend on it: `vite build` writes its own `routeTree.gen.ts`, keeping the `declare module '@tanstack/react-start'` block the CLI strips. The CLI's diff against the committed tree is pre-existing; leave it.
- **Schema** → `pnpm db:generate --name <x>`, then read the SQL. A hand-written migration writes its own journal entry with `when` from `date -u +%s000`, never a future value: the migrator and downgrade guard order by `when`. Never edit an applied migration's file: the guard refuses to boot on a changed hash.
- **A plugin, the sdk or core changes what it ships** → `pnpm release:bump <core|sdk|plugin id> <patch|minor|major>` in the same commit. `pnpm release:tag` tags locally only; the Tag workflow pushes on main.
- **New system attribute** → `SYSTEM_ATTRIBUTES` in `packages/core/src/attributes/registry.ts`, then `pnpm db:migrate:run` (insert-if-absent).
- **`attr_idx_*` indexes are the reconciler's, never the journal's.** A filterable/sortable attribute gets `attr_idx_<attribute id>` on `(object_id, spaces_json_text|number(values -> '<slug>'))`. `reconcileValueIndexes()` (`packages/db/src/value-indexes.ts`) mints and drops them `CONCURRENTLY` at boot and from the attribute server fns **after** the write commits, never inside a transaction. **Never `db:push` or `db:pull`**: they would drop every one. The expression must match `compileSortKey` (`apps/web/src/lib/views/sql.ts`) exactly or the index sits unused; `value-index-plan.test.ts` is the EXPLAIN check.
- **New column referencing an entity** → an `ENTITY_REFS` entry (`packages/db/src/entity-refs.ts`) with merge strategy and context role; `entity-refs.test.ts` fails naming the column otherwise. A `custom` strategy also needs its section in `packages/core/src/writes/entities/merge.ts` and its snapshot. There is no unmerge; the snapshot is the contract.

## Traps (each has cost a session)

- `apps/web/src/lib/server-fns.ts` is a **client-imported barrel**: server fns and types only. Only `createServerFn().handler()` bodies are stripped, so a plain export from a `lib/server/*.ts` module it re-exports ships to the browser. Helpers go in `server/shared.ts` or further out (`birthHolding` lives in `lib/portfolio/holding.ts`); a helper a test calls without a request lives outside `lib/server/`.
- **Never use `Intl.NumberFormat` compact notation**: Node and Chrome differ and hydration fails. Use `fmtMoney`.
- Radix `asChild` with a custom trigger: forward `{...props}` or the dialog never opens.
- Money is drizzle `numeric`, so **strings in JS**: `Number()` at the server boundary; `packages/core/src/portfolio/` takes numbers. Dates are ISO strings compared lexically.
- **Portfolio events never get an edit or delete path.** `investment`, `mark` and `distribution` carry `reverses_id` and `batch_id`. A void appends the exact negative dated as the original; the partial unique index on `reverses_id` makes a double void a database error; a batch void reverses a whole `batch_id` in one transaction or refuses. `fx_rate` is a lookup: `setFxRate` upserts on `(currency, date)`.
  - Readers: `apps/web/src/lib/portfolio/detail.ts` hands the pure libs originals only, stamped `reversedAt`, and `@spaces/core/portfolio/reversal` drops an event once the as-of day reaches it. Nothing derived leans on the negation; it is stored so raw SQL `SUM` stays honest.
  - The void flow's tagged errors carry an empty `message`; the dialog shows `ledgerVoidMessage`.

## Git

One-line commit messages, no co-author trailer. Never push unless asked.

## Cloud sessions

A cloud session sees this repo and nothing from `~/.claude`. `.claude/settings.json` runs `scripts/cloud-session-start.sh` (Postgres with pgvector ≥ 0.8, then `pnpm install`; a no-op outside the cloud). The env sets only `DATABASE_URL`, as CI does.

- One session implements one SPA issue from its body: all five gates, a branch named for the issue, push, open a PR. Never commit to `main`; the owner merges.
- `migration` issues run one at a time across all sessions.
- A session that needs a `hitl` decision stops and says so; it does not guess.

## Browser verification (Chrome MCP)

- Synthetic clicks don't open Radix dialogs; use `javascript_tool` with `element.click()`.
- Clicking and submitting in the same JS tick hits stale closures.
- Drive the real dev-DB app for feature work; a scratch env for auth and onboarding.
