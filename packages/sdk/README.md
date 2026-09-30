# @spaces/sdk

The plugin contract: what a plugin imports, and the only thing it imports.
The design is `docs/spec-plugin-sdk.md` (§3 manifest, §4 ports, §5 triggers,
§6 `definePlugin`); the decisions behind it are D51–D55 in
`docs/decisions-2026-09.md`.

Dependencies: `effect`, `zod` and — from sdk-4b — `tldts`, and nothing inside
this repo (D55). `src/package.test.ts` pins that list; the eslint sdk zone
(`packages/config/eslint.base.js`) fails any `@spaces/core` or `@spaces/db`
import, and `src/fence.test.ts` proves it.

## What is here (sdk-3)

- `SDK_VERSION` — this package's version, spelled once (`src/version.ts`).
- `satisfiesSdk(range, host?)` — `manifest.sdk` against the host. Three
  operators (`^x.y`, `~x.y`, exact `x.y.z`), hand-rolled; a refusal carries
  the sentence the loader writes as the degraded reason
  (`requires sdk ^2.0, host provides 1.0.0`).
- `manifestSchema` — the on-disk `manifest.json`. No plugin `kind` (D51):
  each job has a `trigger` (`action` · `schedule` · `event` · `webhook` ·
  `file`) and the ports it `uses`.
- `defineManifest` / `toManifestJson` — the manifest is authored once as a
  TS const with a zod `settings` schema and emitted with `settings` as JSON
  Schema (`z.toJSONSchema`, input mode), so web can render the settings card
  without loading the bundle.
- `definePlugin` — the bundle's default export; its `jobs` must carry exactly
  the manifest's job names.

## The frozen contract (sdk-4a) — `src/contract.ts`

One file, to be read and reviewed as one; it moves only on an SDK major.

- `PORT_NAMES` — the twelve ports a job may list in `uses` (the spec §4
  table minus Clock); the manifest validates `uses` against it.
- The claims — the typed arguments of the write-port methods (D52):
  `IdentityClaim`, `AliasClaim`, `FactClaim`, `ReceiptClaim`, the three
  `_tag`-ged Content claims (`DocumentClaim`, `InteractionClaim`,
  `SignalClaim`) and `JudgmentClaim`. None carries a source, actor or
  integration field — provenance is the port's (`contract.test.ts`).
- `Ref` — the shipped citation grammar (D4) as a type; a URL is not a ref.
- The five trigger shapes and `JobFor<trigger>`, which `definePlugin` uses to
  type each job by its manifest entry; the `cost` hook on action jobs (D53);
  `DomainEvent` / `DOMAIN_EVENTS`; `JobError` (`JobRetryable`,
  `JobRateLimited`, `JobPermanent` — the worker's tags).
- `StorageSource` (`src/storage-source.ts`) — a provider interface with a
  TODO body the storage area (project 20) owns.

## Ports (sdk-5) — `src/ports.ts`

Twelve Effect service tags — `Identity`, `Facts`, `Content`, `Judgment`,
`Receipts`, `Ai`, `Read`, `Secrets`, `Config`, `PluginDb`, `Http`, `Log` —
each `class X extends Context.Service<X, Shape>()('spaces/sdk/X') {}`, with
no implementations (core's `writes/ports/` implements them; the loader binds
them to one integration row). The service keys are contract: a snapshot test
pins them. Write ports take the claims and return what the lane decided
(`resolve → { entityId, outcome }`, `fill → { conflicts }`, `store →
{ receiptId }`, …) and fail with `JobError`. A job's `R` is bounded by its
`uses`: yielding a port it did not declare fails typecheck. There is no Clock
port — Effect ships one, and the plugin lint zone refuses `Date.now()` and
`new Date()`. `configOf(manifest)` reads the config typed by the manifest's
own settings schema.

## Testing a plugin — `@spaces/sdk/testing` (sdk-5)

In-memory Layers that record every call and mint deterministic ids
(`entity-1`, `receipt-1`, …): `IdentityTest`, `FactsTest`, `ContentTest`,
`JudgmentTest`, `ReceiptsTest`, `ReadTest`, `SecretsTest`, `ConfigTest`,
`HttpTest` (scripted responses, exact request headers, a scripted 429 fails
`JobRateLimited`) and `LogTest` — each `{ layer, calls }`. `testPorts(…)`
builds all ten over one recorder. No database, no network:
`plugins/_fixtures/echo/src/enrich.test.ts` runs a whole job on them, and CI
runs it with `DATABASE_URL` unset. `Ai` and `PluginDb` have no fake yet.

## Writing a plugin

A plugin is a workspace package under `plugins/` (fixtures under
`plugins/_fixtures/`) depending on `@spaces/sdk`, with `effect` and `zod` as
peer dependencies — the host provides them. `plugins/_fixtures/echo` is the
smallest complete one:

```
src/manifest.ts   export const manifest = defineManifest({ … })
src/index.ts      export default definePlugin({ manifest, jobs: { … } })
vite.config.ts    export default defineConfig(pluginBuildConfig())
```

## The plugin build — `@spaces/sdk/build`

Decided by sdk-3: one `vite build --ssr` config, exported from this package
as `pluginBuildConfig()`, that every plugin's `vite.config.ts` reuses (D26
made vite the workspace's one bundler). `pnpm build` in a plugin writes:

- `dist/bundle.mjs` — one ESM file with every third-party dependency the
  plugin has inlined, and exactly three bare imports left for the host:
  `effect`, `zod`, `@spaces/sdk` (plus `node:*`). A plugin never ships its own
  Effect or its own SDK: two copies of the SDK's service tags in one process
  is "service not found" at best. The loader (sdk-11) resolves the three to
  the host's copies.
- `dist/manifest.json` — the bundle's `default.manifest` through
  `toManifestJson`, validated by `manifestSchema` on the way out, so a build
  that would write a manifest the loader refuses fails at build time.

`vite` is an optional peer of this package: only `@spaces/sdk/build` uses it,
and only at a plugin's build time.

## Pack and sign — `@spaces/sdk/pack` (sdk-21a)

`pnpm --filter <plugin> pack:plugin` (the `spaces-plugin-pack` bin) packs a
built plugin's `dist/` into `dist/pack/<id>-<version>.tgz` + `.sha256`, and —
with an ed25519 private key from `--key <file>` or `SPACES_PLUGIN_SIGNING_KEY`
— a detached `.sig` and the `registry.json` entry `<id>-<version>.json`. The
tarball is a gzip'd ustar written by this package's own reader/writer
(`src/pack/tar.ts`: deterministic, no dependency); core's
`@spaces/core/plugins/verify` reads it with the same reader. Key ids are
content-derived (`keyIdOf`); the trusted public keys live in the repo's
`plugin-keys/`, never in the registry. Without a key the pack is unsigned and
loads only where `./data/plugins/.allow-unsigned` exists.

## This package's own build

Unlike `@spaces/core` and `@spaces/db`, whose `exports` point at source,
this package's point at `dist/` (`tsc -p tsconfig.build.json`, ESM + d.ts).
A plugin bundle imports `@spaces/sdk` as a bare specifier that plain node
resolves at runtime, and node cannot load a `.ts` file from a package. In the
workspace, turbo's `^build` edge builds it before any dependent's `typecheck`,
`test` or `lint`; if you run a dependent's vitest directly after editing the
SDK, run `pnpm --filter @spaces/sdk build` first.

```
pnpm --filter '@spaces/sdk...' build   # the sdk, then echo's bundle.mjs + manifest.json
pnpm exec turbo run test --filter=@spaces/sdk --filter=@spaces/plugin-echo
```

Neither suite needs Postgres.
