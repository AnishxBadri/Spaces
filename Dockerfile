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
COPY packages/config/package.json ./packages/config/
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
COPY packages/config/package.json ./packages/config/
# --node-linker=hoisted, and only here. The image layout is deliberately
# unchanged by the workspace move — apps/web's `src/` still lands at /app/src,
# so docker/entrypoint.sh is untouched — which means the worker resolves its
# dependencies from /app/node_modules. pnpm's default isolated linker would
# put them in apps/web/node_modules as symlinks into ../../node_modules/.pnpm,
# and those relative links break the moment the directory is copied anywhere
# else. Hoisted writes one flat tree at /app/node_modules that copies as-is.
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

# Runtime needs: .output (web), src + drizzle (worker + migrations via tsx),
# prod node_modules (pg-boss, drizzle-orm, tsx).
#
# The in-image layout is unchanged by the workspace move: apps/web's tree is
# flattened back onto /app, so /app/src, /app/drizzle and /app/package.json
# sit exactly where they did, and docker/entrypoint.sh needed no edit.
#
# tsconfig.json comes along because tsx resolves `#/…` from tsconfig `paths`
# and NOT from package.json `imports` — Node rejects `#/*` as an internal
# imports key outright — so without it `tsx src/db/migrate.ts` dies on the
# first `#/` specifier. It now extends packages/config, so the base file is
# placed at the `../../` the extends names, which from /app is /packages.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/web/.output ./.output
COPY apps/web/package.json apps/web/drizzle.config.ts apps/web/tsconfig.json ./
COPY packages/config/tsconfig.base.json /packages/config/tsconfig.base.json
COPY apps/web/drizzle ./drizzle
COPY apps/web/src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown -R node:node /data /app

# No `USER node`: the entrypoint starts as root so it can repair the ownership
# a bind mount overlays onto /data, then re-execs itself through su-exec as
# 1000:1000. Nothing but that first phase ever runs privileged. The build-time
# chown above stays correct for a named volume and for `docker run` with no
# mount, and an already-unprivileged start (`user: "1000:1000"`, rootless
# Podman) skips the repair rather than failing.
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
