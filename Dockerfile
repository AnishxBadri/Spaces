# Multi-arch (arm64 matters). No build-time env vars — client-visible config
# comes from the server at runtime, never VITE_* baking.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Workspace manifests only, so the install layer is cached against dependency
# changes and not against source. Every package.json the lockfile has an
# importer for must be here or --frozen-lockfile fails.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
# --ignore-scripts, both install stages. The root `prepare` is `lefthook
# install`, which needs a git binary and a .git directory; alpine ships
# neither and .dockerignore keeps .git out of the context — so without this
# flag the image simply does not build. Git hooks are a developer-checkout
# concern and have no business inside the image. No dependency here needs a
# postinstall either: the two that carry native code (esbuild, lightningcss,
# the `pnpm.onlyBuiltDependencies` allowlist) ship prebuilt per-platform
# packages that pnpm links without running anything.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
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

# Runtime needs: apps/web's .output (web) and src (the boot entry via tsx),
# apps/worker's src (the worker and its health command via tsx; SPA-181),
# packages/db's src + drizzle (schema, migrator and the journal),
# packages/core's src (the worker's extractor lives there since SPA-144), prod
# node_modules (pg-boss, drizzle-orm, unpdf, mammoth, fflate, tsx).
#
# Every workspace package keeps its workspace path under /app — apps/web,
# apps/worker, packages/config, packages/db, packages/core — because the
# relations between them are relative: `node_modules/@spaces/db` and
# `@spaces/core` are relative symlinks into packages/, the migrator resolves
# the journal from its own `import.meta.url` (so it lives at
# /app/packages/db/drizzle, the path CI's `hostability` job mounts an "older
# image" fixture over), every tsconfig `extends` names `../../packages/config`,
# and apps/worker's tsconfig points `#web/*` at `../web/src`. Until SPA-181
# apps/web alone was flattened onto /app (/app/src, /app/.output); the worker
# moving out is what made the layout have to be the workspace's own.
#
# The two app tsconfigs come along because tsx resolves `#/…` (and the
# worker's `#web/…`) from tsconfig `paths` and NOT from package.json `imports`
# — Node rejects `#/*` as an internal imports key outright — so without them
# `tsx apps/web/src/db/boot.ts` dies on its first `#/` specifier and the
# worker on its first `#web/`. Both extend packages/config/tsconfig.base.json,
# copied to the path the extends names. packages/db's and packages/core's own
# tsconfigs are deliberately not copied: nothing in the image typechecks.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/web/.output ./apps/web/.output
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/worker/package.json apps/worker/tsconfig.json ./apps/worker/
COPY apps/worker/src ./apps/worker/src
COPY packages/config/package.json packages/config/tsconfig.base.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/db/src ./packages/db/src
COPY packages/db/drizzle ./packages/db/drizzle
COPY packages/core/package.json ./packages/core/
COPY packages/core/src ./packages/core/src
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
    && chmod +x /entrypoint.sh && mkdir -p /data && chown -R node:node /data /app

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
        node_modules/.bin/tsx apps/worker/src/health.ts; \
      else \
        wget -qO- http://127.0.0.1:3000/api/health || exit 1; \
      fi

ENTRYPOINT ["/entrypoint.sh"]
