# Multi-arch (arm64 matters). No build-time env vars — client-visible config
# comes from the server at runtime, never VITE_* baking.
#
# Built from the repo root, which is the context every compose file and CI
# job names:  docker build -f docker/Dockerfile .
# The context's .dockerignore is the root one — Docker reads it from the
# context, not from beside this file.
#
# Four stages, on `turbo prune --docker` (docs/spec-plugin-sdk.md §2; SPA-183,
# mono-13a):
#
#   prune      the workspace cut twice — once to what building the web app
#              needs (@spaces/web + @spaces/worker and their workspace deps),
#              once to what the image *runs* (@spaces/worker and its deps)
#   build      installs the first cut and runs `vite build` → apps/web/.output
#   prod-deps  installs the second cut, --prod — the image's node_modules
#   (final)    .output + the runtime sources + prod-deps' node_modules
#
# Why the runtime cut is the worker's alone: the web process runs from
# apps/web/.output, which Nitro bundles self-contained (its own
# .output/server/node_modules is a few kB of traced files). /app/node_modules
# serves only what tsx runs — the boot entry, the worker, its health command —
# so apps/web's own dependency list (vite, rolldown, blocknote, lucide, the
# radix set, fonts, typescript through peers) has no business being
# installed. apps/worker/package.json declares everything the worker process
# loads, including what it reaches through the `#web/*` crossings, and the
# boot entry's closure is a subset of it.
#
# The worker and the boot entry still run through tsx from source in this
# stage of the project; mono-13b bundles them (vite build --ssr) and src/
# leaves the image.

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS prune
COPY . .
# turbo at the version the root package.json pins, fetched rather than
# installed: this stage has no node_modules and needs none. The version is
# read from the manifest so it never drifts from what developers run.
# `--docker` writes out/json (manifests only — the install layer, cached
# against dependency changes and not against source), out/full (the pruned
# workspace's files) and out/pnpm-lock.yaml (the lockfile cut to match).
# Scope names are package names; the roadmap's `--scope=web` predates the
# workspace. Both cuts keep packages/config (every tsconfig `extends` it, and
# every package lists it) and packages/db, drizzle/ journal included.
RUN TURBO="turbo@$(node -p 'require("./package.json").devDependencies.turbo')" \
    && pnpm dlx "$TURBO" prune @spaces/web @spaces/worker --docker --out-dir out/build \
    && pnpm dlx "$TURBO" prune @spaces/worker --docker --out-dir out/runtime

FROM base AS build
# --ignore-scripts, both install stages. The root `prepare` is `lefthook
# install`, which needs a git binary and a .git directory; alpine ships
# neither and .dockerignore keeps .git out of the context — so without this
# flag the image simply does not build. Git hooks are a developer-checkout
# concern and have no business inside the image. No dependency here needs a
# postinstall either: the two that carry native code (esbuild, lightningcss,
# the `pnpm.onlyBuiltDependencies` allowlist) ship prebuilt per-platform
# packages that pnpm links without running anything.
COPY --from=prune /app/out/build/json/ ./
COPY --from=prune /app/out/build/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY --from=prune /app/out/build/full/ ./
RUN pnpm --filter @spaces/web build

FROM base AS prod-deps
COPY --from=prune /app/out/runtime/json/ ./
COPY --from=prune /app/out/runtime/pnpm-lock.yaml ./
# --node-linker=hoisted, and only here. Every workspace package keeps its
# path under /app in the final stage, and node resolves a dependency by
# walking up from the importing file — apps/web/src and apps/worker/src both
# reach /app/node_modules. pnpm's default isolated linker would put each
# package's dependencies in its own node_modules as symlinks into
# ../../node_modules/.pnpm, and those relative links break the moment the
# directory is copied anywhere else. Hoisted writes one flat tree at
# /app/node_modules that copies as-is.
# It also links no workspace package: this stage has only the manifests, so
# there is nothing for `@spaces/db` to point at and pnpm leaves it out
# entirely. The final stage makes that link by hand, once packages/db is
# really there.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --node-linker=hoisted

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOME=/home/node

# su-exec is how the entrypoint drops root after repairing /data (hostability
# contract #1). ~20KB; no init system, no gosu-sized Go binary.
RUN apk add --no-cache su-exec

# Runtime needs: apps/web's .output (web) and src (the boot entry via tsx,
# and the modules the worker crosses into through `#web/*`), apps/worker's
# src (the worker and its health command via tsx; SPA-181), packages/db's
# src + drizzle (schema, migrator and the journal), packages/core's src (the
# worker's extractor lives there since SPA-144), and prod-deps' node_modules
# (pg-boss, drizzle-orm, unpdf, mammoth, fflate, tsx, the AI providers).
# Every source comes from the prune's out/build/full, so a file outside the
# pruned workspace cannot reach the image by accident.
#
# Every workspace package keeps its workspace path under /app — apps/web,
# apps/worker, packages/config, packages/db, packages/core — because the
# relations between them are relative: `node_modules/@spaces/db` and
# `@spaces/core` are relative symlinks into packages/, the migrator resolves
# the journal from its own `import.meta.url` (so it lives at
# /app/packages/db/drizzle, the path CI's `roundtrip` job mounts an "older
# image" fixture over), every tsconfig `extends` names `../../packages/config`,
# and apps/worker's tsconfig points `#web/*` at `../web/src`. Until SPA-181
# apps/web alone was flattened onto /app (/app/src, /app/.output); the worker
# moving out is what made the layout have to be the workspace's own.
#
# The two app tsconfigs come along because tsx resolves `#/…` (and the
# worker's `#web/…`) from tsconfig `paths` and NOT from package.json `imports`
# — Node rejects `#/*` as an internal imports key outright
# (ERR_INVALID_MODULE_SPECIFIER), so `#/…` has never resolved under plain
# Node and works only through tsx. And tsx reads the tsconfig from its *cwd*:
# main's image flattened apps/web onto /app so /app/tsconfig.json was found
# by accident of layout; with every package at its workspace path there is no
# tsconfig at /app, so every tsx invocation — the boot entry, both worker
# lines in the entrypoint and the HEALTHCHECK below — passes `--tsconfig
# <package>/tsconfig.json` explicitly (SPA-181 review: the image did not
# boot without it). Both extend packages/config/tsconfig.base.json, copied to
# the path the extends names. packages/db's and packages/core's own tsconfigs
# are deliberately not copied: nothing in the image typechecks.
#
# Every COPY into /app carries --chown=node:node rather than one `chown -R
# node:node /app` at the end. The ownership is the same; the recursive chown
# was not free — it rewrites every file it touches into a new layer, so the
# image carried node_modules twice (SPA-183 measured it: most of the
# difference between the image's content size and its size on disk).
ARG FULL=/app/out/build/full
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/web/.output ./apps/web/.output
COPY --chown=node:node --from=prune ${FULL}/apps/web/package.json ${FULL}/apps/web/tsconfig.json ./apps/web/
COPY --chown=node:node --from=prune ${FULL}/apps/web/src ./apps/web/src
COPY --chown=node:node --from=prune ${FULL}/apps/worker/package.json ${FULL}/apps/worker/tsconfig.json ./apps/worker/
COPY --chown=node:node --from=prune ${FULL}/apps/worker/src ./apps/worker/src
COPY --chown=node:node --from=prune ${FULL}/packages/config/package.json ${FULL}/packages/config/tsconfig.base.json ./packages/config/
COPY --chown=node:node --from=prune ${FULL}/packages/db/package.json ./packages/db/
COPY --chown=node:node --from=prune ${FULL}/packages/db/src ./packages/db/src
COPY --chown=node:node --from=prune ${FULL}/packages/db/drizzle ./packages/db/drizzle
COPY --chown=node:node --from=prune ${FULL}/packages/core/package.json ./packages/core/
COPY --chown=node:node --from=prune ${FULL}/packages/core/src ./packages/core/src
COPY docker/entrypoint.sh /entrypoint.sh
# The two links the prod-deps install could not make (see above). Without the
# first, `tsx apps/web/src/db/boot.ts` dies on `Cannot find package '@spaces/db'`;
# without the second, the worker dies on `@spaces/core/documents/extract` the
# first time a document is uploaded. The app's own source imports both by
# name, and node needs a node_modules entry whose package.json carries the
# `exports` map. Relative, so they survive the copy and a re-rooted /app.
RUN mkdir -p node_modules/@spaces \
    && ln -s ../../packages/db node_modules/@spaces/db \
    && ln -s ../../packages/core node_modules/@spaces/core \
    && chown -h node:node node_modules/@spaces node_modules/@spaces/db node_modules/@spaces/core /app \
    && chmod +x /entrypoint.sh && mkdir -p /data && chown -R node:node /data

# No `USER node`: the entrypoint starts as root so it can repair the ownership
# a bind mount overlays onto /data, then re-execs itself through su-exec as
# 1000:1000. Nothing but that first phase ever runs privileged. The build-time
# chown above stays correct for a named volume and for `docker run` with no
# mount, and an already-unprivileged start (`user: "1000:1000"`, rootless
# Podman) skips the repair rather than failing.
VOLUME /data
EXPOSE 3000

# Branched on ROLE, because a worker-only container runs no HTTP server and
# wget-ing :3000 in it would fail forever (hostability contract 4). ROLE=worker
# asks its own worker_heartbeat row through the same threshold /api/health
# uses; web and all keep the HTTP check, whose payload now carries the
# worker's status without letting a stale worker fail the web container.
# The timeout is 10s for the worker branch: tsx has to boot and connect.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD if [ "${ROLE:-all}" = worker ]; then \
        node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/src/health.ts; \
      else \
        wget -qO- http://127.0.0.1:3000/api/health || exit 1; \
      fi

ENTRYPOINT ["/entrypoint.sh"]
