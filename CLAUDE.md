# CLAUDE.md

Self-hosted deal management for angel/private-capital investing (product name:
Spaces). This file is _mechanics only_. Decisions and
domain language live in `CONTEXT.md` (the decision record — read the relevant
block before designing anything); synthesis in `docs/ARCHITECTURE.md`; ADRs in
`docs/adr/`.

## Where the work is (read before picking anything up)

- **Linear, team `Spaces` (SPA)** is the store of record for work that is
  scheduled: 139 issues, `SPA-16`…`SPA-155`, across projects 1–13 with 44
  milestones and real blocking relations. An issue body is the spec; do not
  re-derive it. Two saved views are the whole workflow: **grabbable now**
  (`afk`, no open blockers) and **needs me** (`hitl`).
- `docs/roadmap-2026-09.md` — all 23 projects and their order (1–12 as a
  shipped list), the milestones of 13–23, the decisions still ahead with
  their options, open audit findings and the audit's cut list.
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
pnpm dev                                          # turbo `dev`: vite on :3000 and the worker (tsx watch)
pnpm worker                                       # the worker alone (apps/worker, no watch)
```

- **pnpm workspace since 2026-09-19 (SPA-101).** The app is `apps/web`
  (`@spaces/web`); `packages/config` holds `tsconfig.base.json`;
  **`packages/db` (`@spaces/db`) holds the drizzle schema, the `drizzle/`
  journal, `drizzle.config.ts`, `ENTITY_REFS`, the worker heartbeat, the
  downgrade guard and `runMigrations()`** (SPA-142) — it depends on
  drizzle-orm, pg and zod and on nothing internal, so don't reach into
  `apps/web` from it. **`packages/core` (`@spaces/core`) is the domain in
  two halves that `src/purity.test.ts` keeps apart by directory** (mono-7,
  narrowed by SPA-174): everything outside `src/writes/` computes and may
  reach `@spaces/db` for types only; `src/writes/` is the db-coupled half —
  the attribute engine (`writes/attributes/*`, with `seed.ts`), the identity
  write path (`writes/entities/*`: resolve, merge, sweep, delete, rename,
  provenance), the view store, `chunk-sources` (SPA-174/175), the BYOK
  vault (`writes/vault/*`, SPA-176), the blob backend (`writes/storage/*`,
  SPA-178; `./writes/storage/local`'s token helpers are public on purpose for
  the blob route), the live plugin ports (`writes/ports/*`, SPA-197 on:
  Layer constructors over the bound `integration` row — Config, Secrets,
  Log, and Http with its per-process throttle; Read since SPA-198;
  Identity and Receipts since SPA-199, whose provenance — `source_ref`,
  `enrichment_record.integration_id`, `signal.source_class`/`source_ref`
  (migration 0056) — comes from the row, never the plugin, and whose
  handed-back work goes through core's `Enqueue` service
  (`@spaces/core/queue/enqueue`; the worker's Live is
  `apps/worker/src/plugins/enqueue.ts`, on `createSender`)), the
  graph's read half (`writes/read/*`, SPA-198: MCP's `get_record` program,
  `entitySearchRows`, and the lexical fused search statement with
  `canReadNoteSql` — apps/web re-exports all three and keeps only the
  semantic lane), the write lanes the ports and apps/web share — the
  integration interaction writer (`writes/interactions/write.ts`, SPA-200:
  row, body note, edges, dedupe by `message_id`; the mailbox and
  `Content.logInteraction` both call it), document birth, intake and
  prepare (`writes/documents/*`, SPA-201: the extraction enqueue is the
  `Enqueue` service, which apps/web provides as `webEnqueue` from
  `lib/enqueue-live.ts`), and `proposeProgram` (`writes/suggestions/
propose.ts`, SPA-204, with migration 0057's partial unique index making an
  identical open integration proposal a database no-op; the accept path
  stays in apps/web) — and the boot composition (`writes/boot.ts` with
  `writes/seeds/taxonomy.ts`, SPA-177; `apps/web/src/db/boot.ts` is the
  process shell that runs it) — and is the only place in core a `drizzle-orm` import or a
  `db` value import passes. The pure half also holds the context assembler's
  ranker, ref grammar and renderer (`context/*`) and `canRead`
  (`read-policy.ts`, SPA-179) and the `SimilarLane` service tag
  (`context/similar-lane.ts`, SPA-182/D58); the db-coupled assembler
  (`assemble`, `names`, `record`) is `writes/context/*` and declares that
  service, whose one live Layer is `apps/web/src/lib/ai/similar.ts` beside
  the embedding pin it reads. Neither half imports React, and only
  `writes/vault/` (MASTER_KEY, DATA_DIR) and `writes/storage/`
  (STORAGE_DRIVER, S3_*) read `process.env` — which is why
  `enqueueSourceEmbed` stayed in
  `apps/web/src/lib/ai/enqueue-embed.ts`: core's write paths hand back
  `reembed` and the server fn queues it. The jsonb readers are
  `@spaces/core/json`.
  **`packages/sdk` (`@spaces/sdk`) is the plugin contract since SPA-191
  (sdk-3)**: the manifest (`manifestSchema`, `defineManifest`, no plugin
  `kind` — D51), `SDK_VERSION` and `satisfiesSdk`, `definePlugin`, and the
  plugin build (`@spaces/sdk/build`, a vite config every plugin reuses) and
  the packer (`@spaces/sdk/pack`, SPA-193: ustar + ed25519; core's
  `plugins/verify.ts` is the other half, and `registry.json` and
  `plugin-keys/` at the root are copied into the image), the port tags and
  `@spaces/sdk/testing` (SPA-196), and the identity-key normalizers
  (`@spaces/sdk/identity`, SPA-195 — `@spaces/core/entities/normalize` is a
  re-export of it, so core imports the sdk at runtime). It
  depends on effect, zod and tldts (D55) and nothing internal,
  and — unlike db and core — its `exports` point at `dist/` (ESM + d.ts,
  `tsc -p tsconfig.build.json`), because a plugin bundle leaves it as a bare
  import node resolves at runtime; turbo's `^build` edge builds it before
  any dependent's `dev`, typecheck, test or lint, and the Dockerfile builds
  it before web and the worker. Its suite needs no Postgres.
  **`plugins/*` and `plugins/_fixtures/*` are workspace packages** named
  `@spaces/plugin-<id>`, depending on `@spaces/sdk` only (effect and zod are
  peers the host provides); `plugins/_fixtures/echo` is the first.
  **`packages/config` (`@spaces/config`) holds the shared configuration since
  SPA-180: `tsconfig.base.json`, the eslint base (`eslint.base.js`, with
  the architecture zones and the spec §2 boundary rules) and its rule
  modules in `eslint-rules/` (gate 5's `instrument/vocabulary`),
  and `prettier.base.js`. The sdk and plugin zones are proved on the real
  packages by `packages/sdk/src/fence.test.ts` (SPA-191 retired the
  placeholder `fixtures/{sdk,plugins}` they were fenced against).**
  **`apps/worker` (`@spaces/worker`) is the worker process since SPA-181
  (mono-11a)**: the pg-boss host (`src/index.ts`), `runJob`, the heartbeat,
  the container health command and every job module under `src/jobs/`,
  lifted out of `apps/web/src/worker` as a move. It depends on
  `@spaces/core`, `@spaces/db` and pg-boss and never on apps/web as a
  package — but its jobs still import server modules that have not left
  `apps/web/src/lib` (the AI lanes, arrival, documents, import, search, the
  queue sender). Those cross through **`#web/*`**, an alias in
  `apps/worker/tsconfig.json` and `vitest.config.ts` that means
  `apps/web/src/*`; the eslint worker zone allows it for `lib/` and `test/`
  only, bans `#/` and any relative climb into apps/web outright, and lists
  every crossing specifier in its comment
  (`packages/config/eslint.base.js`, `WORKER_NEVER_WEB_NEVER_PLUGINS`). The
  fence narrows as lib/ moves into core; when the list is empty the alias
  goes. `#/` is deliberately absent from the worker, like db and core. Start
  it with `pnpm worker` from the root (a plain `--filter` proxy) or
  `corepack pnpm worker` inside `apps/worker`; `pnpm dev` now runs it too,
  under turbo's persistent `dev` task, in watch mode.
  **Its plugin loader (SPA-194, sdk-11) is `src/plugins/`**: boot
  reconciliation of enabled `integration` rows against
  `<dataDir>/plugins/<id>/current/`, before any queue registers, and a
  `node:module` resolve hook (`host-resolve.ts`) that hands a bundle's bare
  `effect`/`zod`/`@spaces/sdk` imports the worker's own copies — which is
  why the worker's vite build leaves `@spaces/sdk` external and the image
  copies it into `/app/node_modules`, and why its vitest config hands
  `packages/sdk/dist` and plugin bundles to node. The loader fixtures
  (`plugins/_fixtures/{old-sdk,needs-key,tampered}` beside echo) are its
  devDependencies, so turbo builds them before its tests.
  What stayed at the root: `eslint.config.js` and `prettier.config.js` as
  one-line shims re-exporting `@spaces/config/eslint` and
  `@spaces/config/prettier` (both tools look their config up from the cwd,
  and a copy inside a package would re-base the root-relative zone globs),
  `lefthook.yml`, `scripts/`, `docker/`, `docs/`, `.env.local` and `data/`.
- **Turbo runs the graph since 2026-09-19 (SPA-127).** `turbo.json` declares
  `dev`, `build`, `lint`, `typecheck`, `test` and `generate-routes`, and the
  root scripts for those six go through `turbo run` instead of
  `pnpm --filter` (`worker`, `preview` and the `db:*` scripts are still plain
  `--filter` proxies — they are stateful, not gates, and not in the graph).
  Run them from the repo root as before. Per package: `pnpm exec turbo run
test --filter=@spaces/web`. The cache is local only, no remote cache; the
  artifacts live in `.turbo/` (gitignored, and shared with the main checkout
  when you are in a worktree).
- `.env.local` stays at the **repo root**, and every loader is anchored to the
  file that needs it rather than to cwd (`apps/web/vitest.config.ts`,
  `packages/db/vitest.config.ts`, `packages/db/drizzle.config.ts`,
  `apps/web/vite.config.ts`'s `envDir`, and
  `dotenv -e ../../.env.local` in the app's dev/worker/db scripts — nitro's
  vite plugin loads `.env.local` from the vite root, which is now `apps/web`,
  which is why `dev` carries dotenv-cli too). `dataDir()` is anchored the same
  way, to the directory holding `pnpm-workspace.yaml`, so an unset `DATA_DIR`
  still means `<repo>/data` and `secret.key` is never regenerated by a cwd
  change.
- **`pnpm e2e` is the browser suite, not a gate (SPA-184).** `apps/e2e`
  (`@spaces/e2e`) is Playwright: turbo builds `@spaces/web`, the harness boots
  `.output` twice against `spaces_e2e_<pid>_*` databases it creates and drops
  (never `spaces`, never `spaces_test*` — it checks row counts before and
  after), and Chromium drives the login gate, the first-run window and closed
  signup. It has no `test` script, so `pnpm test` never runs it; CI runs it in
  its own `e2e` job. With `E2E_IMAGE_URL` set it runs the other project instead
  — `specs/image/`, upload→preview against an already-composed container, the
  admin made from the token in `docker compose logs app` — which is CI's
  `image-smoke` job and the check a release requires (SPA-186). It imports
  nothing internal (eslint zone). First run on a
  new machine: `pnpm --filter @spaces/e2e exec playwright install chromium`,
  or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at a Chromium you have.
- If the Docker daemon is down: `open -a Docker` first.
- Dev login: `anish@fund.example` (user knows the password). Login lands on
  `/today`; first-run setup lands on `/spaces`.
- The test suite needs Postgres up, and **since 2026-09-19 (SPA-143) it has
  its own databases on it — never the dev one.** A vitest `globalSetup` in
  each package derives `DATABASE_URL_TEST`, defaulting to `DATABASE_URL` with
  `_test` suffixed onto the database name (`spaces` → `spaces_test`), creates
  that database if it is absent, migrates it and — in `apps/web` — seeds it
  with the system attributes, the starter taxonomy and one fixture `user`
  row, which is what the `select id from user limit 1` sites resolve against.
  `spaces_test` is the _reference_ database: point `pnpm db:migrate:run` at
  it, read it by hand, but no test writes to it.
- **Isolation is per file, and structural (SPA-145).** A `setupFiles` entry
  in each package truncates every table in `public` and reseeds before each
  test file, so a test writes whatever it likes and the next file sees none
  of it — no `afterAll` cleanup, no name tags to match, nothing to add when
  a table appears. `cleanupTestEntities` is gone; do not reintroduce a
  hand-written delete list. The truncate names tables in `public` only, so
  `drizzle.__drizzle_migrations` and the `pgboss` schema are out of its
  reach by construction. The grain is a database per vitest worker —
  `apps/web` runs `maxWorkers: 4` on `pool: 'forks'` against
  `spaces_test_web1…4`; `packages/db` runs `fileParallelism: false` against
  `spaces_test_db1`, `packages/core` the same against `spaces_test_core1`
  (SPA-174/175; core's `vitest.seed.ts` seeds the system attributes and the
  fixture user, which apps/web's seed composes and adds the taxonomy to),
  and `apps/worker` runs `maxWorkers: 4` against `spaces_test_worker1…4`
  with its own harness pair and a seed composed like apps/web's (SPA-181) —
  because a truncate must not be able to reach a file
  running at the same moment in another worker. Drop any `spaces_test*`
  database any time; the next run rebuilds it. With Postgres down the setup
  fails once, naming the connection string, instead of ten files each
  throwing `ECONNREFUSED` — which also means `--filter=@spaces/db` no longer
  answers with Postgres stopped, even for `entity-refs.test.ts`. The harness
  is `packages/db/src/test-db.ts` plus the `vitest.setup.ts` /
  `vitest.global-setup.ts` pair in each package; it never drops a database,
  only creates and truncates. A global setup that seeds the reference
  database passes its seed to `prepareTestDatabase` so it runs inside the
  harness advisory lock — three packages seed it and turbo runs them at
  once (SPA-181 review).

## Gates before any commit

1. `pnpm typecheck` → `turbo run typecheck typecheck:root` — **not** a bare
   `pnpm exec tsc --noEmit`. There is a tsconfig per package now: the root
   one covers `scripts/` and the two config shims (that is the
   `typecheck:root` half), and `apps/web`, `packages/db`, `packages/core`
   and `packages/config` (whose `eslint-rules/` and zone fixtures were the
   root half's until SPA-180) each cover their own source (the `typecheck`
   half, one task per package). The root script runs them all; a bare root
   `tsc` would pass while typechecking none of them.
2. `pnpm test` → `turbo run test` (`vitest run` in `apps/web`, `apps/worker`,
   `packages/db`, `packages/core`, `packages/sdk` and each plugin under
   `plugins/`, each with its own vitest config) — must be fully green
3. prettier on touched files (root: `pnpm exec prettier --check <files>`) —
   not a turbo task; it is per-file, not per-package
4. `pnpm lint` → `turbo run lint lint:root` — must be zero errors (the old
   tolerated baseline was
   eliminated 2026-09; don't reintroduce one). Where drizzle's `const [row] =`
   destructure lies about presence, use the `.at(0)` pattern instead of
   deleting the guard.
5. Instrument vocabulary only — **`pnpm lint` covers it**, there is no separate
   gate and no grep any more (2026-09-18). `instrument/vocabulary`
   (`packages/config/eslint-rules/vocabulary.js`) reads className literals
   and `cn()`/`cva()` string arguments in `apps/web/src/**/*.tsx` and names the
   Instrument replacement in the message, so gate 4 and the pre-commit hook
   enforce it for free; since SPA-52 it also rejects a raw colour there (a hex,
   or `rgb()`/`hsl()`/`oklch()` spelled into a class string — read the custom
   property instead), which is what keeps the app light-only by decision rather
   than by omission; the dead `--color-*` exports are held out of the
   `@theme` block by `apps/web/src/lib/design-tokens.test.ts` under gate 2. The Instrument vocabulary is
   `text-graphite`, `border-rule`, `bg-bone`, `bg-paper`, `text-label`,
   `rounded-md` (2px) / `rounded-none`.

Building a surface? `docs/design-contract.md` is what to do before you write
tsx — the vocabulary, the primitives by file, which shipped route each shape
copies, and the checklist a reviewer runs. The gates are its mechanical floor.

A second run of a gate with nothing changed is a cache hit that replays the
first run's output. That is safe only because the inputs are honest: `test`
and `typecheck` hash the whole package plus `.env.local`, the lockfile and
`packages/config/tsconfig.base.json`; `lint` hashes the root shim,
`packages/config/eslint.base.js` and `packages/config/eslint-rules/**`
too, so editing gate 5's rule or a boundary zone re-runs gate 4 in every
package (verified by SPA-180: a comment edit in `vocabulary.js` turned four
cache hits into four misses). If you add a file the gates read from outside
the package, add it to `turbo.json` — a task whose inputs miss it will replay
a pass that checked nothing. A file in another _workspace package_ is the
exception: turbo already folds an internal dependency's files into the
consumer's hash, so editing `packages/db/src/test-db.ts` invalidates
`@spaces/web#test` with no entry here (verified by SPA-143) — the `lint`
inputs name `packages/config` anyway, so the gate does not lean on that
property. `--force` re-runs a task regardless.

Pre-commit hooks (lefthook) run prettier + eslint on staged files from the
repo root, where the two shims hand both tools `packages/config`'s settings;
pre-push runs `pnpm run typecheck`, which is turbo over every package that
has one — `@spaces/web`, `@spaces/worker`, `@spaces/db`, `@spaces/core`,
`@spaces/sdk`, `@spaces/config` and every `@spaces/plugin-*` — plus the `typecheck:root` half, so no package can be
typechecked by nobody.
CI (`.github/workflows/ci.yml`) runs the same root commands, **one named step
per gate** against a real Postgres: prettier, `pnpm run lint` (which carries
gate 5, since it is an eslint rule), `pnpm run typecheck`, `boot.ts` against
the empty service database, `pnpm run test`, then `turbo run build` — a red
run names the gate that broke. CI writes no `.env.local`: `DATABASE_URL` comes
from the job's `env:`, every loader falls back to the environment, and the
harness derives `spaces_test*` from it, so the suite never writes the
`spaces` database `boot.ts` migrated.

## Principles (no principle without an enforcer)

- A type is a claim the compiler checked, not one the author asserted
  (`@typescript-eslint/consistent-type-assertions: never`).
- Data crossing a boundary gets its type once — at the column or at a decode
  (`jsonb().$type<…>()` on all 18 columns; `packages/db/src/json.ts`).
- `undefined` is a type, not a state: optional means the caller may omit it
  (`exactOptionalPropertyTypes`).
- Attribute values have one write path, which validates, logs, and links
  (`no-restricted-syntax` on `entity.values`; `packages/core/src/writes/attributes/values.ts`).
- Portfolio history is append-only; a correction is a compensating event
  (D12, built by SPA-150 — `apps/web/src/lib/portfolio/reverse.ts`, the
  `<table>_reverses_unique` partial indexes, `packages/core/src/portfolio/reversal.ts`).
- Effect never crosses into React; the seam is `effectFn()`
  (`no-restricted-imports` on `effect` in `apps/web/src/routes/**`,
  `apps/web/src/components/**`).

`noUncheckedIndexedAccess` stays **off**, decided 2026-09-18 (SPA-151): 371
errors, 62% of them in test files and `apps/web/src/lib/seeds/dev.ts`, where manufactured
`!` and `?.` buy nothing — production already carries the `.at(0)` convention
from gate 4. Revisit when project 2's test-database slices rewrite the tests
anyway. Don't re-litigate it from the flag list.

## Comments (decided 2026-10-02)

A comment is for the next reader of the code, not a record of how it was
designed. Short and formatted:

- **First line says what it is.** Bullets for rules and invariants.
- **Keep:** non-obvious _why_, invariants, warnings ("never inside a
  transaction", "never add to the journal"). Keep warnings word for word.
- **Rejected alternatives:** one line plus a decision id, at most
  (`// Not access control — canRead decides visibility. (Dnn)`). The full
  reasoning lives in `CONTEXT.md`, `docs/decisions-*.md` or `docs/adr/`.
- **Leave out:** SPA ids, dates, "grilled", slice or milestone names, plan
  state ("until mono-9a"), history of what used to be there. Those belong
  in the commit message.
- **Name symbols, not file paths.** A path goes stale when a module moves; a
  symbol is found by search.
- **Aim for 5 lines or fewer.** Longer means it belongs in a doc.

Bring a comment to this style when you change the code under it. Rewriting
comments in code you are not otherwise changing is a sweep, done one package
at a time, and the sweep must not drop an invariant. No lint rule can check
this; the reviewer does.

## After specific change kinds

- Routes changed → `pnpm generate-routes` (turbo task `generate-routes`, whose
  output is `apps/web/src/routeTree.gen.ts`). `build` deliberately does **not**
  depend on it: vite's tanstackStart plugin writes the route tree during
  `vite build` and its tree keeps the `declare module '@tanstack/react-start'`
  Register block that the `tsr generate` CLI strips. Chaining the CLI in front
  of build would hand build the stripped tree. The CLI's diff against the
  committed tree is pre-existing — don't "fix" it here.
- Schema changed → `pnpm db:generate --name <x>`, then hand-inspect the SQL.
  A hand-written data migration (0008, 0036) writes its own journal entry;
  its `when` is the clock at write time (`date -u +%s000`), never a made-up
  future value — the migrator and the downgrade guard order by `when`, and a
  future one mis-orders the next `db:generate` (cost a session 2026-09-20).
  The journal is squashed to one file at the v1 cut, not before.
- New system attribute → add to `SYSTEM_ATTRIBUTES` in
  `packages/core/src/attributes/registry.ts`; `pnpm db:migrate:run` reseeds
  insert-if-absent
- **`attr_idx_*` indexes are the reconciler's, never the journal's** (SPA-93).
  `entity` carries one expression index per attribute flagged
  `filterable`/`sortable` — `attr_idx_<attribute id>` on
  `(object_id, spaces_json_text|number(values -> '<slug>'))` — and that set is
  a function of _user data_, not of the schema: it changes when somebody ticks
  "Filter and sort on this". So it is DDL from application code, and the one
  exception to "schema changed → db:generate". `reconcileValueIndexes()`
  (`packages/db/src/value-indexes.ts`) diffs `pg_indexes` against the flagged,
  unarchived attributes and mints/drops `CONCURRENTLY`; it runs at boot beside
  `seedSystemAttributes()` (`packages/core/src/writes/boot.ts`, which
  `apps/web/src/db/boot.ts` runs) and from the attribute
  server fns **after** the write commits — never inside a transaction, which
  `CREATE INDEX CONCURRENTLY` forbids. A failed mint is logged, the attribute
  stays usable, and the next boot retries. **Never add one to the drizzle
  journal, and never `db:push`** — `db:generate` diffs snapshots and cannot
  see them (verified), but `push`/`pull` introspect a live database and would
  propose dropping every one of them. The expression is not free-form either:
  it must be exactly what `compileSortKey` emits
  (`apps/web/src/lib/views/sql.ts`), which is why the coercions live in two
  IMMUTABLE SQL functions (migration 0041) and why `resolve.ts` spells the
  slug as a literal rather than a bind parameter. A mismatch raises nothing —
  the index just sits there unused; `apps/web/src/lib/views/value-index-plan.test.ts`
  is the EXPLAIN assertion that catches it.
- New column referencing an entity → add an entry to `ENTITY_REFS`
  (`packages/db/src/entity-refs.ts`) declaring both the merge strategy and the
  context role; `entity-refs.test.ts` diffs the list against drizzle's FK
  metadata and fails naming the column otherwise — the test itself reads
  drizzle's metadata and needs no database, but since SPA-143 its package's
  global setup does, so `pnpm exec turbo run test --filter=@spaces/db` wants
  Postgres up like everything else. A `custom` merge strategy
  still needs its section in `packages/core/src/writes/entities/merge.ts` **and** its
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

## Cloud sessions (Claude Code on the web)

A cloud session sees this repo and nothing from `~/.claude` — no memory, no
user-scoped MCP servers. `.claude/settings.json` runs
`scripts/cloud-session-start.sh` on every start: Postgres with pgvector ≥ 0.8
(the `pgvector/pgvector:pg17` image if Docker answers, else the preinstalled
Postgres 16), then `pnpm install`. It exits at once outside the cloud. The
environment sets `DATABASE_URL=postgresql://spaces:spaces@localhost:5432/spaces`
and nothing else, exactly like CI.

- One session implements one SPA issue: read its Linear body as the spec, run
  all five gates, commit on a branch named for the issue, push it, open a PR.
  Never commit to `main`; the owner merges.
- **`migration`-labelled issues run one at a time across every session**, for
  the journal reason above. Dispatch the next only after the last one merged.
- A session that needs a `hitl` decision stops and says so in its PR or on the
  issue; it does not guess.

## Traps (each of these has already cost a session)

- `apps/web/src/lib/server-fns.ts` is a **client-imported barrel**: serverFns + types
  only. Server-side helpers go in `server/shared.ts`, or further out — the
  pipeline→portfolio seam `birthHolding` lives in `lib/portfolio/holding.ts`
  since SPA-169 because the deal birth and the import worker both need it,
  and `shared.ts` only re-exports it. A plain export from a `lib/server/*.ts` module
  the barrel re-exports ships to the browser — only `createServerFn().handler()`
  bodies are stripped — so a helper a test needs to call without a request
  lives outside `lib/server/` (SPA-155).
- **Never use `Intl.NumberFormat` compact notation** — Node vs Chrome output
  differs → hydration failures. `fmtMoney` hand-rolls compact; use it.
- Radix `asChild` with a custom trigger component: forward `{...props}` or the
  dialog silently never opens.
- Money is drizzle `numeric` → **strings in JS**. Parse with `Number()` at the
  server boundary; pure libs (`packages/core/src/portfolio/`) take numbers. Dates are
  ISO strings compared lexically.
- The portfolio event tables (investment/mark/distribution/fx_rate) are
  **append-only by design** — no edit/delete paths, and there still are none.
  The correction policy is **decided and built (D12, SPA-150, 2026-09-19):
  reversal by compensating event.** **Three** tables carry a nullable
  self-referencing `reverses_id` and a nullable `batch_id` — `investment`,
  `mark`, `distribution`. **`fx_rate` is excluded**: it is a lookup rather
  than a summed event, its `rate_to_base > 0` CHECK would refuse a negated
  row, and `setFxRate` already upserts on `(currency, date)`, so correcting a
  rate simply recomputes every derived number. A void appends an
  exact-negative event citing the original and dated as the original was
  dated; a partial unique index on `reverses_id` makes a double void a
  database error, not a race. Batch reversal voids every event sharing one
  `batch_id` in one transaction and refuses whole. **Never add an edit or a
  delete path** — the correction is an append like everything else.
  - The reader contract is the load-bearing half: the loader
    (`apps/web/src/lib/portfolio/detail.ts`) hands the pure libs
    **originals only**, each stamped with `reversedAt` (the reversal's
    `created_at`), and `@spaces/core/portfolio/reversal` drops an event once
    the as-of day has reached that instant — so an as-of date before the void
    still sees the original. Nothing derived leans on the negation
    cancelling: the latest mark wins, `writtenOff` reads the latest write-off,
    `ownership()` filters `shares > 0`. The negation is stored so a raw SQL
    `SUM` stays honest and the timeline can show the correction.
  - The void flow is Effect-first through `effectFn()`
    (`apps/web/src/lib/portfolio/reverse.ts`); its tagged errors carry an
    empty `message`, so `ledgerVoidMessage` is what the dialog is shown.
    See `docs/decisions-2026-09.md`.

## Browser verification (Chrome MCP)

- MCP synthetic clicks **don't open Radix dialogs** — use `javascript_tool`
  with `element.click()`.
- Beware stale closures when clicking + submitting in the same JS tick (caused
  a phantom "bug" during tasks verification).
- The project verify convention: drive the real dev-DB app for feature
  increments; scratch-env for auth/onboarding flows.
