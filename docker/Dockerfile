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
#   build      installs the first cut and runs both packages' `build`:
#              apps/web/.output (the web app), apps/web/dist/boot.mjs, and
#              apps/worker/dist/{index,health}.mjs (SPA-185, `vite build --ssr`)
#   prod-deps  installs the second cut, --prod — the image's node_modules
#   (final)    .output, the three bundles, the drizzle SQL, node_modules —
#              no application source and no tsx
#
# Why the runtime cut is the worker's alone: the web process runs from
# apps/web/.output, which Nitro bundles self-contained (its own
# .output/server/node_modules is a few kB of traced files). /app/node_modules
# serves only the three node bundles — the boot entry, the worker, its health
# command — whose npm imports stay runtime imports, so apps/web's own
# dependency list (vite, rolldown, blocknote, lucide, the
# radix set, fonts, typescript through peers) has no business being
# installed. apps/worker/package.json declares everything the worker process
# loads, including what it reaches through the `#web/*` crossings, and the
# boot entry's closure is a subset of it.
#
# Bundler: `vite build --ssr` (D26, CONTEXT.md). The bundles inline the
# workspace's own code (@spaces/db, @spaces/core, apps/web's server modules the
# worker crosses into) and import every npm package from node_modules at run
# time; apps/worker/vite.config.ts and apps/web/vite.boot.config.ts say why.

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
# @spaces/sdk first, in its own step (SPA-195): its `exports` point at dist/,
# and since the identity normalizers moved into it, core — and so both apps —
# import it at runtime. Not one `--filter` list: pnpm orders filtered packages
# by their direct dependencies only, and the apps reach the sdk through
# @spaces/core, so a single call raced the worker's vite build against the
# sdk's tsc (PR #4, "failed to resolve import @spaces/sdk/identity").
RUN pnpm --filter @spaces/sdk build
RUN pnpm --filter @spaces/web --filter @spaces/worker build

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
# tsx is nobody's dependency here any more (SPA-185 moved it to
# devDependencies in apps/web and apps/worker; the image runs bundles with
# plain node), yet the install above still brings it: the worker's bundle
# imports better-auth (lib/server/shared.ts → lib/auth.ts), and the lockfile
# snapshot of better-auth resolves its optional peers — drizzle-kit, vite —
# against the workspace, and both of those carry tsx. A frozen install cannot
# skip resolved peers (auto-install-peers is recorded in the lockfile), so the
# one package this image promises not to contain is removed by name, and CI's
# `image` job asserts it stays gone.
RUN rm -rf node_modules/tsx node_modules/.bin/tsx

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOME=/home/node

# su-exec is how the entrypoint drops root after repairing /data (hostability
# contract #1). ~20KB; no init system, no gosu-sized Go binary.
RUN apk add --no-cache su-exec

# Runtime needs, and nothing else (SPA-185): apps/web/.output (the web
# process), apps/web/dist/boot.mjs (migrate → seeds → value-index reconcile,
# run by the entrypoint before either process), apps/worker/dist/index.mjs
# (the worker) and dist/health.mjs (the ROLE=worker HEALTHCHECK), the drizzle
# journal, and prod-deps' node_modules. No `src/` anywhere, no tsconfig, no
# tsx: the bundles are plain ESM that node runs as-is.
#
# The journal keeps its workspace path, /app/packages/db/drizzle — the
# directory CI's `roundtrip` job mounts an "older image" journal over. It is
# never bundled: the downgrade guard compares the database against the
# directory. `@spaces/db` finds it from its own `import.meta.url`, which in a
# bundle is the bundle's directory, so the entrypoint names the folder to the
# boot entry explicitly (its argv[2]).
#
# Until SPA-185 this block also carried apps/*/src, packages/*/src, two
# tsconfigs and hand-made `node_modules/@spaces/{db,core}` links, because tsx
# resolved `#/` from tsconfig `paths` read from its cwd and Node rejects `#/*`
# outright (the SPA-181 review: the image did not boot without `--tsconfig`).
# Bundling resolves every alias and workspace import at build time, so all of
# that went with tsx.
#
# Every COPY into /app carries --chown=node:node rather than one `chown -R
# node:node /app` at the end. The ownership is the same; the recursive chown
# was not free — it rewrites every file it touches into a new layer, so the
# image carried node_modules twice (SPA-183 measured it).
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/web/.output ./apps/web/.output
COPY --chown=node:node --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node --from=prune /app/out/build/full/packages/db/drizzle ./packages/db/drizzle
# @spaces/sdk at runtime (sdk-11): the one workspace package the worker bundle
# leaves as a bare import (apps/worker/vite.config.ts), because a plugin
# bundle's own `@spaces/sdk` import is resolved by the loader's hook to the
# copy the worker loaded — one set of port tags in the process. Copied, not
# linked: prod-deps' hoisted install links no workspace package (see above),
# and the sdk's own dependencies (effect, zod, tldts) are already in
# /app/node_modules from it. Its package.json carries the `exports` map node
# resolves `@spaces/sdk/identity` and `@spaces/sdk/build` through.
COPY --chown=node:node --from=build /app/packages/sdk/package.json ./node_modules/@spaces/sdk/package.json
COPY --chown=node:node --from=build /app/packages/sdk/dist ./node_modules/@spaces/sdk/dist
# Plugin trust (SPA-193, D54): the committed plugin index and the public keys
# this image trusts to sign plugins. Straight from the build context — neither
# is a workspace package, so `turbo prune` does not carry them. The keys are
# read from /app/plugin-keys by @spaces/core/plugins/trust (the cwd, since the
# image has no workspace marker), never from registry.json and never from env.
COPY --chown=node:node registry.json ./registry.json
COPY --chown=node:node plugin-keys ./plugin-keys
COPY docker/entrypoint.sh /entrypoint.sh
RUN chown node:node /app \
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
# The worker branch runs the bundled health entry with plain node (SPA-185) —
# it was the one thing that would otherwise have pinned tsx in the image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD if [ "${ROLE:-all}" = worker ]; then \
        node apps/worker/dist/health.mjs; \
      else \
        wget -qO- http://127.0.0.1:3000/api/health || exit 1; \
      fi

ENTRYPOINT ["/entrypoint.sh"]
