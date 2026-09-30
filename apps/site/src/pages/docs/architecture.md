---
layout: ../../layouts/Docs.astro
eyebrow: Docs · Architecture
title: Architecture
description: Two Node processes, one database, one directory. What runs where, and how the repository is laid out.
lead: stack
---

## The shape

```
Browser (React) ── typed server functions ──┐
                                            ├── Postgres 17 + pgvector
Worker (pg-boss · extraction · AI jobs) ────┘      data, jobs, search, vectors
                                            └── ./data   uploads · secret.key
```

Spaces is two Node processes sharing one database and one directory. In production they run in one container, `app`, beside a second container for Postgres. That is the whole install.

**Web.** TanStack Start and React 19. The browser talks to the server through typed server functions; there is no separate API tier to run. The web process never does heavy work inline. Anything that would block a request goes on a queue for the worker.

**Worker.** A pg-boss host in its own process. It extracts text from uploaded PDF, DOCX, PPTX and XLSX files, re-verifies each file's hash as it reads it, and runs every AI job: classification, summaries, embeddings. If either process dies, the container exits and Compose restarts it, so a dead worker cannot hide behind a healthy web server. Set `ROLE=web` and `ROLE=worker` to run them in separate containers.

**Postgres 17 with pgvector.** One stateful service carries the relational data, the job queue, full-text and typo-tolerant search (`tsvector`, `pg_trgm`), the space hierarchy (`ltree`) and the embeddings (`pgvector`). Search is one query that ranks names, note bodies, document text and vector matches together.

**Blob storage.** Uploads are stored by SHA-256, hashed in the browser before upload and checked again on the worker. The default driver writes them under `./data/blobs`. `STORAGE_DRIVER=s3` sends them to any S3-compatible bucket (AWS, R2, B2, MinIO, Garage) for hosts whose disks do not survive a restart. `./data` also holds `secret.key`, which is why it is backed up with the database, every time.

A few rules hold the design together:

- **Required settings are frozen at two**, `DATABASE_URL` and `APP_URL`. Every feature ships with a working default.
- **History is append-only where history is information.** Portfolio events are never edited; a correction is a new, reversing event. Stage changes are logged as they happen.
- **AI proposes, a person accepts.** Every model output is a suggestion with its reasoning attached. Nothing is written silently.
- **Nothing phones home.** Every AI and data provider is bring-your-own-key, and a local Ollama counts.

## The repository

A pnpm workspace, built with Turborepo. Each package's dependencies are an allow list, and lint rules ban the edges that must never exist.

| Path              | What it is                                                                                         | State   |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------- |
| `apps/web`        | The app: routes, components, server functions. Knows no plugin code.                               | shipped |
| `apps/worker`     | The pg-boss host and every background job. The only process that runs plugin code.                 | shipped |
| `apps/e2e`        | The browser suite: Playwright against the built app and the built image.                           | shipped |
| `apps/site`       | This site. Static, on Vercel, never in the image.                                                  | shipped |
| `packages/db`     | The Drizzle schema, the migration journal and the migrator. Imports nothing internal.              | shipped |
| `packages/core`   | The domain: the attribute engine, entity resolution and merge, the vault, storage, portfolio math. | shipped |
| `packages/config` | Shared TypeScript, ESLint and Prettier configuration, including the dependency rules.              | shipped |
| `packages/sdk`    | `@spaces/sdk`: the plugin manifest, port interfaces and `definePlugin`. Imports nothing internal.  | shipped |
| `plugins/*`       | Integrations such as Apollo, RSS, Gmail and Google Drive. Each imports the SDK only.               | shipped |

The dependency rules:

- `web` imports `core` and `sdk`, never a plugin and never the worker.
- `worker` imports `core` and `sdk`. It loads plugins at runtime, never at compile time.
- `core` imports `db` and `sdk`, never `web`.
- `sdk` imports `effect` and `zod`, nothing internal. If the SDK ever needs core, the contract leaked.
- `plugins/*` import `sdk` only, never `core` or `db`.
- `db` imports nothing internal.

**Plugins are not in the image.** They install from the running app into `./data/plugins`, run only on the worker, and write only through typed claim lanes, so `./data` stays the one thing you back up.

## The image

The Dockerfile builds from `turbo prune @spaces/web @spaces/worker`, so nothing outside those two apps and their packages reaches it. The worker and the boot step are bundled, and the image carries no source and no TypeScript runtime. It runs as uid 1000.

A release builds linux/amd64 and linux/arm64 once and pushes the same digest to GHCR and Docker Hub, tagged with the exact version and major.minor, never `latest`. The digest is signed with cosign (keyless, GitHub Actions OIDC), and GHCR also carries a SLSA build-provenance attestation. To verify:

```sh
cosign verify ghcr.io/anishxbadri/spaces@<digest> \
  --certificate-identity-regexp '^https://github.com/AnishxBadri/Spaces/\.github/workflows/release\.yml@refs/tags/core@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/anishxbadri/spaces@<digest> --repo AnishxBadri/Spaces
```

## What it adds up to

An angel or a two-partner fund gets, in one box they run: a market map and research that compound, a spreadsheet-grade CRM that already speaks investing, and a financial core that answers what you invested, what you own, what it is worth and what it has returned. It is computed from an event ledger an auditor would recognise. Fund administration (capital calls, waterfalls, LP portals) is a different product for a different buyer, and staying out of it keeps this one two containers small.
