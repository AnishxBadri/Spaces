# Spaces

Self-hosted deal management for angel and private-capital investing.

Think Affinity or TagHash, except you run it, you own the data, and every AI
or data provider is bring-your-own-key. It is not a horizontal CRM: it is
opinionated for investors, and that constraint is the product. Two halves sit
on one graph. **Research** is spaces, notes, sources and a glossary: slow,
exploratory, your market map compounding. **Deals** is companies, people,
deals, activity and a portfolio ledger: fast and structured. A company
entering the pipeline already carries the months of research you filed on
it. Everything stays on your box.

## Self-hosting

Two containers, one command, nothing built on your box. The image is
published for `linux/amd64` and `linux/arm64`, signed, and pinned by tag;
there is no `latest`.

```bash
mkdir spaces && cd spaces
curl -fsSLO https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.yml
docker compose up -d
docker compose logs app | grep "setup token"
```

Open `http://localhost:3000/setup`, paste the token from the log, create the
admin. The setup window closes the moment the first admin exists.

Everything the app owns is `./data` beside the compose file and the
`spaces_pgdata` volume. Back them up together with `scripts/backup.sh`.
**Lose `./data/secret.key` and every stored credential is unrecoverable.**

- [docs/install.md](docs/install.md): the pinned tag, the two required
  variables (and that there are only two), what `./data` holds, the
  first-run token, HTTPS with the Caddy overlay, backups.
- [docs/upgrade.md](docs/upgrade.md): back up, change the tag, pull and up;
  why an older image refuses a newer database; rollback by restore.

## Developing

From a clean clone:

```bash
pnpm install                                      # links apps/web, apps/worker and packages/*
docker compose -f docker-compose.dev.yml up -d    # Postgres :5432 (+ MinIO :9000)
$EDITOR .env.local                                # the value below
pnpm db:migrate:run                               # migrations + system attributes
pnpm dev                                          # http://localhost:3000
pnpm worker                                       # in a second terminal (or let `pnpm dev` run it)
```

`.env.local` lives at the **repo root** and needs one value:

```
DATABASE_URL=postgresql://spaces:spaces@localhost:5432/spaces
```

(`BETTER_AUTH_SECRET` is optional; without it the session secret is derived
from the master key the app generates.)

### Repo layout

This is a pnpm workspace (since 2026-09-19).

```
apps/web/            the app — @spaces/web. src/ and the configs it owns
apps/worker/         the pg-boss worker — @spaces/worker (SPA-181); its jobs still reach apps/web/src/lib through `#web/*`
apps/e2e/            the Playwright suite — @spaces/e2e (SPA-184); `pnpm e2e`, never part of `pnpm test`
packages/db/         @spaces/db — drizzle schema, the drizzle/ journal, migrator, downgrade guard
packages/core/       @spaces/core — the domain, pure half and db-coupled half (src/writes/)
packages/config/     tsconfig.base.json, the eslint base (+ eslint-rules/) and prettier config, shared by every package
eslint.config.js     shim — re-exports packages/config's (prettier.config.js likewise)
scripts/             backup.sh, restore.sh — operator scripts
docker/              Dockerfile, entrypoint.sh, Caddyfile
docs/                install.md, upgrade.md, ARCHITECTURE.md, CODEBASE.md, the specs and the decision log
```

Every script below runs **from the repo root**; each is a proxy that delegates
with `pnpm --filter` or `turbo run`. Inside a package, `#/` always means that
package's own `src/`, so `#/lib/server/deals` in `apps/web` is
`apps/web/src/lib/server/deals`.

| command               | what it does                                  |
| --------------------- | --------------------------------------------- |
| `pnpm dev`            | vite dev server on :3000 + the worker (watch) |
| `pnpm worker`         | the pg-boss worker alone (apps/worker)        |
| `pnpm build`          | production build into `apps/web/.output`      |
| `pnpm test`           | vitest (needs Postgres up)                    |
| `pnpm e2e`            | the browser suite (builds the app first)      |
| `pnpm typecheck`      | every tsconfig — root, apps/_, packages/_     |
| `pnpm lint`           | eslint, including the design-token rule       |
| `pnpm db:migrate:run` | run migrations and reseed system attributes   |
| `pnpm db:generate`    | generate a migration after a schema change    |

`CLAUDE.md` is the mechanics card (the gates before a commit, the traps);
`CONTEXT.md` is the decision record; `docs/CODEBASE.md` is the map.

## License

AGPL-3.0.
