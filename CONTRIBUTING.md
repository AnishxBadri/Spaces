# Contributing

Spaces is built in the open by one investor, with agents doing most of the
typing. Issues and pull requests are welcome. This file is the mechanics:
how to run it, what has to be green, and where the decisions live so you
do not re-derive them.

## Read first

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — every model and the
  stack, in one read. Start here.
- [`docs/CODEBASE.md`](docs/CODEBASE.md) — where things live and how a
  request flows.
- [`CONTEXT.md`](CONTEXT.md) — the decision record, dated. Read the block
  for the area you are touching before designing anything.
- [`CLAUDE.md`](CLAUDE.md) — the agent card: gates, traps, conventions.
  Humans should read it too; every trap in it has already cost a session.
- [`docs/design-contract.md`](docs/design-contract.md) — before writing any
  `.tsx`. The vocabulary, the primitives, the checklist a reviewer runs.

## Dev setup

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # Postgres :5432 + MinIO :9000
cp .env.example .env.local                        # fill BETTER_AUTH_SECRET
pnpm db:migrate:run                               # migrations + system attributes
pnpm dev                                          # vite on :3000 and the worker, in watch
```

Open `http://localhost:3000/setup`, paste the token the server logged,
create your admin. Then `pnpm db:seed` for an invented fund's book: a
pipeline at every stage, a portfolio with stale marks, dedupe candidates,
private notes, documents in every extraction state.

`.env.local` lives at the repo root. Every loader is anchored to that file,
not to the working directory.

## Layout

```
apps/web/          the app — @spaces/web (TanStack Start, React 19)
apps/worker/       the pg-boss worker — @spaces/worker
apps/e2e/          Playwright: the browser suite and the screenshot pipeline
apps/site/         the marketing and docs site (Astro, Vercel; never in the image)
packages/db/       @spaces/db — drizzle schema, the migration journal, ENTITY_REFS, the migrator
packages/core/     @spaces/core — the domain: a pure half and a db-coupled half under writes/
packages/config/   tsconfig, eslint (with the architecture zones), prettier
docker/            Dockerfile (turbo prune), entrypoint, Caddyfile
scripts/           backup.sh, restore.sh
docs/              architecture, specs, roadmap, ADRs, assets
```

Dependency rules are lint, not convention: `db` imports nothing internal,
`core` imports `db` only, `web` never imports the worker or a plugin, the
worker never imports `web` as a package. A violation names the rule and the
spec section.

| command               | what it does                                             |
| --------------------- | -------------------------------------------------------- |
| `pnpm dev`            | vite dev server on :3000 and the worker in watch mode    |
| `pnpm worker`         | the worker alone                                         |
| `pnpm build`          | production build into `apps/web/.output`                 |
| `pnpm test`           | vitest across every package (needs Postgres up)          |
| `pnpm typecheck`      | every tsconfig, root and per package                     |
| `pnpm lint`           | eslint, including the design-vocabulary rule             |
| `pnpm e2e`            | the browser suite against the built app                  |
| `pnpm screenshots`    | regenerate `docs/assets/screenshots/` from the built app |
| `pnpm db:migrate:run` | run migrations and reseed system attributes              |
| `pnpm db:generate`    | generate a migration after a schema change               |
| `pnpm db:seed`        | the developer bench, after `/setup`                      |

## The gates

Four gates, all green before a commit. The pre-commit hook runs the first
two on staged files and pre-push runs typecheck.

1. `pnpm typecheck`
2. `pnpm test` — the suite has its own databases (`spaces_test*`) and never
   touches your dev one. Isolation is per file and structural: every table
   is truncated and reseeded before each test file.
3. `pnpm exec prettier --check <files>`
4. `pnpm lint` — zero errors. There is no tolerated baseline.

Turbo caches every gate. A second run with nothing changed replays the
first; `--force` re-runs.

## Conventions that lint enforces

- A type is a claim the compiler checked, not one the author asserted. No
  `as` casts.
- Attribute values have one write path. `entity.values` is not written
  anywhere else.
- Portfolio history is append-only. A correction is a compensating event.
- Effect never crosses into React. The seam is `effectFn()`.
- New server code is Effect-first. Existing modules convert only when
  already open for behavioural change, in the same PR.
- Instrument vocabulary only in class strings, and no raw colours. The rule
  names the replacement.

## After specific changes

- Routes changed → `pnpm generate-routes`.
- Schema changed → `pnpm db:generate --name <x>`, then read the SQL. Only
  one migration-bearing change may be in flight at a time; the journal is a
  serialisation point.
- New system attribute → `SYSTEM_ATTRIBUTES` in
  `packages/core/src/attributes/registry.ts`.
- New column referencing an entity → an `ENTITY_REFS` entry declaring the
  merge strategy and the context role. The test names the column otherwise.
- UI changed → `pnpm screenshots` and commit the images that moved.

## Picking up work

The maintainer schedules work in Linear; the roadmap and every open
decision are in [`docs/roadmap-2026-09.md`](docs/roadmap-2026-09.md) and
[`docs/decisions-2026-09.md`](docs/decisions-2026-09.md). For an outside
contribution, open a GitHub issue first with the decision block you read and
the shape you propose. Small fixes can go straight to a PR.

One PR per issue. One-line commit messages. Branch from `main`, never
commit to it. CI runs the same gates as the hook, one named step per gate,
against a real Postgres, then builds and smoke-tests the image.

## Releasing

A `core@X.Y.Z` tag, where `X.Y.Z` equals the root `package.json` version,
runs the whole CI, builds the multi-arch image once, smoke-tests it, and
pushes it to GHCR and Docker Hub as `X.Y.Z` and `X.Y`, signed. Never
`latest`. Details in `.github/workflows/release.yml`.

## License

By contributing you agree your contribution is licensed under
[AGPL-3.0](LICENSE).
