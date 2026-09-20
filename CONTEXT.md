# Spaces — context

**Name re-decided 2026-08-13: Spaces** (supersedes Angle, decided 2026-08). Named for the
product's own core concept — the user-built taxonomy is the thesis of the tool. Costs
weighed and accepted by owner: the name collides with the spaces _feature_ (may later
rename the feature to Markets — the onboarding block already says "markets creator"), and
"Spaces" is externally crowded (X Spaces, DigitalOcean Spaces; weak trademark/SEO) —
irrelevant for a self-hosted, word-of-mouth tool. Mechanical rename landed 2026-09-16
(ship-1 / SPA-24): wordmark, title, sidebar, package.json, compose files, Postgres
role/database, CI, backup script all say Spaces. Three strings deliberately frozen under
the old name: the `'dealos:better-auth-secret'` HKDF label (key-derivation input), the
`dealos.*` localStorage prefs keys (unrecoverable layout reset), and the
`dealos-glossary` ProseMirror plugin key (internal, harmless). `@spaces/*` are internal
workspace names only (`"private": true`); the public npm scope/domain decision is deferred
to whichever slice first runs `npm publish`.

## What this is

Open-source, **self-hosted** deal management OS for **angel and private capital investing**.
Think TagHash / Affinity, but you run it, you own the data, and every AI or data provider
is BYOK (bring your own key).

Not a horizontal CRM. Opinionated for investors. That constraint is the product.

## Who runs it

**Design target is one investor.** Must not preclude 1–15 users on one deployment later.
One deployment = one organization holding **N workspaces (books)**; only the user account
is global (revised 2026-08-15 — see the multi-workspace block in _Single user first, team
ready_). Two unrelated funds still run two containers today; hosted multi-org is a noted
future intent, not built.

Practically: build single-user UI, but carry `author_id` / `owner_id` / `visibility` on every
row that could ever be personal, from the first migration. See _Single user first, team ready_.

## Non-goals

- No hosted SaaS _yet_ — self-host remains the product; selling a deployed version is
  recorded future intent (2026-08-15), gated on its own design + security pass.
- No stranger-tenancy isolation (RLS/per-tenant schemas) until that pass.
- ~~No no-code object builder (custom _attributes_ yes, custom _objects_ no).~~
  **Reversed 2026-09-02:** custom objects yes — but strictly as the
  **attribute-bag tier** (see "Two-tier object model" in the attribute engine
  block and `docs/spec-attribute-engine.md`). ~~The non-goal narrows to: custom
  objects never get identity/dedupe/merge/enrichment/interaction machinery.~~
  **Narrowed again 2026-09-13:** fuzzy-name dedupe, merge-as-target and opt-in
  `domain`/`linkedin` identity keys reach every object; only enrichment,
  interactions and seeded attributes stay core-only. Attio keeps the wider
  exclusion (verified live 2026-09: their custom objects are attribute bags
  too); ours no longer matches them there.
- Not at MVP: LP reporting, portfolio MIS collection, mobile, sequences, dashboards, workflow automation.

## Why self-host wins here

- Funds won't put deal terms, decks, and cap tables in someone else's SaaS.
- Local models (Ollama) keep confidential decks off third-party APIs — matters for deep-tech/defence.
- Enrichment provider ToS (Apollo/Crunchbase) sit between operator and provider, not with us.
- Open schema, no lock-in.

## License

AGPL-3.0. Can relicense permissively later; reverse is impossible once contributors arrive.

---

# Architecture decisions

> Synthesis view for newcomers: `docs/ARCHITECTURE.md` — every model (workspace,
> entity graph, objects, research, mandate, deals, templates, financial engine),
> the stack, and the TagHash-parity map, in one read. This file remains the deep
> decision record.

## Stack

One language, TypeScript, one codebase. Two processes (web, worker), two containers (app, db).

| Layer      | Choice                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | **TanStack Start** (TanStack Router + Vite + Nitro), React 19                                                                                                                                                                                                                                                                                                                                           |
| DB         | Postgres 17 + Drizzle                                                                                                                                                                                                                                                                                                                                                                                   |
| Extensions | `pgvector`, `pg_trgm`, `ltree`, `unaccent`                                                                                                                                                                                                                                                                                                                                                              |
| Data layer | TanStack Query + Start server functions — one model everywhere                                                                                                                                                                                                                                                                                                                                          |
| Jobs       | pg-boss, Postgres-backed, separate Node process                                                                                                                                                                                                                                                                                                                                                         |
| Auth       | Better Auth (`tanstackStartCookies` plugin, Postgres adapter)                                                                                                                                                                                                                                                                                                                                           |
| Editor     | **BlockNote** (ProseMirror/TipTap-based), Notion-grade block UX; JSON authoritative, markdown derived                                                                                                                                                                                                                                                                                                   |
| Grid       | TanStack Table + TanStack Virtual, DOM-based                                                                                                                                                                                                                                                                                                                                                            |
| UI         | shadcn/ui + Tailwind + Radix, `cmdk` for Cmd-K                                                                                                                                                                                                                                                                                                                                                          |
| LLM        | Vercel AI SDK, BYOK                                                                                                                                                                                                                                                                                                                                                                                     |
| Blobs      | local filesystem default, S3 opt-in                                                                                                                                                                                                                                                                                                                                                                     |
| Validation | Zod, hand-written at write-path choke points (drizzle-zod considered and skipped — schema-derived validators can't carry the per-type business rules)                                                                                                                                                                                                                                                   |
| Tests      | Vitest + Playwright                                                                                                                                                                                                                                                                                                                                                                                     |
| Tooling    | pnpm; ~~single app, no monorepo~~ — **reversed 2026-09-13** by _Plugin architecture_ below: Turborepo monorepo (`apps/*` · `packages/*` · `plugins/*`). The workspace landed 2026-09-19 (SPA-101, `mono-1`): `apps/web` + `packages/config`, scope `@spaces/*`, every package keeping its own `#/*` subpath imports. `turbo.json` is `mono-1b`; `packages/db` · `core` · `sdk` follow through `mono-6`. |

Server functions live in `src/lib/server/`, one file per domain, re-exported through the
`#/lib/server-fns` barrel (split 2026-08 at ~2,900 lines, before auth/mandate/templates
each added a domain). Pin discipline (2026-08): no `latest` version specifiers — TanStack
deps pinned to resolved versions; upgrades are deliberate events. The prod worker runs
TypeScript via tsx (one build pipeline, accepted 2026-08); bundle it when an image actually
ships — **the bundler is open as of 2026-09-15 and it is not ~~esbuild~~**: `docs/spec-plugin-sdk.md`
§2 (2026-09-13) says tsup, and roadmap D26-worker-bundler recommends `vite build --ssr` (no new
dependency, the rolldown pipeline the web build already uses) and is awaiting the owner's call,
carried by `mono-13b`. Record whichever wins here. esbuild is present only as vite's transitive
build dependency.

### Backend paradigm (decided 2026-09-04, "future" branch deliberation)

The integration phase (email, enrichment, AI lanes, feeds — heavy background
jobs) gets a named paradigm: **typed effect-system backend over a single
relational coordinator.** Nine decisions:

1. **Effect TS is the backend base, adopted by ratchet, never big-bang:**
   all _new_ server code is Effect-first (including the attribute-engine
   sequence); existing modules convert only when open for behavioral change
   in the same PR; the merge executor converts last, alone, on its test
   suite; no dedicated migration sprints. Seam: one `effectFn()` adapter
   (Effect → TanStack server-fn); Effect never crosses into React.
2. **Zod stays at the boundaries** — `valueValidator` is load-bearing;
   Effect Schema is a separate later decision, not a rider.
3. ~~**API layer: oRPC on Effect** (`@orpc/experimental-effect`)~~ —
   **amended 2026-09-16 (owner): the external door is `effect/unstable/httpapi`.**
   The original pick bought one thing: a single procedure definition serving
   both audiences, typed TanStack Query hooks internally and OpenAPI
   externally (capture, forms, webhooks, n8n crowd). The internal half of
   that trade no longer exists — `createServerFn` already serves ~20 modules
   in `src/lib/server` typed end to end, and decision 4 keeps it — so the
   bridge was being paid for with a `@beta` dependency chosen against Effect
   v3's service APIs while the repo runs `effect@4.0.0-rc.112`. The recorded
   fallback ships **inside that pinned version**: `HttpApi`, `HttpApiEndpoint`,
   `HttpApiGroup`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiMiddleware`,
   `HttpApiSecurity`, `HttpApiScalar`, `OpenApi` and `HttpApiTest`. Unstable
   inside a package you pin beats beta in a package that moves on someone
   else's release. `@orpc/*` was never installed, so nothing is being ripped
   out. tRPC still rejected; GraphQL still rejected (Twenty needs it for
   schema-per-workspace SaaS; our registry-generated in-process UI doesn't).
   **The cost this incurs, to be paid deliberately in `api-1`:** HttpApi speaks
   Effect Schema, so it makes half of decision 2's deferred question for the
   external boundary. Zod stays at the server-fn boundary and in
   `valueValidator` — which is the attribute engine's type system and is
   needed at the external boundary the moment the capture endpoint, native
   forms or the MCP propose tool write a record. `api-1` must lift
   `valueValidator` into an Effect Schema refinement once, as an acceptance
   criterion, rather than discovering the seam at the first external write.
   `effect/unstable/rpc` sits beside httpapi if a typed-client-from-one-
   definition surface is ever wanted internally; that, not oRPC, is the
   native answer. Carried by roadmap slice `api-1`; closes D8.
4. **Internal interactive path stays server-fns** — in-process, already
   typed; new operations that will ever be externally callable or want
   generated hooks are born as oRPC procedures instead. The boundary finds
   itself; nothing rewrites on principle.
5. **Seam rules:** server-fns never do slow work (>~200ms or any external
   API → enqueue and return); workers write through the same one-write-paths
   (`setValues`, `resolveEntity`, suggestions) as typed actor `integration`;
   UI freshness via query invalidation, no websockets until measured need.
6. **pg-boss stays the queue; Postgres is the only coordinator** — queue,
   staging, cursors, vectors, tsv in the one DB. No Redis until a measured
   reason (precedent: Oban runs Plausible's SaaS, Solid Queue is the Rails 8
   default — DB-backed queues are the deliberate choice at SaaS scale now,
   not the toy tier).
7. ~~**Capability model, not a plugin system:** all code ships dormant;
   a capability activates via key/toggle/compose-overlay. Dormant = zero
   cost. No third-party runtime plugin loading ever.~~ **Reversed
   2026-09-13 — see _Plugin architecture_ below.** What survives: the
   gating rule ("no key = feature hidden", generalized to "no row = feature
   absent") and "external extensibility is MCP + webhooks + API" for
   anything that is not an ingestion adapter. What changed: integrations
   leave the image and load at runtime from a registry.
8. **Dual-end doctrine** (self-host today, recorded SaaS intent later):
   Postgres-only mandatory dependency, scale by replicas of the same
   processes, capabilities not forks (GitLab / Plausible / 37signals-ONCE
   pattern); keep tenancy cheap — no new global state.
9. **One-write-path enforcement moves to lint** when convenient (ESLint ban
   on `db.update(entity)` outside `setValues` — Relaticle's PHPStan rule,
   our flavor).

### Plugin architecture (decided 2026-09-13, reversing paradigm decision 7)

_Decision summary; the contract is `docs/spec-plugin-sdk.md`, storage sources are
`docs/spec-storage-sources.md`, the AI side is `docs/spec-ai-substrate.md` §9–14._

**Why the reversal.** "Dormant compiled-in" zeroes runtime cost but not the
other four costs a self-hoster carries for integrations they never enabled:
image bytes (googleapis-class deps), attack surface in `node_modules`,
migrations run on their box, and — the one that decided it — every vendor
baked into shared enums (`entity_source`, `alias_source`,
`interaction_source`, `document_origin` all name gmail/apollo/clip; the
vault and `signal` tables, written under the BYOK doctrine, got it right
with open `provider` text). A third-party plugin cannot ship a migration
that edits a shared enum safely, so the compiled-in model blocks an
ecosystem at the schema level, not just aesthetically.

**Doctrine: plugins feed the graph; they never extend the product.** Twenty
lets apps ship React, custom objects and serverless functions (a platform
play). We ship ingestion adapters. A plugin returns _claims_; core routes
them through the existing claim-type lanes with the doctrine enforced in the
port, not trusted to the plugin. No plugin React, no plugin db handle, no
plugin edits to `public.*`. Cost accepted: a third party cannot add a
record-page panel or a new shape of thing — those land in core. That is the
ratchet, not a gap.

**Shape (monorepo, Turborepo):**

```
apps/web        TanStack Start — knows zero plugin code; renders from manifests
apps/worker     pg-boss host + plugin loader — the ONLY process that executes plugin code
apps/site       marketing/docs — never in the image
apps/extension  MV3 capture
packages/db     drizzle schema, public.* migrations, ENTITY_REFS
packages/core   Effect services: ports/lanes, resolveEntity, setValues, vault, storage, ai/
packages/sdk    @spaces/sdk — manifest + port interfaces + kind interfaces + definePlugin +
                testing kit. Types only. Own semver. Imports nothing from core/db (turbo-enforced).
packages/ui     tokens + components shared by web and site
plugins/<id>    imports sdk only; builds to a single ESM bundle + manifest.json + migrations/
registry.json   plugin index (id, version, sdk range, sha, sig, tarball url); committed,
                copied into the image so offline installs see the list
```

**Package manager: pnpm 10 (pinned 2026-09-19, SPA-43).** `packageManager`
names `pnpm@10.34.5` with the integrity suffix corepack writes, and that field
is the only place a pnpm version lives: the Dockerfile's `corepack enable`,
CI's `pnpm/action-setup@v4` (no `version:` key) and lefthook's `pnpm exec`
hooks all resolve from it. The bump landed ahead of `mono-1` rather than
behind `mono-13a` because the two pnpm 10 behaviours that matter are about the
monorepo, not about today's flat tree: `workspace:` protocol resolution, of
which `mono-1` creates the first instance, and `turbo prune --docker`
(`docs/spec-plugin-sdk.md` §2), which rewrites the lockfile pnpm wrote and is
the first thing that cares which pnpm wrote it. A whole-lockfile regeneration
buried inside a whole-tree rename is a diff nobody can read; on its own it is
one line, and on this tree it was a no-op — pnpm 10 rewrote the lockfile
byte-identically, `lockfileVersion` stayed `9.0`, and nothing resolved
differently. pnpm 10 also stopped running dependency build scripts by default;
`pnpm.onlyBuiltDependencies: [esbuild, lightningcss]` was already in
`package.json` and both still build. `mono-1` confirms this pin rather than
re-arguing it.

**packages/db — what moved, and the one seam left open (SPA-142, `mono-3`).**
The schema, the drizzle journal, `ENTITY_REFS`, the worker heartbeat, the
downgrade guard and the migrator are `packages/db` as of 2026-09-19, and the
package imports nothing internal — that property, not the file locations, is
what the slice was for. Four `#/lib/...` imports stood in the way and each was
resolved the same way: **the column owns the type**, so the payload shape moved
to the column and the app module that used to declare it now re-exports it.
`Json` → `@spaces/db/json`; `Condition`/`ViewSort`/`ViewExtra` → the `view`
table; `AttributeOptions`/`SelectOption`/`ObjectKind`/`BadgeColor` → the
`attribute` table; `ContextKind`/`ContextHop` → `entity-refs.ts`, which is the
only file that speaks them. No import in `apps/web` changed; the behaviour —
matchers, validators, seeded `SYSTEM_ATTRIBUTES`, the badge palette — stayed
in the app.

The seam deliberately left open is seeding. `packages/db` exports
`runMigrations()` and a bin that runs migrations and stops; the boot
composition — migrate, then `seedSystemAttributes`, then `seedStarterTaxonomy`,
as one command, which is what the container entrypoint and `pnpm
db:migrate:run` both invoke — lives in `apps/web/src/db/boot.ts`. That is
interim: the two seeds are core concerns wearing an app's clothes, and
**`mono-9a` moves them into `packages/core` and the composition with them**.
The one-command contract survives both moves; what must never happen is
`packages/db` growing a seed, because then the schema package would depend on
the product.

Two mechanical facts the move turned on. The migrations folder is resolved
from `import.meta.url`, never from cwd — it used to be the literal
`'./drizzle'`, which worked only because the entrypoint happens to `cd /app`
— so in the image the journal is at `/app/packages/db/drizzle` and an "older
image" fixture mounts over that path. And drizzle records each applied
migration as `(hash = sha256 of the .sql body, created_at = the journal's
"when")`, which is exactly what SPA-36's guard compares: a journal that moves
unchanged passes, a journal that is regenerated refuses to boot. The move was
verified by dumping `select hash, created_at from
drizzle.__drizzle_migrations` before and after — 25 rows, byte-identical —
not by reading the diff.

**Ports = the SDK contract.** Effect service tags, one per lane, provenance
stamped by the port from the bound `integration` row (a plugin cannot forge
who wrote what): `Identity` (resolveEntity / addIdentityAlias) · `Facts`
(setValues, fill-blanks, conflict → suggestion) · `Content` (document /
interaction / signal) · `Judgment` (review inbox) · `Receipts`
(enrichment_record) · `Ai` (lane + budget, never a model or a key) · `Read`
(canRead as integration) · `Secrets` (vault, worker-only decrypt) · `Config`
(manifest-typed) · `PluginDb` (drizzle scoped to `plugin_<id>` schema) ·
`Http` (rate-limited, header-driven throttle) · `Log`. **Ports are granted
per (integration, job), by kind** — an enricher gets `Facts`, a researcher
does not; the Layer the loader provides is the privilege boundary, and the
job's `R` type documents it. Kinds: `enricher` · `researcher` · `syncer` ·
`ingress` · `importer` · `poller`. Each returns claims, never writes.

**AI is substrate, not a plugin.** It sits _below_ the SDK as the `Ai`
port: plugins consume the extract/classify/synthesize lanes, sensitivity
routing must bind every caller, and plugins cannot depend on plugins.
Providers are core-owned AI SDK adapters keyed from the vault. The MCP
server is an outbound head on the substrate (spec §5's "plugin" wording
means "the user's assistant plugs in"). A narrow `llm-provider` kind for
exotic backends is deferred until asked for.

**Runtime and hosting contracts (extend the six hostability contracts):**

- The image is the immutable core; plugins live in `./data/plugins/<id>/
<version>/` next to blobs and `secret.key`. Consequence: the existing
  both-or-neither backup already covers plugin code and versions;
  `lock.json` there pins `{core, plugins}` for reproducible restore.
- Install from the running deployment, admin only, no redeploy: web
  fetches the tarball named by the registry (or accepts an upload for
  air-gapped boxes) → verifies sha256 + signature → unpacks → writes the
  `integration` row → `NOTIFY plugin_changed`. Worker LISTENs, checks the
  manifest's sdk range, runs the plugin's migrations in its own Postgres
  schema with its own journal, builds the Layer, registers jobs and ingress.
  Web moves bytes and writes rows; it never executes plugin code.
  `SPACES_PLUGINS=apollo,rss` is an optional first-boot convenience that
  runs the same installer; the required-env set stays `{DATABASE_URL,
APP_URL}`.
- Boot reconciles every start: row present + files present + sdk satisfied
  → enabled; anything else → `degraded` with the reason, jobs skipped, boot
  continues. A plugin never crashes the box. `/api/health` lists degraded
  plugins; a worker heartbeat row makes `ROLE=worker` checkable (contract 4).
- Core upgrade is unchanged (`backup → pull → up`); plugin bytes are
  untouched. An sdk major bump degrades incompatible plugins with the fix
  named from the bundled registry snapshot; core keeps a shim Layer one
  major back. Plugin upgrade is independent (fetch → verify → own migrations
  → swap `current`). Rollback of either = restore.
- Trust: in-process Node has no sandbox, so v1 loads first-party signed
  tarballs only (`--allow-unsigned` for development). Anything third-party
  or with a foreign runtime/ToS exposure (the WhatsApp bridge) is a
  companion container on a compose profile speaking to the webhook ingress
  with a PAT — its weight on its own profile. Companion design deferred.

**Workers and jobs.** pg-boss stays the queue (paradigm 6); the worker is a
plain Node process whose handlers become Effect programs run by one
`runJob` wrapper (parse → provide Layer → run → map typed failure to
retry / fail / circuit-breaker). Every plugin invocation is a job: manual
(declared `actions`), scheduled (`manifest.jobs[].schedule`), or
event-triggered (`on: ['entity.created']` — Attio's enrich-on-create is
this implicit trigger, not a different architecture). Interactive jobs get a
priority queue and `LISTEN/NOTIFY → SSE` status; a narrow read-only `query`
kind may use request/reply over pg-boss with a hard budget; webhook ingress
verifies a manifest-declared signature in web, stores the raw payload,
enqueues, and returns. Plugin failures increment `integration.error_count`
and trip a breaker that disables the plugin, never the worker (contract 2).
A `job_run` table (queue, integration, entity, status, timings, error)
serves the status stream, the Integrations page, and later the AI run log.

**Schema deltas this implies, before the first plugin (Apollo) lands:**
`integration(id, capability_id, version, enabled, status, config jsonb,
credential_id?, connection_id?, error_count, created_by)`; collapse the four
vendor-named enums into `source_class` (`manual | integration | ai | import
| seed | merge | extracted | inherited`) + `source_ref` (integration FK,
null unless class = integration), one migration, one code branch in
`resolve.ts`; typed actor on `attribute_event` per the attribute-engine
spec points at the same row. Manifest may later _request_ a custom object
by shape (created as an ordinary user-owned attribute-bag object on enable)
so plugin data is graph-visible without plugin UI — copied from Twenty,
noted, not built.

**The collapse landed on `entity` and `entity_alias` 2026-09-19 (SPA-118,
migration 0029).** Two things were settled to get it in, and both generalise:

- **`source_ref` references `integration.id`** — FK enforced, null unless
  `source_class = 'integration'`, both halves of the biconditional carried by
  a check constraint on each table, exactly as `attribute_event.actor_ref`
  does (decision D1). Not the connection: a storage binding's writes are
  attributed to the integration that owns the binding, and "whose account" is
  one hop away through `integration.connection_id`.
  `docs/spec-storage-sources.md` §3.1 is corrected to match.
- **First-party channels are not integrations.** Existing `clip` rows
  backfilled to `manual`: the browser extension is ours, and a clip is a
  person clicking a button. Core does not seed a synthetic `integration` row
  to describe its own channels — that would put a fiction in the table the
  Integrations page reads. If a first-party channel ever needs recording as
  such, it becomes its own column, never a fake integration row. Same rule
  retires `gmail` and `apollo` in that migration: with no integration row to
  name they backfill to `manual` and the vendor name is lost, which is the
  honest trade for a type no plugin could ever have migrated.

`interaction_source` and `document_origin` are the two still to convert.

**Build order:** `packages/sdk` (manifest, ports, `definePlugin`, testing
kit) + `runJob` + loader reading a plugins dir → `integration` table +
enum collapse → Apollo as `plugins/apollo`, loaded by path in dev through
the same loader → registry fetch, signing, settings-UI install → plugin
schemas with the first plugin that needs tables (RSS). Never: plugin React,
plugin db handle, plugin DDL in `public.*`, shared-enum vendor names.

### Architecture week 2026-09-13 → 15 — index

Recorded across this file and three specs; the roadmap in
`docs/ARCHITECTURE.md` §12 sequences the build.

| decision                                                                                                                                       | where                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| plugins leave the image; registry-installed into `/data/plugins`; worker is the only host; SDK = ports; AI is substrate                        | _Plugin architecture_ above · `docs/spec-plugin-sdk.md`      |
| vendor-named enums collapse into `source_class + source_ref`; `integration` table; typed actor                                                 | `docs/spec-plugin-sdk.md` §8                                 |
| custom objects gain fuzzy dedupe + merge + opt-in identity keys; no fourth system object; `organization` ghost deleted                         | _Two-tier object model_ · `docs/spec-attribute-engine.md` §9 |
| tasks stay a non-entity, join Cmd-K as a search lane                                                                                           | _Tasks + Today_                                              |
| the note model: three axes, memo = flag, kinds frozen at three, `interaction.note_id`, record filing via `tagged_in` + kind toggle             | _The note model_ · _Interactions_                            |
| documents: file into spaces, `/documents`, unfiled inbox, drop `kind: memo`, storage source ≠ blob backend, derived layers, retain per binding | _Sources are documents_ · `docs/spec-storage-sources.md`     |
| glossary → concept node with the AI substrate                                                                                                  | _Glossary_                                                   |
| embeddings never forced, dimension pinned at 768, local opt-in download, core-owned                                                            | _Embeddings_ · `docs/spec-ai-substrate.md` §9                |
| vault: workspace-only keys in v1, per-user OAuth grants, providers with N plugins, admin-only install                                          | _BYOK_                                                       |
| deck reader and every AI feature are core compositions, never plugins; gateway URL passthrough instead of Helicone                             | `docs/spec-ai-substrate.md` §11–13                           |
| monorepo (Turborepo): apps/web · worker · site · extension; packages/db · core · sdk · ui; plugins/*; `turbo prune --docker`                   | `docs/spec-plugin-sdk.md` §2                                 |

### Why TanStack Start over Next.js

Decided after arguing it properly. Do not relitigate without new information.

The app is ~95% authenticated, client-heavy, interactive UI behind a login. RSC buys that
almost nothing, so Next's server/client boundary is a tax paid on every component for no
return. Not a bundle-size or memory argument — those are noise next to TipTap and the grid.
It is a **model mismatch** argument, and the cost is daily.

Concretely:

- **One data-fetching model.** Under Next this app needed three primitives — Server Components
  for reads, Server Actions for mutations, route handlers + TanStack Query for the grid and
  search-as-you-type, because Server Actions serialize per request and can't carry rapid cell
  edits with optimistic rollback. Start does all of it with TanStack Query + server functions.
  One idiom in the two hardest components in the project.
- **Typed search params.** TanStack Router treats URL search state as validated, typed,
  serializable state. Saved views _are_ serialized filter/sort/group-by/column state. Near-free
  here, hand-rolled in Next. Drops `nuqs` from the stack.
- **Nitro `node-server` preset.** Plain Node output, simpler than `output: standalone` and its
  manual `public/` + `.next/static` copying. Deploy-anywhere, no platform gravity.
- **Worker is just a second Node process.** No `instrumentation.ts` singleton dance.

Costs accepted, eyes open: Start hit 1.0 in March 2026, so docs are thinner, churn risk is
higher, and the contributor pool is smaller than Next's. The contributor argument is the only
real one against — and at zero stars those contributors are hypothetical while build velocity
is not.

Cheap to switch today because every other library here is framework-agnostic. Would not be
cheap after the grid and editor exist.

### Rejected

- **A Rust/Go backend service.** Wealthfolio has Rust because Tauri desktop apps _must_ — the
  Axum server reuses crates written for the desktop shell. That's the consequence of a
  constraint we don't have. For 1–15 users the bottleneck is Postgres, Gmail, and LLM calls;
  Node is idle in all three. A second language halves the contributor pool, kills end-to-end
  types, splits migration ownership, and forces reimplementing unpdf/mammoth/sheetjs/TipTap.
  The real concern — CPU-bound extraction and embedding blocking the event loop — is solved by
  splitting the _process_, not the language. If one job ever truly needs native speed, sidecar
  that job; and prefer an existing binary (Ollama) over writing one.
- **SQLite** — need pgvector/tsvector/pg_trgm and concurrent sync workers.
- **Clerk/Auth0** — SaaS dependency kills self-host.
- **AG Grid** — the useful features are enterprise-licensed. Poison for AGPL.
- **Glide Data Grid** — canvas is faster at 100k rows, but you have ~2k companies, and canvas
  makes cell editors and accessibility painful.
- **Lexical** — markdown story is rough, thinner ecosystem.
- **TipTap directly** — was the original pick (markdown-as-source-of-truth doctrine). Reversed
  2026-07: owner wants Notion-grade block UX (drag handles, slash menu, block chrome) day one,
  and BlockNote ships it on the same ProseMirror engine. Costs accepted knowingly: note JSON
  becomes authoritative (`note.body_json`) with markdown derived via lossy export (search,
  embeddings, plain-text portability); glossary auto-link and custom mention serialization go
  through BlockNote's inline-content API instead of raw ProseMirror. If BlockNote fights the
  glossary feature hard, the escape hatch is dropping to its TipTap layer.
- **Separate vector DB, Elasticsearch, Redis, Trigger.dev** — Postgres and one app
  cover all of it at this scale. (Turborepo used to sit on this list; it came **off**
  on 2026-09-13 when _Plugin architecture_ above adopted a Turborepo monorepo, and
  the entry is gone rather than struck through because a rejection this file still
  lists is a rejection somebody will cite. The other four are unchanged. The
  workspace itself landed 2026-09-19 (SPA-101); `turbo.json` follows in `mono-1b`.
  See the architecture-week index and `docs/spec-plugin-sdk.md` §2.)
- **MinIO in default compose** — see storage below.

### Notes on specific picks

- **Note storage (amended 2026-07 with the BlockNote switch).** `note.body_json` (BlockNote
  document) is authoritative — BlockNote's markdown export is lossy, so round-tripping through
  markdown would corrupt notes progressively. `note.body_md` is _derived_ on every save and
  feeds search, embeddings, and plain-text export; mentions land in it as `[[Label|entity:uuid]]`.
  The original notes-outlive-the-app doctrine survives in weakened form: the derived markdown
  is always exportable and readable, but is not the editing source of truth.
- **Mentions** are BlockNote inline-content nodes carrying `{entityId, label}`; uuid
  authoritative, label a cached display string. Link rows sync from the JSON (walk inline
  content), not from markdown regex.
- **`pg_trgm` is not an extra dependency** — entity resolution owes you fuzzy name matching
  anyway. `ltree` for `space.path` ancestor queries. Both ship with the standard Postgres image.
- **Search is hybrid, fused in Postgres:** `tsvector` rank + pgvector cosine, combined via
  reciprocal rank fusion in one query. `pg_trgm` for the fuzzy-name path.
- **URL clipping:** `@mozilla/readability` + `linkedom`. Not jsdom — 10× the weight, same job.
- **Glossary auto-link:** Aho-Corasick, ~80 lines, built at render over the space's term set.
  No library.
- **TipTap licensing:** core and `@tiptap/extension-mention` are MIT. Pro extensions and
  Hocuspocus collab are paid. Single-user-first needs none of them — don't drift into one.

## Data model

**Two halves, one graph.**

- **Research half (PKM-shaped):** spaces, notes, sources, glossary. Slow, exploratory,
  no pipeline, no stages.
- **Deal half (CRM-shaped):** companies, pipeline lists, entries, activity. Fast, structured.

Most tools do one well and fake the other. **The seam is the product:** a company landing in
pre-lead already carries six months of notes on its subspace, the saved sources, and the
contacts you met there.

### Polymorphic core

Everything linkable is an entity. One mention system, one backlink query, one search index,
one attach mechanism.

```
entity(id, kind: company|person|organization|deal|space|note|document|term|custom,
       object_id → object, canonical_name, values jsonb, merged_into_id, source)
  -- kind list corrected 2026-09-15: `deal` (first-class 2026-07), `term`, and
  -- `custom` (two-tier objects, 2026-09-02) were missing. `organization` is
  -- decided-for-deletion but still live in code — see "Two-tier object model".

link(id, from_entity_id, to_entity_id, relation, attr_slug,
     source: manual|ai|extracted, created_by, created_at)
  relation: mentions | tagged_in | contact_at | derived_from | supersedes | references
  -- `references` + `attr_slug` materialize a record-reference attribute into the
  -- graph (added 2026-07-30 with the attribute engine, migration 0005); the edge
  -- is unique on (from, to, relation, attr_slug), and attr_slug is '' elsewhere.
  -- See "Record-references materialize into the graph".
```

Real FKs on both sides. Typing `[[Orbital Composites]]` in a note materializes a `link` row —
backlinks fall out for free.

Core kinds are fixed in code. **Amended 2026-09-02:** user-created custom
objects exist as a second tier — attribute-bag records inside the same entity
graph (see "Two-tier object model" below), sharing `kind = 'custom'` and
differentiated by `object_id`. ~~They never grow identity, merge, or
enrichment machinery~~ — **narrowed 2026-09-13:** fuzzy-name dedupe and
merge-as-target now cover every object, and a custom object may opt into
`domain`/`linkedin` identity keys at creation; enrichment, interactions and
seeded attributes stay core-only (_Two-tier object model_ ·
`docs/spec-attribute-engine.md` §9). The opinionated core stays code-owned.

Rejected: nullable-FK-per-type (N columns and N joins per attach point), and untyped
`(src_type, src_id)` (no referential integrity, every query hand-checks).

**Note the reinterpretation:** `document.entity_id` is now the document's _own_ identity, not
the company it belongs to. Attachment goes through `link`. Same for `note`.

### Filed vs referenced (decided 2026-07)

Two ways a thing ends up "in" something else, and they must not be conflated — one is an act,
the other is a side effect of writing.

|                            | meaning                                        | mechanism                             |
| -------------------------- | ---------------------------------------------- | ------------------------------------- |
| **Filed in a space**       | you deliberately put it there                  | `entity_space`                        |
| **Filed against a record** | a document belongs to this company/person/deal | `link(tagged_in)`                     |
| **Referenced**             | the body happens to mention it                 | `link(mentions)`, diff-synced on save |

**Space membership goes through `entity_space` for every kind, not just companies** — notes,
documents, and people file the same way a company is tagged. `link` cannot express what that
table already carries: `source: manual|ai|inherited` and `confidence`, which is what lets AI
suggestions land in a review queue instead of being silently written. Routing notes through
`link(tagged_in)` instead would forfeit that and make "what is in this space" a two-table
question forever.

**There is no singular memo.** A space holds as many filed notes as the user wants; the memo
is simply the first one filed, and `note.kind = 'memo'` is presentation (serif at the same measure as every prose surface — DESIGN.md §layout —
PDF export later), never structure. Spaces are how a user imposes hierarchy on their own
research — constraining that to one document per space is the tool telling the investor how
to think.

### The note model (settled 2026-09-14)

One table, one editor, one body substrate. Three orthogonal axes, three
mechanisms, never mixed:

| axis                 | mechanism                                                                                        | values                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **where** it's filed | `entity_space` (space) · `link(tagged_in → record)` (company / person / deal / custom / mandate) | zero or more places                     |
| **what** genre       | `note.kind`                                                                                      | `memo · note · scratch` — three, frozen |
| **who** can read     | `note.visibility` + `author_id`                                                                  | `shared` (default) · `private`          |

- **A memo is a note with the flag up.** Same row, same edges; the kind is
  presentation (serif, pins to the top of wherever it is filed, is the face
  of a space) and intent ("this is my view"), never structure. The measure is
  not one of those differences: `DESIGN.md` §The Page Shell puts a memo at the
  same `max-w-160` gutter as every other prose surface, and it is the later
  document. Promote by flipping the kind. Kind never restricts filing targets
  — an IC memo is a memo filed against a deal; a market memo is a memo filed
  into a space.
- **Kinds stay at three; genres are templates.** "Teardown", "post-mortem",
  "IC memo" are note templates that set title/structure/kind, not new kinds.
  A fourth kind is a taxonomy leaking into structure (the sectors rule). Tags
  encoding _where_ a note lives are rejected outright — filing already says
  which company, a tag cannot.
- **Gap found in code (to fix):** "Note about this" on a record writes only a
  `mentions` link, so notes are _referenced_ to records, never _filed_; memo
  is creatable only from a space page; the editor has no kind toggle. Fix:
  record "Note about this" writes `link(tagged_in)` (plus the starter
  mention), a `Note · Memo · Scratch` toggle in the editor header, "Filed
  against" chips next to "Filed in space", and record Notes sections read
  `tagged_in` first ("Filed here · Mentions this"), memo pinned.
- **Deletion is hard, and there is no trash (decided 2026-09-19, SPA-125).** A note
  is text a human typed, which is the argument for a soft delete — and it loses. The
  product hard-deletes documents and terms and has no trash anywhere; one kind with a
  recoverable state would be a second deletion model to explain, and "deleted" would
  stop meaning the same thing on two pages of the same app. The real cost is the
  merge-snapshot one: an unmerge that would repoint a link out of the note degrades to
  a silent no-op once the note is gone. That cost is already paid — it is exactly the
  documents story today, and there is no unmerge executor at all; the snapshot
  convention is the only contract (CLAUDE.md). A slice that builds one inherits the
  same question for every kind at once, which is where it belongs, not here.
  Mechanically: `deleteNote` runs the registry executor, so the `note` row, the
  `entity` row, every `link` in both directions, `entity_space` and `activity` go, and
  what the note fed survives — a document `derived_from → note` keeps its blob, its
  `extracted_text` and its `tsv` and loses only the edge. The mandate's note refuses by
  name (`mandate.note` is `block`), and a private note someone else wrote answers
  "Note not found" rather than confirming it exists.
- **Meeting notes are notes:** `interaction.note_id → note` (see
  _Interactions_). Documents are not notes (see _Sources are documents_).
- The deal memo is optional and scales `close_reason` → note → memo, same
  row promoted; the roadmap's memo-draft / pre-mortem / pass-letter features
  land as memos filed against the deal.

### Per-kind side tables

```
company(entity_id)   -- kind markers only. Attribute values live in
person(entity_id)    -- entity.values; identity (domain/cin/emails/linkedin)
                     -- lives in entity_alias. Corrected 2026-09-15 — the old
                     -- sketch listed domain/cin/sector[]/emails/linkedin here,
                     -- against "Unified storage" + "Hard exclusions" (2026-07)
                     -- and against "Spaces vs attributes": there is no sector
                     -- field anywhere, ever.
space(entity_id, parent_id, slug, path, is_seeded)   -- name is entity.canonical_name
note(entity_id, title, body_json, body_md, tsv, kind: note|memo|scratch,
     author_id, visibility, updated_at)   -- body_json authoritative (2026-07)
document(entity_id, blob_sha, filename, mime, url, size_bytes,
         kind: deck|dd|cap_table|legal|article|other,
         source_class, source_ref → integration,
         extracted_text, tsv, extraction_status, extraction_error,
         extracted_at, uploaded_by)
  -- Corrected 2026-09-15. The shipped enum carries `other`; the 2026-09-14/15
  -- documents decision drops `memo` (six values remain — an exported memo PDF is
  -- `derived_from → note`) and collapses `origin` into `source_class + source_ref`
  -- with the other vendor enums, adding source_path / external_id / external_url /
  -- external_status / connection_id. The collapse landed 2026-09-19 (SPA-137,
  -- migration 0030): `upload`/`url`/`clip` → manual, `gmail_attachment` →
  -- integration + a ref once a connector exists, and `document_origin` is
  -- dropped. `memo` is still present in code. `interaction.source` went the same
  -- way in the same migration, so no shared enum in public.* names a vendor. See
  -- "Sources are documents" below and `docs/spec-storage-sources.md` §2, §11.
document_chunk(document_id, idx, text, embedding vector)
term(entity_id, name, aliases[], definition_md, space_id)
```

### Thesis — removed (2026-08)

The thesis object (phase 7: falsifiable claim, conviction, status, evidence for/against)
was **removed by owner decision**: a separate tab and separate storage were judged
inconsequential — the mandate is the strategy surface, and what a thesis captured is
prose, which a note filed in a space already carries. Removed, not deferred: the
`thesis`/`thesis_space` tables, the `thesis` entity kind, and the
`evidence_for`/`evidence_against` link relations are dropped (migration 0010), the
routes and space-page claims section deleted. Costs accepted knowingly: structured
evidence tallies and the kill-requires-a-reason machinery are gone; disconfirmation now
lives in prose, not in a queryable edge.

**Space remains taxonomy** — Aerospace → In-space manufacturing, hierarchical, shared
vocabulary, effectively never deleted. Market _claims_ now live as notes filed in the
space they are about.

### Mandate — the fund's strategy (decided 2026-08)

The **mandate** is the fund's _prescriptive_ strategy — deep-tech, pre-seed to seed,
India, check size, portfolio construction — what an LP reads in the deck. It evolves per
vintage rather than being disproven, and it is a filter over deal flow, not a claim
about a market.

```
mandate(id, status: active|archived, note_entity_id → note,
        stages text[], geos text[], check_min, check_max, currency)
```

- **The prose body is a real note** (`kind: memo`) — search, `[[mentions]]` of spaces
  and companies, and future AI-screening input all come free. No new entity kind.
- **Structured columns, deliberately few.** `stages` shares the company `funding_stage`
  option vocabulary; `geos` are free tags; check range. Typed columns, _not_ the
  attribute engine — one row, a registry buys nothing.
- **Portfolio construction stays prose.** Nothing consumes "25 checks, 20% follow-on
  reserve" as data; promote only when a feature (reserve tracking, pacing) demands it.
- v1 structured fields mostly display. One real consumer: a soft **"outside mandate"
  hint** where `company.funding_stage ∉ mandate.stages` — a hint, never a block; edge
  cases are the job. Geo cannot power this while `location` is free text.
- One active mandate per workspace; `archived` covers vintages. No versioning machinery.
- **Nav: one Mandate page, first in the sidebar** (decided 2026-08) — the fund's identity
  tops the nav, but login still lands on `/spaces`, where daily work happens. Structured
  facts rail + prose strategy; the single "why we invest" destination.
- **The outside-mandate hint renders on the deal record only** (decided 2026-08): one
  quiet badge near the company reference, where the invest/pass judgment happens. Not in
  tables — a hint sprinkled across rows becomes noise people learn to ignore.

### Space membership is orthogonal to pipeline membership

```
entity_space(entity_id, space_id, source: manual|ai|inherited, confidence, created_by)
```

A company is tagged Aerospace whether or not it sits in any pipeline. **Tags outlive pipelines** —
route them through `list_entry` and the tag dies when the deal dies. A company may sit in a
space and no pipeline at all: _tracking, not evaluating._ That is a first-class state.

AI-suggested tags land as `source: ai` in a review queue, never silently written. Same
provenance rule as enrichment.

### Spaces vs attributes — the classification boundary (decided 2026-07)

Two dimensions that must never share a field. **The litmus test is the rule, not a hint:**

- **Space — could I write a memo about it and track companies in it?** _Where_ a company
  competes **and _how_ it competes.** Hierarchical, researchable. **Spaces own this
  exclusively** — industry/sector never becomes an attribute. The companies table shows a
  graph-backed Spaces column, not a sectors field.
- **Attribute — is it a property of the business itself, true in any market?** B2B/B2C,
  hardware, capital intensity, GTM motion. Orthogonal facets. Flat, filterable, no research
  attached.

**Amended 2026-07:** the rule used to read _"markets are **where** a company operates"_,
which put competing approaches (Data centers → Cooling → Immersion) on the wrong side. You
would absolutely write a memo on immersion cooling and track companies in it, so it is a
space. The _where_ framing also failed its own test — approaches cut across markets, since
immersion cooling is EV packs and mining rigs too.

**That cross-cutting is handled by tagging, not by the tree.** The hierarchy decides where a
memo _files_; it does not decide what a company _is_. `entity_space` is many-to-many, so a
company doing immersion for data centers and for EV packs is tagged into both nodes — no
duplication, no forced choice, no polyhierarchy. PitchBook needs a second classification
system (flat "verticals" over hierarchical "industries") to express this; one object plus
many-to-many membership covers it here.

Seeded facet: one system multi-select on Company — `Business model`
(B2B · B2C · B2B2C · Marketplace · Hardware · Deep tech · Services), options editable.
No "sectors"/"categories" attribute ships, ever — that's the drift vector Attio's
Categories demonstrates.

**Extensibility doctrine: structure fixed, content free, defaults curated.** Object kinds,
the attribute type menu, identity rules, and the engine's shape are code. The space tree,
custom attributes, and every seeded attribute's options are the user's vocabulary. The
litmus test lives in docs and seed data as guidance — never enforced by validation.

### Seed taxonomy — deliberately tiny (reversed 2026-07)

**Ship a handful of example nodes, not a curated ontology.** The earlier plan was ~150–250
versioned nodes; that was wrong, for the reason the whole feature exists: the tree is the
investor's own vocabulary, and a shipped ontology quietly pre-empts it. NAICS/SIC stay
rejected — useless for deeptech and tech.

What the small seed buys, beyond flexibility:

- **No reconciliation machinery.** `is_seeded` was reserved so upgrades could add nodes
  without stomping user edits — which needs a stable per-node seed key, because slugs and
  names change under the user's hands. With a handful of nodes there is nothing to
  reconcile. The flag stays as provenance; the machinery never gets built.
- **Depth is earned.** Nobody creates _Immersion cooling_ until they have companies and a
  memo to put in it. A node that exists before its research is a filing decision made by
  the wrong person, and it makes every space picker worse — the tag-into-space control
  lists every space in the tree.

First boot is answered by the **demo seed**, not the taxonomy: opt-in at setup, populated,
and explicitly sample data. An empty spaces page teaches; a fake ontology misleads.

Users fork and extend freely; custom nodes sit alongside seeded ones with no second-class
treatment.

### Glossary

Scoped to a space — "stage" means different things in aerospace and bio. Terms auto-link in any
note body (Aho-Corasick over the term set at render time), hover shows the definition. Cheap to
build, disproportionate payoff for someone learning a new space.

**Concept node (decided 2026-09-14, build with the AI substrate).** Today a
term is a tooltip: auto-links are decorations, the graph never learns that
PUE was mentioned. Upgrade: the same matcher runs server-side on note save
(over `body_md`) and on the worker after document extraction, diff-syncing
`link(note|document → term, mentions, source: extracted)` — a deliberate
`[[PUE]]` stays `source: manual` and ranks higher. Terms get a page
(definition · space · every note/deck that mentions it, with `ts_headline`
snippets · companies reached through them · co-mentioned terms). Concept
becomes the third way into the graph after space (curation) and record.
**A concept never holds things:** no memo, no filing, no "track companies"
affordance — the moment it can, it is a space with worse hierarchy. The
litmus stays: could I write a memo about it and track companies in it →
space; is it a word I want defined and traced → term. A concept can be
promoted to a subspace when its mentions rail says so; the term stays as
vocabulary underneath. Never the reverse. Uses: reading cold, the standing
glossary slice in the assembler, and `get_context(term)` seeds for
"compare every deck on stack lifetime".

### Deal — a first-class object (decided 2026-07, reversing lists-first)

**One Deal = one investment opportunity (round or instrument) in one company.** Many deals
per company over time — the 2024 pre-lead you passed on and the 2026 Series A are two
records, each keeping its own arrival context, stage history, and pass reasoning. That
history is the institutional memory an angel pays for.

**Three-state model** (validated against a real fund's funnel data — 331 pre-leads,
1,164 rejected, 2 term sheets):

1. **Watching — no Deal exists.** Company tagged into spaces. "Tracking, not evaluating."
   Never a pipeline stage — cramming watching into the funnel is the workaround tools
   without a research layer are forced into.
2. **Pre-lead — Deal exists, judgment hasn't happened.** Born when something arrives
   (deck, intro, founder email). High-volume triage bucket; most deals die here.
3. **Funnel proper** through to a terminal state.

**Default stage set** (status attribute; options editable, each option carries a group):

- Funnel (`active`): Pre-lead → Screening → Meeting → Diligence → Term sheet
- Parked (`parked`): Early — revisit _(nurture pool: "come back at seed"; not terminal,
  not active — without it people abuse Rejected and lose warm relationships)_
- Terminal (`closed`): Invested · Passed (our no) · Lost (their no / missed allocation —
  a different post-mortem lesson than Passed)

Terminal deals close, never delete — death is information.

Deal system attributes: stage (status), value (currency), company (record-reference),
people (record-reference), owner (actor-reference), close date. Custom attributes via the
attribute engine like every object.

### Attribute engine (decided 2026-07)

The object model: **Companies, People, Deals** are objects with an attribute registry —
system attributes we ship, custom attributes users add. Notes, spaces, terms are
deliberately _not_ object-modeled; they're the research layer that links in.

```
attribute(id, object_id → object, slug, name, description, type,
          options jsonb, is_system, archived, sort_order,
          created_by, created_at)
```

_Rekeyed 2026-09-02, shipped in migrations 0016/0017: the `object_kind` enum
became a single `object_id` FK to the `object` registry — no dual keying, no
enum branch in any registry read. `description` landed 2026-09 (migration
0020). See "Two-tier object model" below and `docs/spec-attribute-engine.md`
§9._

- **Unified storage:** all attribute values — system and custom — live in `entity.values`
  jsonb, keyed by slug. One write path, one validator (zod per type at write time), one
  renderer, one indexing story. No column-vs-jsonb branching anywhere.
- **Hard exclusions, never attributes:** `kind`, `canonical_name`, `merged_into_id`, and
  all identity (domains/emails/linkedin/cin live in `entity_alias` under resolution rules).
  The opinionated core stays code-owned; attributes are display/filter/sort data.
- **Type menu is fixed** (users define attributes, never types): text, number, currency,
  date, checkbox, select, multi-select, status (options carry a group:
  active/parked/closed), domain, email, url, phone, rating, **record-reference**,
  **actor-reference**.
- System attributes are `is_system`, non-deletable, archivable-not-removable; a custom
  attribute that proves universal gets promoted to system in a release, not by users.
- Indexing: expression indexes minted per attribute when tables need them; GIN + measured
  seq scans until then. Fine at 1–15 users.
- The registry generates the UI: table columns, create-modal fields, record-page detail
  rails all read the registry. Attio's structure, self-hosted.
- **Expansion path (decided 2026-08): the attribute engine grows, objects don't.** The
  type menu widens by release — attribute _descriptions_ first (human docs now, prompt
  context for AI later), then timestamp, then structured location (needs a migration
  story off free-text), formula deliberately deferred (an expression engine; most
  domain formulas are better as system-computed columns). The headline is the
  **AI-autofill attribute family** (classify / summarize / prompt-completion), landing
  with the BYOK AI phase — fed by the research graph (notes, extracted decks, the
  mandate), which is context Attio's version cannot see, and governed by the existing
  provenance doctrine: AI-written values are suggestions, never silent overwrites.
  ~~Custom objects stay a non-goal~~ — reversed, see "Two-tier object model"
  (2026-09-02); a custom object that proves universal still ships as a system
  release (promotion path unchanged).
- **Two-tier object model (decided 2026-09-02, reversing the custom-object
  non-goal).** Users can create custom objects — but strictly as
  **attribute bags**: an `object` registry row (slug, singular/plural nouns),
  records as entities carrying `object_id`, the full attribute engine, record
  references both directions, registry-generated routes. What they get free
  from the polymorphic core: spaces tagging, mentions/backlinks, notes,
  search, activity. ~~What they are **permanently excluded from** (the
  narrowed non-goal): alias resolution, dedupe, merge (as merge _targets_),
  enrichment, interactions, seeded attributes.~~ **Narrowed 2026-09-13:**
  fuzzy-name dedupe and merge-as-target now cover every object (both were
  kind-agnostic in code; the exclusion was a set membership), and a custom
  object may opt into `domain`/`linkedin` identity keys at creation.
  Enrichment, interactions, and seeded attributes stay excluded. Driver:
  the owner's rule that the product never forces its taxonomy — no fourth
  system object for funds/investors; the `organization` ghost kind is **to be
  deleted outright** (no records, no registry) — _not done as of 2026-09-15:
  the enum value, `MERGEABLE`, `resolveEntity`, search, and the demo seed's
  round co-investors all still use it; roadmap slice `clean-1` removes it_ —
  and a user models co-investors
  as Companies with a `type` or as a custom object, their call — which only
  holds if the custom route dedupes. Attio's customs keep the old
  exclusions; ours no longer match them here. Full spec:
  `docs/spec-attribute-engine.md` §9.
  - **Identity keys are materialized, not bound later (decided 2026-09-19,
    SPA-85).** Declaring `domain` or `linkedin` at object creation creates
    the backing attribute in the same transaction — slug `domain` type
    `domain`, slug `linkedin` type `url`, `is_system: false`, carrying
    `options.identityKey`. A custom object is born with zero registry rows,
    so a key with nothing behind it would be a promise the write path cannot
    find: the declaration and the attribute are one write or neither. The
    attribute goes in through `createAttributeProgram` — the same door that
    rejects config a type cannot carry — never a raw insert, and it cannot
    be archived while the key stands.
  - **A materialized backing attribute is not a seeded attribute (decided
    2026-09-19, SPA-85).** "Seeded attributes stay core-only" is about the
    `SYSTEM_ATTRIBUTES` rows the registry inserts on boot, unasked, on every
    object of a kind. A backing attribute exists because the user declared
    the key, through the same door any attribute enters by, and is
    `is_system: false` — an ordinary custom attribute that happens to be
    spoken for. It gets no `SYSTEM_ATTRIBUTES` entry and is excluded from
    nothing.
  - **Clearing the value releases the claim (decided 2026-09-19, SPA-85;
    objects-7's contract).** When a declared-key write routes through
    `addIdentityAlias`, clearing the attribute retires that identity alias,
    so the domain is free for another record to claim. This is the split
    that makes the alias table legible: **name aliases are history and never
    retire** (what a record was once called stays searchable); **identity
    aliases are claims and do** (a domain nobody asserts is nobody's).
  - **The write path, built 2026-09-19 (SPA-95, objects-7).** `setValues` is
    where the declaration becomes a claim: an attribute carrying
    `options.identityKey` mirrors its value into `entity_alias` through
    `claimIdentityAlias`, in the transaction that wrote the value and its
    `attribute_event` (`apps/web/src/lib/entities/resolve.ts`). Four things
    the build settled. **The alias insert sits in a savepoint** — a
    concurrent writer's `23505` rolls back the nested transaction alone and
    becomes a `duplicate_candidate`, never a lost value write. **The value
    always lands, only the claim is withheld** from the loser of the race:
    `values.domain` is the user's field, the alias is the assertion about
    the world. **`valueValidator` bites**: on an attribute carrying the flag
    a value that normalizes to null is refused ("gmail.com never identifies
    a record"), because storing one would be a field that silently claims
    nothing; a plain `domain`-typed attribute keeps the permissive rule.
    And **a change of value retires the old claim before asserting the new
    one**, which is the clear above generalized. The per-slug outcome
    (`added` · `already_own` · `suggested_duplicate` · `released`) is
    decided inside the transaction and returned from `setValuesEffect`;
    objects-8 surfaces it.
- **Machine-write design for the integrations phase (decided 2026-08-08; design
  only, nothing built).** The dividing line is the kind of claim, not the vendor:
  **a sourced fact may fill an empty field; anything generated, or anything
  conflicting with what a human wrote, waits for a human.**
  - _Deterministic facts_ (Apollo-class lookups: employee count, HQ, founded
    year, LinkedIn — externally checkable, receipt stored): **direct write,
    fill-blanks only**, through setValues so attribute_event logs it with the
    stored `enrichment_record` raw response as provenance anchor; per-field
    history makes every write revertable. A conflict with an existing value —
    especially a human edit — is never silent: it becomes an "Apollo says X,
    you have Y — accept?" prompt. Identity keys (domain/linkedin) never touch
    values: they enter as aliases via resolveEntity, where collisions become
    duplicate_candidates (Apollo's real failure mode — wrong company match —
    lands in the dedupe inbox by construction).
  - _Generated judgment_ (AI classify/summarize/prompt): fully gated through a
    **`suggestion` table** — (entity, attr_slug, value, source ai|apollo|gmail,
    confidence, provenance jsonb, status open|accepted|dismissed). Chips on the
    record rail + a review inbox (the twice-flagged missing baseline; this is
    its first build driver). Accept writes via setValues with the _accepter_
    as actor; dismissed persists forever (the duplicate_candidate lesson).
    This keeps the "suggestions never silent" doctrine intact — it was always
    aimed at generative judgment, and the review burden stays proportional
    (nobody clicks accept on employee_count fifty times; everyone approves a
    model's sector classification before it drives filters).
  - _AI-enhanceable types_: text, select, multi_select, number. Excluded:
    status (the funnel is judgment — AI never touches stage), currency (money
    assertions), references/actors (identity is resolveEntity's job),
    domain/email/phone (aliases). Registry carries per-attribute config —
    `ai: { mode: summarize|classify|prompt, prompt?, context: [...] }`.
  - _Trigger_: manual only (per cell / per column) — Attio independently
    converged here. _Context assembly_ (the differentiator): attributes +
    linked memos + extracted deck text + mandate, with one hard rule — the
    context builder routes through canRead; **a private note never leaks into
    a prompt whose suggestion a teammate reads**.
  - _Gmail later, same rule_: participants → deterministic aliases;
    content-derived facts → suggestions.
  - _Sourcing gap noted_: deal `source` covers the channel; a `referred_by`
    record-reference (person) is the missing who — add with the substrate.
  - _Build order_: ① suggestion table + review surface + referred_by →
    ② BYOK AI autofill (keys/vault already shipped) → ③ Apollo →
    ④ Google Workspace (design already recorded in the Gmail block).
- **Attio surveyed on the two deferred/settled types (2026-08-04).** _Formula_: an
  expression language — operators (`+`, `==`, `??`), functions (`if()`, `dateAdd()`),
  `{Attribute}` references with editor autocomplete; output type inferred from the
  expression (number-returning formula becomes a number attribute); nulls explicit
  (any null input → null, `??` for fallback); reactive recompute on dependency change
  within seconds, except `now()`/`today()` formulas which recompute once daily at
  midnight UTC; formulas compose (may reference other formulas); natural-language →
  AI-generated formula that stays inspectable text. Their differentiator: **attribute-
  history functions** (`timeSpentIn`, `hasBeenIn`, `valueAt`, `previousValue`,
  `valueSetAt`) — formulas read the change log, not just current values. Two takeaways:
  (1) our `attribute_event` log means history functions would be nearly free if formula
  ever lands — the most differentiated piece is the one we're already positioned for;
  (2) the deferral holds — the real cost is an interpreter + dependency-graph reactive
  invalidation + type inference, and phase 15's metrics are cross-event aggregates
  (derived-metric kit), not per-record scalar formulas — different layer. _Currency_:
  strictly per-attribute — `default_currency_code` (ISO 4217) fixed in attribute
  config, never overridable per record; value is a bare number (4 dp precision) with
  the code echoed back; `display_type` renders via `Intl.NumberFormat`; no conversion
  anywhere. So Attio "currency" is number formatting, not multi-currency — our
  registry's currency type (per-attribute `options.code`, bare number) already matches
  it, and real multi-currency correctly lives in the phase-15 event tables (per-event
  currency + base-currency roll-up), not the attribute layer. _AI attributes_ (their
  shipped version of our AI-autofill family): an "AI autofill" toggle on custom
  attributes of type text/number/currency/select/multi-select, four modes — Summarize
  Record, Classify Record (select options, optionally AI-inventable), Prompt Completion
  (custom prompt over designated attribute variables), and a Web Agent (live external
  research, text/number/currency only, green/yellow/red confidence indicator). Three
  facts worth keeping: (1) **never auto-computed** — user triggers per cell, bulk
  selection, or column header; even Attio doesn't let AI write on its own schedule,
  which lands on the same side as our suggestion-never-silent doctrine; (2) **context
  is attribute values only — their AI cannot read notes or emails**, which is exactly
  the gap our research-graph-fed version exploits (memos, extracted decks, mandate as
  prompt context); (3) metered credits (web agent 10/record, others 1) — a hosted-
  margin constraint BYOK sidesteps entirely. Their Web Agent maps to our
  enrichment lane (Apollo/Exa), not autofill; the confidence indicator is a UI idea
  worth stealing when enrichment lands.
- **Record-references materialize into the graph:** the uuid in `values` is source of
  truth; every reference write syncs a `link` row (`relation: references`, `attr_slug`)
  in the same transaction — the note-mentions pattern. Backlinks, "related" rails, and
  the merge executor's referrer lookup all stay on the one graph; merge rewrites both.
- `deal.company` is **required and single** — a deal without a company doesn't exist in
  this domain. `deal.people` is optional and multi.

### Seeded system attributes (decided 2026-07)

- **Company:** description (text) · business_model (multi-select) · funding_stage (select:
  Pre-seed → Public/Bootstrapped) · location (text) · founded_year (number) · linkedin (url).
  Website is the domain alias rendered, never an attribute.
- **Person:** job_title (text) · description · location · linkedin (url) · twitter (url) ·
  phone (phone). Emails are identity aliases, not attributes.
- **Deal:** stage (status) · value (currency) · company (ref, required single) · people
  (ref, multi) · owner (actor) · close_date (date) · source (select: Inbound · Referral ·
  Outbound · Event) · close_reason (text — **added 2026-08-08** with the board, the
  Passed-vs-Lost post-mortem captured at close time; see phase 15b). `referred_by`
  (ref → person) is decided but unbuilt — _Machine-write design_, build order ①.
- Enrichment-fed fields (employee range, ARR, funding raised) deliberately absent — empty
  boxes without a provider; they arrive with the enrichment integration as
  provenance-tracked attributes.

### Attribute change history (decided 2026-07)

```
attribute_event(id, entity_id, attr_slug, from jsonb, to jsonb,
                actor_type: user|integration|system, actor_id, source: direct|
                default|suggestion|enrichment|import|merge|seed,
                suggestion_id, refs jsonb, at)
  -- typed actor + door + citation refs shipped 2026-09 (migration 0018,
  -- `docs/spec-attribute-engine.md` §4): actor_type is NOT NULL and actor_id
  -- is set iff actor_type = 'user' (check constraint).
```

One row per attribute change, same transaction as the value write. Restores what
`list_entry_event` provided: deal stage history is `attr_slug = 'stage'`; time-in-stage
analytics fall out free. `activity` carries macro verbs only (created, merged, tagged,
note-created) — no "updated" noise rows. **Condensing is read-time display:** group
events by actor + record within a ~10-minute burst → "changed 8 attributes", expandable
to the attr/value table. No write-side session tracking.

### Lists — deferred

~~The Attio list/entry primitive (`list`, `list_attribute`, `list_entry`, `list_entry_event`)
stays in the schema but is **not the deal mechanism** and is deferred from MVP. If
watchlists/portfolio views later need membership-with-context, lists are there~~ —
**superseded 2026-09-11: the tables are gone.** `list_attribute` and `list_entry_event`
were dropped 2026-09-09 (migration 0021), `list` and `list_entry` 2026-09-11 (migration
0023), once `view` shipped (`src/db/schema/views.ts`). Deals never waited on a list
engine, and kanban falls out of the Deal stage attribute. The heading stays for the
pointers into it; read the decision below, not the paragraph above.

**Lists are views; records are unique (decided 2026-09-07).** This closes the
membership-vs-instance question the Attio study left open. Attio entries are
_instances_ — the same record can sit in one list twice with independent
stages, and an entry carries its own attribute values. We reject both halves:

- A record is one row per real-world thing, kept unique by `resolveEntity` and
  the dedupe inbox. Nothing — a list included — may create a second row for the
  same thing. (A view holds no membership rows at all, so the question is moot:
  `list_entry` was dropped 2026-09-11, migration 0023.)
- A list is a **view**: a saved filter over one object's records with its own
  columns, sort, and grouping. It holds no values. Membership is a fact, once.
- Anything worth saying about a record is an attribute **on the record**
  ("priority for Fund II" is a select on Company, shown in the Fund II view),
  where history, provenance, and the AI assembler can see it. There is no
  second value store. `list_attribute` and `list_entry_event` were therefore
  dead weight — **both were dropped 2026-09-09** (migration 0021), and `list` /
  `list_entry` followed on 2026-09-11 (migration 0023).
- Pipelines stay objects: a deal is a record; a second pipeline is a second
  object with its own status attribute, and the board generalizes to any
  status attribute rather than to entries.

What "lists" then need to become is a **views** design — saved filters plus
column layout per object, shared or private — which is cheaper than an entry
engine and covers the watchlist case.

### Templates (decided 2026-08)

One mechanism, three kinds — standardized _capture_, never automation.

```
template(id, kind: note|space|record, object_kind,   -- object_kind only when kind=record
         name, body jsonb, suggest_on entity_kind[],
         created_by, archived, sort_order)
```

- **note** — a stored BlockNote document; instantiate = copy into a new note. Meeting
  note, call debrief, diligence checklist, IC memo skeleton.
- **space** — a scaffold manifest `{memo_body?, glossary_terms[], subspaces[]}` (nested,
  names + skeletons only, never content), applied once at space creation. **Created by
  example, not by form** (decided 2026-08): "save this space as a template" captures the
  existing subtree — the investor builds their market breakdown once by hand, saves it,
  stamps it onto the next market. No scaffold-builder UI ever gets written.
- **record** — `{values}` keyed by `attr_slug` for one object kind. **Pre-fills the
  create modal, visibly and editably — never silently writes.** Unknown/archived slugs
  are skipped at instantiation; option renames already preserve ids, so templates
  survive vocabulary edits.

Doctrine:

- **User-created, workspace-shared; we ship none.** A shipped template pre-empts the
  user's vocabulary — the same reasoning that killed the big seed taxonomy. The demo
  seed may carry examples, opt-in like the rest of it.
- **Instantiation is copy, not reference.** Editing a template never rewrites existing
  notes or spaces; divergence after stamping is the point.
- **Templates are config, not entities.** No mentions, no search hits, no graph rows.
  Managed in settings, plus "save this note as a template" in place.
- **Application is manual plus a context hint.** The picker is scoped by `suggest_on` —
  a deal page surfaces deal-tagged templates first. Ordering, not automation; nothing
  auto-creates. Contextual _defaults_ (new deal auto-creates a checklist) were
  considered and rejected as the first step toward workflow-config sprawl.

### Interactions and enrichment

```
interaction(id, kind: email|meeting|call, message_id, thread_id, occurred_at,
            source_class, source_ref → integration)
  -- `interaction_source` named five lanes in the type itself (email_sync,
  -- forwarding, calendar, recorder, whatsapp); collapsed 2026-09-19 (SPA-137,
  -- migration 0030) into the same class+ref pair every other provenance column
  -- carries. Which product a meeting came from is the integration row, not a
  -- word a third-party plugin would have to ALTER a shared enum to add.
interaction_entity(interaction_id, entity_id)       -- relationship graph edge table
signal(entity_id, source, payload jsonb, observed_at)
enrichment_record(entity_id, provider, raw jsonb, fetched_at, credits_used)
```

**`interaction.note_id → note` (decided 2026-09-14).** The interaction is
the structured event (kind, occurred_at, attendees via `interaction_entity`,
source, linked records); its body is a real note row filed against the same
records. One editor, one mention system, one search index: mentions in
meeting notes create links, glossary highlights, concept links, PDF export
all apply. Call recorders (Fathom / tl;dv / Granola) write the transcript as
a `document(derived_from → interaction)` and the summary as a suggestion
that becomes the note body. (Checked 2026-09-15: `interaction` carries
`subject` and no body column at all, so the unification is an additive
`note_id` column, not a migration off an existing body.) `close_reason` stays an
attribute.

Relationship intelligence = query over `interaction_entity` weighted by recency + frequency.
"Who knows someone at X" falls out of it. Computed live — at two mailboxes over three years
this is ~200k rows, well inside live-query range. No graph DB, no materialized view until
measured.

### Activity

```
activity(id, actor_id, verb, subject_entity_id, object_entity_id, meta jsonb, at)
```

One denormalized table written by every producer: stage change, note added, document filed,
email synced, evidence attached, tag applied. Timeline reads dominate writes — do not UNION
five tables at query time. `attribute_event` is the typed attribute-change log that feeds
stage analytics (`list_entry_event` was dropped 2026-09-09 with the entry-owned value store —
see "Lists — deferred").

### Entity resolution & merge

**Doctrine: deterministic auto, probabilistic suggest.** Identity comes only from
deterministic keys — domain, email, LinkedIn URL, CIN. Exact key match auto-attaches. Fuzzy
name match **suggests, never merges** — no threshold is safe ("Stripe" payments vs "Stripe"
design agency corrupts silently). Fuzzy feeds a dedupe inbox; a human clicks.

```
entity(id, kind, canonical_name, merged_into_id → entity,
       source_class, source_ref → integration, created_by, created_at)

entity_alias(id, entity_id, kind: name|domain|email|linkedin|cin,
             value, value_norm, is_identity bool,
             source_class, source_ref → integration)
  -- UNIQUE partial index on (kind, value_norm) WHERE is_identity
  -- name aliases: never identity, never unique
  -- source_class: the eight classes (see Plugin architecture); the ref is
  -- set iff the class is 'integration', on the entity AND on every alias,
  -- so a plugin cannot write an unattributed identity key

duplicate_candidate(id, entity_a, entity_b, score, reason jsonb,
                    status: open|merged|dismissed, resolved_by, resolved_at)
  -- dismissed persists forever: "not a duplicate" is a negative assertion,
  -- or the nightly sweep re-suggests the same pair eternally

merge_event(id, winner_id, loser_id, merged_by, merged_at, snapshot jsonb, unmerged_at)
```

**Normalization:**

- Domain → registrable domain (eTLD+1, public suffix list), lowercase, strip www.
  **Free-mail domains never create or match a company** — founder@gmail.com is a person
  signal only.
- Email → lowercase exact. Gmail-only dot/+tag stripping _for matching_; store original.
  Role prefixes (info@, hello@, team@, careers@) are never person-identity.
- Name → unaccent, lowercase, strip legal suffixes (Inc, Ltd, Pvt Ltd, LLC, GmbH, SAS…).
  Feeds `pg_trgm` only.

**One choke point.** `resolveEntity({kind, keys, name?, source: {class, ref?}})` — every creator goes
through it: manual create, deck upload, `[[mention]]`, URL clip, Apollo, Gmail, future CSV
import. Same pattern as `canRead()`. Exact identity-key match → alias match → create.
Fuzzy runs after, emits `duplicate_candidate` rows only.

**The organic dedupe engine:** writing an identity alias that collides with the unique
index (Apollo says company B owns a domain entity A already has) never errors — the
collision converts into a `duplicate_candidate` with `reason: {shared: 'domain', value}`.
Enrichment finds your duplicates as a side effect.

Escape hatch: two entities legitimately sharing a domain (parent/product, accelerator) →
flip `is_identity` off on one alias. Rare, manual, possible.

**Merge = repoint at write, resolve nothing at read.** Read-time resolution (following
`merged_into_id` in every query) infects every join in the app forever. Instead:

1. Loser's referencing rows repoint to winner — every entity-referencing column is
   declared in `ENTITY_REFS` (`src/db/entity-refs.ts`, shipped 2026-09-11) and the
   executor iterates it: link, entity_space, interaction_entity, task_entity,
   round_co_investor, the portfolio tables, … Every moved row is recorded in
   `merge_event.snapshot` as `{table, pk, old_value}`.
2. Loser's aliases move to winner (`source_class: merge`, `source_ref` cleared —
   the pair is one claim and a moved row cannot keep naming the integration
   that wrote it), identity flags intact.
3. Values (`entity.values` — side tables have carried no attribute columns since the
   2026-07 unified-storage decision): winner keeps its values, loser fills winner's
   nulls, conflicts stay with winner but land in snapshot. Same never-overwrite rule
   as enrichment.
4. ~~`list_entry` collision (both in same list): keep winner's entry, snapshot loser's
   values and entry events. One entry per (list, entity).~~ **Moot 2026-09-11** —
   `list` and `list_entry` were dropped (migration 0023); a view holds no membership
   rows, so there is nothing to collide. See _Lists — deferred_.
5. Loser row survives with `merged_into_id = winner` — stale URLs redirect. Chains flatten
   at write: merging B into C updates every `merged_into_id` pointing at B.
6. Duplicate `link` rows (same from/to/relation) dedupe on repoint.

**Unmerge** = clear `merged_into_id`, replay snapshot backwards. Documented limit: data
created _after_ the merge stays with winner — attribution is unknowable. Snapshot machinery
ships in v1 (cheap at merge time, impossible to retrofit); unmerge UI can land later.

Any member can merge — two-person fund, no ceremony. Every merge writes `activity` +
`merge_event`. Merge UI previews what moves before confirm.

**Deleting an entity a merge_event names is refused (decided 2026-09-19, SPA-77).**
`ENTITY_REFS` gained a third field, `del`, so the one registry answers the delete
executor too — `cascade` (the row dies with the entity), `block` (refuse, with the
reason the caller is shown), `orphan` (null the column, keep the row), `none` (safe by
a stated invariant). `merge_event.winner` and `merge_event.loser` are **`block`**:
named in merge history, and history is information — the same principle that makes the
portfolio ledger append-only (D12). The audit columns stay `NOT NULL`; nothing nulls a
merge out of its own record. Two neighbours decided with it: `entity.merged_into` is
`block` while any loser row still redirects at the entity (they would redirect at
nothing — an explicit delete-with-losers action is a later slice), and `mandate.note`
is `block`, because the mandate's prose is the mandate.

**Fuzzy sweep:** `pg_trgm` similarity over name aliases, at-create check + nightly sweep
job. Exact normalized-name collision outranks trigram score. Both only feed the inbox.

### Sources are documents

No separate `source` table for URLs. A saved article is a `document` with `origin: url`, fetched
and readability-extracted into the same `extracted_text` / `tsv` / `document_chunk` pipeline.
One search box covers decks, emails, notes, and saved articles together. Two tables means two
search indexes, and you will ship one and forget the other.

**The documents feature, distilled (2026-09-14/15) — the fund's object
storage, indexed by the graph instead of by path.** Full spec:
`docs/spec-storage-sources.md`. Decisions:

- Documents file exactly like notes: `link(tagged_in → record)` and —
  **now also** — `entity_space` into a space (doctrine said so, code only
  wrote `tagged_in`). A document filed into a space is a _source_; this
  closes the space-page "Sources section" open question. No visibility
  flag on documents (workspace-visible; a private document is a future
  decision, not a default).
- No folders, no nesting, no drag-to-folder. Kind + filed-against + space
  are the three axes a fund's folder tree encodes; views cover the rest. A
  document can be filed in N places (one blob, many edges).
- Surfaces to add: a `/documents` nav view on the record-table engine
  (kind · filed against · space · origin · extraction · date; saved views),
  a space Sources section, an **unfiled inbox** (arrivals with no edge,
  badge on Today), global upload with a file-against picker, drop-a-file
  into a note (files where the note is filed + inserts the mention), URL
  clip.
- `document.kind` stays a closed genre enum — seven values in the shipped
  schema, **six after this change** (`deck · dd · cap_table · legal ·
article · other`) — with code consumers
  (data-room subfolder mapping, per-kind extract schema); **`memo` is
  dropped** from it — an exported memo PDF is `derived_from → note`, the
  kind was a naming collision. `document.origin` collapses into
  `source_class + source_ref` with the other vendor enums; rows gain
  `source_path`, `external_id`, `external_url`, `external_status`,
  `connection_id`.
- **Storage source ≠ blob backend; they coexist by role.** Drive/Box are
  the fund's archive and collaboration surface and an arrival channel; our
  blob + derived layers (extracted text, chunks, vectors, page images,
  extraction cache, term links — all keyed by sha, all rebuildable) are the
  index and the AI working set. The AI only ever reads the derived layers,
  so bytes retention is per binding (`retain: full | text`) and the
  copy-in objection dissolves. Drive never answers "where do our bytes
  live"; that stays `STORAGE_DRIVER=local|s3` (locked, above).

### Investor-specific surfaces Attio does not have

- Space page: notes + sources + tracked companies + contacts + child spaces
- Mandate page: strategy prose + stage/geo/check-size facts
- Round history, valuation, check size, ownership %, dilution
- Cap table + portfolio marks
- Co-investor graph
- Deck as first-class object, auto-filed from mail, text-extracted, searchable

## Single user first, team ready

The UI is single-user. The schema is not. Every row that could ever be personal carries
`author_id` / `owner_id` / `visibility` from the first migration, even while nothing reads them.

- `visibility: shared | private`, **default shared**. Applies to `note` bodies and interaction
  bodies only. Notes private-by-default is the trap that keeps partner #2 writing in Apple Notes.
- No permission engine yet. One server-side choke point — `canRead(entity, user)` — returning
  true for everything except private-and-not-yours. Every read path goes through it from day one.
- **`canWrite(entity, user)` from day one too (decided 2026-08).** v1 ships admin/member
  only, but every mutation routes through the choke point, so a read-only viewer role
  (LP, intern, advisor) later is a one-line change instead of a write-path audit.
  Retrofitting a role _column_ is trivial; retrofitting _enforcement_ is not.
- **Explicit workspace singleton (decided 2026-08).** One enforced row — name, logo,
  settings — anchoring the mandate, `credential(scope: workspace)`, and sidebar identity,
  which otherwise reference a ghost. Hard rule: **no other table ever grows a
  `workspace_id` FK.** The moment one appears, the no-multi-tenancy decision is being
  relitigated by accident.
- **DIRECTION REVERSED (owner decision, 2026-08-15): multiple workspaces.** The
  singleton and its "no workspace_id FK" hard rule are rescinded — deliberately. No
  deployments exist yet, so the change is destructive-migration-friendly: the CHECK
  constraint and magic `id = 1` simply go away; no upgrade path owed.
  **Decided design (2026-08-15):**
  - _Shape_: an organization runs one install holding **N workspaces (books)**. The
    ONLY global product object is the **user** (one login; per-workspace membership).
    Instance config (MASTER_KEY, SMTP, APP_URL) stays operator-level. Everything else
    — entity graph, spaces/taxonomy, glossary, mandate, attribute registry, pipelines,
    portfolio, tasks, vault credentials, base currency — is **per-workspace**. Twenty's
    core-schema split independently confirms this boundary (only identity + instance
    plumbing are global there too).
  - _Entity graph is per-workspace_: the same founder in two books is two records.
    Correct isolation default; if cross-book knowledge ever itches, the answer is a
    deliberate cross-workspace link/import gesture, never automatic sharing.
  - _Roles go two-layer_: instance admin/member (Better Auth, unchanged) ×
    per-workspace admin/member on the membership row. **Workspace creation is
    instance-admin-only** (books are org-level acts; member-created workspaces are
    the sprawl that kills shared memory — Twenty allows any-user creation because
    workspaces are their growth loop; ours aren't). Creator becomes workspace admin;
    workspace admins invite into their workspace; existing users join additional
    workspaces without re-onboarding. Setup wizard still creates workspace #1 +
    founding admin. **Multiple admins allowed at both layers**; the banned-admin
    lockout guard generalizes: ≥1 instance admin always, ≥1 workspace-admin per
    workspace.
  - _No `organization` object._ The install IS the org — setup creates an admin and
    workspace #1, nothing else. An org table is the shape-(b) tenant/billing anchor
    and arrives only with the hosted design pass. (Twenty likewise has no org layer:
    workspace is their top unit.)
  - _Hosted-future rider (owner intent: selling a deployed version later)._ Shape (b)
    — strangers on one deployment — is NOT being built now, but nothing may foreclose
    it. Discipline that keeps it a hardening pass instead of a remodel: workspace ids
    are uuids (no magic row); **all scoping flows through one choke point** (server
    fns resolve the session's active-workspace membership in one place — the future
    RLS attachment site); no query ever joins across workspaces; credentials stay
    per-workspace-encrypted. When hosting becomes real it adds: RLS (or stricter),
    an org/billing layer above workspaces, and its own security pass — a business
    decision with its own design block, not an increment.
- **Spaces, terms, taxonomy, the mandate are workspace-global.** Never per-user. Shared
  vocabulary is the point; a per-user taxonomy is two people building two ontologies of the
  same market. (Written 2026-08, when "global" and "the workspace" were the same scope;
  since the 2026-08-15 reversal the only _instance_-global object is the user and all four
  of these are per-workspace. The rule that survives is "never per-user".)

Retrofitting these columns after real data exists is a migration touching every table. Adding
them now costs nothing.

## Auth

- Better Auth. DB-backed revocable sessions, httpOnly + Secure + SameSite=Lax cookies.
- Argon2id passwords, min 12 chars, login rate-limited 5/min per IP+email.
- Roles: `admin` (settings, integrations, keys, user mgmt) and `member`. Enforce in server middleware.
- **First run:** signup open only while `count(user) == 0`, guarded server-side, not by config flag.
  Then permanently closed.
- **Invites:** store `token_hash` only, single-use, 7-day expiry, role baked in.
  SMTP configured -> email it. Not configured -> show copyable link. Must work without SMTP.
- **Optional OIDC** via env (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAIN`).
  Present -> SSO button appears. Native invites + password stay the default; OIDC-only multi-user
  (what Wealthfolio does) is hostile to a two-person fund that won't run Keycloak.
- Optional TOTP 2FA (deferred post-v1, 2026-08 — additive via Better Auth's plugin).
  This DB holds deal terms and cap tables, so it stays on the roadmap.

Two token stores, never conflated:

- `session` — who you are in the app
- `account_connection` — Gmail/Calendar OAuth grants, per user, encrypted

"Login with Google" != "sync my Gmail". Different scopes, consent, lifetime.

### Two self-host auth traps

1. **Secure cookies behind a reverse proxy.** Proxy terminates TLS and forwards plain HTTP;
   app sees `http`, refuses to set `Secure` cookies, login loops silently.
   Fix: require `APP_URL` env, derive cookie security + OAuth redirect URIs from it.
   Trust `X-Forwarded-Proto` only from the proxy.
2. **First-run window.** Between `docker compose up` and admin creation, `/setup` is open to
   anyone who can reach the port. Print a one-time setup token to container logs and require it
   at `/setup` — survives someone exposing the port before reading docs.

## BYOK — one framework, all providers

One encrypted vault, LLMs are just one provider class:

```
credential(id, scope: workspace|user, provider, kind: llm|enrichment|search,
           secret_enc, meta jsonb, created_by, last_used_at, status)
```

- Envelope encryption, AES-256-GCM, AAD = `scope:provider`. Master key from `MASTER_KEY` env.
- Auto-generated on first boot to `./data/secret.key` if absent. **Losing it makes every stored
  key unrecoverable — docs must say this in bold.**
- Write-only in UI (show `sk-...4f2a`), redacted in logs, decrypt only in worker.
- Resolution order: user key -> workspace key -> none.
- **Decided 2026-09-14: pasted keys are workspace-scoped only in v1 UI.**
  The `scope: user` column stays (already coded, resolution order already
  honours it) but no UI exposes it until a real ask arrives — scheduled jobs
  need a deterministic key, and two settings surfaces breed "enrich works
  for you but not me" tickets. OAuth _grants_ (`account_connection`) are
  per-user by nature: it is _their_ Gmail/Drive. The OAuth _client_ (id +
  secret per provider) is a workspace credential. A provider (google,
  microsoft, box) is one client under which N plugins hang, each requesting
  incremental scopes; the OAuth dance lives in core, never in a plugin.
  Plugin install / update / disable and workspace keys are admin-only
  (`requireAdmin()` already gates settings, keys, members).
- No key = feature hidden, everything else works. All integrations skippable.

### LLM

- **Vercel AI SDK** for provider abstraction. Anthropic / OpenAI / Google / Ollama / OpenRouter.
- **Task -> model mapping**, not one global model. Tagging = cheap model, memo drafting = frontier.
- **Ollama/LM Studio first-class**, not an afterthought. Self-host audience overlaps local-model audience.
- Token counter for the operator's own cost visibility.

### Embeddings — the dimension trap

**A pgvector column has a fixed dimension. Change embedding model and every stored vector is
silently garbage** — search degrades quietly rather than erroring. This bites everyone once.

- Pin one embedding model per deployment. Store `document_chunk.embedding_model`.
- Changing it enqueues a full re-embed job. Never mix models in one column.
- Open question: bundle a small local model (transformers.js + `bge-small`, ~130MB) so semantic
  search works keyless on first boot? The stated rule is "no key = feature hidden", but dead
  search on a fresh install is a bad first impression, and self-hosters accept a fatter image.
  Ollama's `nomic-embed-text` is the upgrade path for anyone already running Ollama.
- **Answered 2026-09-15: never forced, always automatic once enabled.** No
  embed provider → no vectors, no semantic CTE, lexical + trigram + graph
  RRF is the floor and is good. Provider configured (OpenAI / Voyage /
  Google key, Ollama URL, or the **opt-in local model downloaded to
  `/data/models` at click time — not baked into the image**) → embed on
  `document.extracted` automatically (cents or free per deck); only the bulk
  backfill asks with an estimate. **Pin a dimension, not just a model — 768
  by default** — so nomic, bge-base and OpenAI-3 (`dimensions: 768`) can
  serve one column, and a second local slot can embed _sensitive_ documents
  while cloud serves the rest. Re-pin is the explicit nuclear path (alter
  column, rebuild index, re-embed). Embeddings are core, not a plugin: one
  pinned dimension, sensitivity routing, and being a dependency of core
  search all require the substrate to own them. Detail:
  `docs/spec-ai-substrate.md` §9.

### Enrichment

```ts
interface Enricher {
  id: 'apollo' | 'pdl' | 'crunchbase' | 'hunter'
  enrichCompany(input: { domain?; name? }): Promise<EnrichResult>
  enrichPerson(input: {
    email?
    linkedin?
    name?
    domain?
  }): Promise<EnrichResult>
  estimateCost(n: number): { credits: number }
}
```

Ship Apollo first; the interface makes PDL/Crunchbase/Harmonic/Exa community PRs.

Apollo notes: `POST /api/v1/organizations/enrich` (by domain), `POST /api/v1/people/match`.
Use bulk variants — cheaper per record. Auth header `X-Api-Key`. Rate limits are per-minute/hour/day
and plan-dependent — read response headers and self-throttle, don't hardcode. Some endpoints are
paid-plan-only; surface Apollo's real error text, don't swallow it.

**Credit safety** (first GitHub issue you'll get is someone torching credits on 4000 companies):

- Never auto-enrich in bulk. On-demand button + auto-enrich on new company creation only, toggleable.
- Bulk enrich -> confirm dialog with estimated credit count.
- Per-day credit cap in settings, enforced in worker.
- Hard cache: skip re-enrich within N days (default 90).

**Provenance:** store raw response, project into fields, track source per field
(`manual` | `apollo` | `gmail`). **Never overwrite a manually-edited field** — show
"Apollo says X, you have Y — accept?" Multi-provider disagreement is normal; last-write-wins corrupts.

## Storage

Default **local filesystem**. S3 opt-in via env. Bundling MinIO by default was considered and rejected:
it's really three containers (needs an `mc mb` init sidecar), ~1GB RAM, and it makes backup worse —
FS means plain files the operator can open in Finder and `tar` anywhere, MinIO means an opaque data
dir needing a compatible MinIO to restore. Plus MinIO gutted its community console in 2025;
don't inherit that. If bundling an object store, prefer **Garage** (single Rust binary, ~100MB RAM).

**Re-argued and confirmed 2026-08 — do not relitigate.** The conclusions:

- **A bundled object store does not solve the problem that motivates it.** Single-node
  Garage/MinIO writes to the same local disk. An operator with an ephemeral disk needs
  _remote_ storage, which bundling does not provide.
- **Backup regresses.** Today: `tar czf blobs.tgz ./data` — plain files, restorable
  anywhere. Bundled store: an opaque data dir needing a compatible daemon. The product
  thesis is _you own your data_; this cuts against it.
- **Prior art agrees** (verified against primary sources): Paperless-ngx — closest
  analogue, PDFs + OCR + metadata in Postgres — is **filesystem only, no native S3**.
  Immich (terabytes of media): filesystem only; a maintainer's stated position is that
  swappable backends are the storage layer's job, not the app's — push it below to
  rclone/s3fs. Twenty and Docmost: local default, S3 opt-in via env — Docmost
  independently landed on the same `STORAGE_DRIVER=local|s3` name and path-style flag
  this doc specifies. Plane bundles MinIO and its default compose defines **13 services**;
  nobody both bundles an object store and is considered easy to self-host.
- **The single trigger that changes the answer:** deploying where the host disk is
  ephemeral (Fly / Railway / Render / Cloud Run). Then S3 is a correctness requirement,
  not an upgrade. Nothing else moves it.
- **Decided in advance for whenever the S3 driver is built:** (1) Garage arrives as the
  `docker-compose.s3.yml` overlay, never as service #3 in the default file. (2) The local
  driver re-hashes on write and rejects a mismatch; a presigned S3 PUT cannot — bytes go
  browser→bucket and the server never sees them. Dedupe, the immutable cache header, and
  "same sha ⇒ same bytes" all lean on that check. Mitigation: require
  `x-amz-checksum-sha256` on the presigned PUT. ~~**Unresearched:** whether R2, B2, and
  Garage all enforce it — research the day the driver is written, not before.~~
  **Researched 2026-08 when the driver was written — see _S3 storage driver (phase 13)_
  below:** the checksum is signed into the presigned PUT, MinIO enforces it empirically,
  AWS verifies server-side, R2 and B2 added sha256 checksum support (2024 / July 2025),
  Garage remains doubtful — and the extraction worker re-verifies every digest whatever
  the driver, so a partially-compatible endpoint cannot quietly break the invariant.
- **Workaround noted, with its caveat:** an operator can get S3 today by mounting it at
  `./data` with rclone/s3fs, since the local driver just writes to `dataDir()`. But
  `rename()` is not atomic on S3 and the local driver streams-then-renames, so that write
  pattern is not guaranteed safe. Fine for evaluation, not for a fund.

```ts
interface Storage {
  put(key, stream, meta): Promise<void>
  getDownloadUrl(key, ttl): Promise<string> // presigned (s3) | signed app route (local)
  getUploadUrl(key, ttl): Promise<string>
  delete(key): Promise<void>
}
// Shape as first specified. AMENDED 2026-08 when the second driver landed — see
// _S3 storage driver (phase 13)_ below. The shipped interface is:
//   getUploadUrl(key, ttl)            -> Promise<{url, headers}>  (headers carry the
//                                        signed x-amz-checksum-sha256; local returns {})
//   getDownloadUrl(key, ttl, opts?)   -> opts.filename sets the download name
//   getBytes(key)                     -> Promise<Uint8Array>  (the worker's read path)
//   exists(key)                       -> Promise<boolean>
// Authoritative signature: src/lib/storage/types.ts.
```

Presign matters — a 200MB deck must not stream through Node. Local driver fakes it with a
short-lived HMAC token on `/api/blob/:key`.

`@aws-sdk/client-s3` covers all S3-compatible targets. `forcePathStyle: true` for non-AWS.
Test against MinIO in CI -> works everywhere. Recommend in docs (don't bundle): Cloudflare R2
(zero egress, best cloud pick), Backblaze B2 (cheapest), Garage (self-host), AWS S3.

Ship `docker-compose.s3.yml` as an overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.s3.yml up
```

**Content-addressed keys:** `sha256(file)`. Same deck emailed to both partners -> one blob,
two `document` rows. Dedupe free, immutable, cache-forever.

**Text extraction, in-process, no extra containers:**

- PDF -> `unpdf`/pdfjs · DOCX -> `mammoth` · PPTX/XLSX -> `fflate` + OOXML XML directly
  (SheetJS was dropped — the shared unzip covers both, decks matter most). Macro/template
  variants (`.xlsm`/`.xltx`/`.docm`/`.pptm`) route to the same extractors.
- **Legacy Office (`.doc`/`.xls`) is unsupported** — binary OLE, no extractor. Common in
  Indian deal flow; known gap, lands `extraction_status: unsupported`.
- Scanned/image PDF -> **BYOK vision model**. No Tesseract container. Key absent -> "text not extractable".

Documents hang off entities, not folders. Folders are the thing being replaced.

## Integration readiness (noted 2026-08)

The integration surface (email/calendar, enrichment, call recorders, messaging, AI
assistants, public API/MCP) rides on extension points that already exist: the
credential vault, per-user `account_connection`, `resolveEntity()` as the single entry
gate, `interaction`/`signal` tables, the document pipeline for transcripts/attachments,
and the worker. Two small baselines to add when the first push-style integration lands
(neither changes the schema's shape): a **generic webhook ingress**
(`/api/webhooks/:provider`, signature-verified) and the dedupe-inbox pattern
generalized into a reusable **review inbox** for assistant/AI suggestions.

**One registry of entity-referencing tables (noted 2026-09-07 · shipped
2026-09-11, `src/db/entity-refs.ts`).** The graph is one `link` table in the
story but many edge tables in the schema (`link`, `entity_space`,
`interaction_entity`, `task_entity`, `round_co_investor`, the portfolio
tables, plus every side table keyed on an entity — `list_entry` was on this
list until lists were dropped in migration 0023). That fan-out is the root of the worst review-cycle bug — the merge
executor forgetting a table — and the future context assembler has the
identical failure mode: a new edge table ships and "everything about this
record" silently misses it. Before the assembler is built, factor one
code-level list of entity-referencing tables that both the merge executor
and the assembler iterate, with a test that diffs the list against the
drizzle schema so a new table cannot be added without joining it.

### The integration map (deliberated 2026-09-02, "future" branch)

By data type, not vendor — every category classifies into the existing
claim-type lanes (identity → aliases via resolveEntity; sourced facts →
fill-blanks with receipts; content → document pipeline; generated judgment →
suggestions). No category needs a new lane; that's the design check.

1. **Storage sources** — Google Drive/Box/Dropbox as places decks and data
   rooms already live, picked/synced into the document pipeline. (S3/MinIO
   is our blob backend, not an integration.)
2. **Email + calendar** — forwarding lane first, full sync later
   (survey-twenty-email-sync.md is the map; Attio's forward/BCC address is
   the consent model).
3. **Call recordings** — Fathom/tl;dv/Granola webhooks → transcript as
   document on participant-matched people; summary as suggestion.
4. **Enrichment** — the Enricher interface (BYOK block); Exa-class live web
   is the _research_ lane, distinct doctrine from field-fill.
5. **AI (BYOK)** — the substrate, `docs/spec-ai-substrate.md`.
6. **Native forms** — registry-rendered-outward intake: pitch submission
   (structured pre-lead birth), founder update collection, DD
   questionnaires, referral intake. Native first; Typeform/GForms webhook
   mapping later. Open ground: Attio/Twenty/Relaticle all lack native forms.
7. **Messaging (WhatsApp)** — where half of angel deal-talk actually lives
   (folk proved the category). Three lanes, deliberated 2026-09-02:
   _Lane 0 (v1, zero infra)_: parse WhatsApp's native "export chat" .txt
   (+ media) uploads — messages → interactions on phone-alias-matched
   people, media → document pipeline; user-curated per conversation, the
   same consent shape as email forwarding, no ToS exposure. _Lane 1 (real
   sync)_: optional opt-in companion container speaking the WhatsApp Web
   multi-device protocol (Baileys, or whatsmeow via mautrix-whatsapp),
   QR-linked as companion device, streaming to the webhook ingress —
   **read-only, 1:1 chats only, opt-in per chat or known-person-matched
   only**; docs must state plainly: ToS-violating protocol reverse-
   engineering, nonzero ban risk, runs on the user's box at their risk.
   _Lane 2 (Business Cloud API)_: wrong shape (outbound template messaging
   on a dedicated number), not our use case. Sequence: lane 0 whenever
   cheap; lane 1 last on the whole map.
8. **Capture extension (LinkedIn)** — manual per-profile capture from the
   user's own browser session; the manual cousin of enrichment. Shape
   (deliberated 2026-09-02): MV3 WebExtension in-repo (`apps/extension`),
   thin client — grabs visible page text, POSTs to the user's own instance
   (`/api/capture`, instance URL + PAT configured once); extraction happens
   server-side via the AI extract lane against the registry schema (no
   brittle LinkedIn selectors — markup churn can't break it), then
   resolveEntity + suggestions. Nothing to host: Bitwarden distribution
   model — one generic store-published build (plus a release zip for
   load-unpacked), instance URL user-configured, no middleman endpoint.
   Versioned capture API so extension/instance drift degrades to "update
   me", never breakage. Defensibility line: manual, user-initiated, their
   own session, no background crawling or bulk automation.
9. **Link-based deck ingestion** — DocSend/Pitch/Notion links snapshotted to
   PDF into the document pipeline before they expire.
10. **Migration/import** — CSV/Airtable/Notion/CRM import; onboarding-
    critical (every prospective user has deal flow in a spreadsheet today).
11. **Outbound** — MCP server (AI agents), generic webhooks/API (n8n
    automation), digest delivery channel (Monday brief → Slack/Telegram/
    email; pull-based doctrine, delivered somewhere).
12. **Feeds (RSS/Atom)** — deliberated 2026-09-02 on the "future" branch,
    recorded 2026-09-07. A feed poller capability: `feed(url, scope,
cadence, muted)` + `feed_item(feed_id, guid, url, title, summary,
published_at)`, one pg-boss recurring job, dedupe by guid/URL. No
    credentials — the one capability with no vault dependency; dormant
    until the first feed URL. What makes it CRM-grade: each item runs a
    deterministic match pass against the graph (company domains in links,
    alias/name matches in text) and lands as a `signal` on the matched
    record; an optional classify-lane pass is the AI upgrade, gated on the
    AI capability. Unmatched items still flow to the digest — sourcing
    signal lives in companies you don't have records for yet. Feeds attach
    at three scopes: global (TechCrunch, a sector newsletter), per space (a
    hydrogen blog on the hydrogen space), per entity (a portfolio company's
    press page; Google Alerts ship as RSS, so name-monitoring is free). The
    digest is the consumer, not part of the capability. Newsletters arrive
    by email, so the forwarding mailbox doubles as newsletter ingestion
    later, same signal store — another reason forwarding goes first.
    Exa/news-API monitoring is the paid research-lane cousin; RSS is the
    free tier of the same category.

Sequencing instinct (revised 2026-09-02): email forwarding + link ingestion
first (inbound arrival, cheap, feed everything), enrichment second,
calendar/call recordings third. **Forms, the capture extension, and
WhatsApp are all much further down the pipeline** — deliberated and mapped
above so the shapes are on record, not because they're near-term.

## Email / calendar ingestion

**Deferred — post-MVP.** Decided 2026-07: ship the graph and both halves first; feed it
automatically later. Two consequences of the decision:

- **Forward-only sync.** Sync starts at connection date. No historical backfill in v1 of the
  integration (revisit later). This turns the entity-creation flood (3 years of mail, hundreds
  of noise companies) into a trickle, and makes "create all, visible" the obvious policy.
- v1 entity creators are manual, deck upload, `[[mention]]`, URL clip — all low-noise. The
  resolution pipeline below is unchanged; Gmail is just another caller of `resolveEntity()`
  when it arrives.

Long-term this is still the product. The CRM is the boring part. Funds pay for zero manual
data entry. With 2+ mailboxes the relationship graph becomes the value; with one it's a mail
archive.

- Per-user OAuth grants, shared dataset:
  `account_connection(user_id, provider, external_email, tokens_enc, last_sync_at, status)`
- Dedupe by RFC822 `Message-ID` — same thread in both inboxes must be one interaction.
- **Google verification is avoidable** because users bring their own GCP project + OAuth client:
  - Fund on Google Workspace -> OAuth app type **Internal** -> no verification, unlimited org users. Push this.
  - Otherwise -> **Testing** mode, up to 100 users, refresh tokens expire in 7 days. Document the annoyance.
- Needs noise filtering — not every thread is a deal. Heuristics + cheap classifier, else the
  pipeline fills with garbage.

### Privacy default (decide deliberately — get it wrong and partner #2 never connects their mailbox)

- Thread **metadata** (participants, subject, timestamps) -> shared. Powers the graph.
- Thread **bodies** -> visible to the connecting user only, until they attach the thread to a deal.
- Per-connection exclude list: domains/labels never synced. Ship a default blocklist.
- Make it a settings toggle — some funds want everything shared.

## UI

Attio is the reference for shape and craft.

- **Views over data:** table + kanban (group by any select attribute), saved and shared, **per object** (read "per list" until 2026-09-07; lists became views — see _Lists — deferred_).
  One view engine, not separate pipeline/list screens.
- **Spreadsheet-grade table:** inline cell edit, virtualized rows, resizable/reorderable columns,
  multi-select + bulk edit, keyboard nav. Investors live in Excel. If the table is worse than a
  spreadsheet they leave. Hardest UI work in the project — budget for it.
  **v1 scope line (2026-07):** registry-generated columns (show/hide/reorder/resize),
  "+ Add column" creates an attribute inline, typed cell renderers + inline edit, single
  sort, simple filters, Spaces pseudo-column, row → record. Deferred by name: saved/shared
  views, bulk edit, calculations row, CSV, virtualization + keyboard-grid (land when row
  counts demand), kanban debuts on Deals only.
- **Record page:** left = attribute sidebar, center = tabs (Activity / Notes / Emails / Files / Tasks),
  right = related records. Activity timeline auto-filled from mail.
  **v1 scope line (2026-07):** left rail registry-generated (same typed editors as table
  cells, "+ Add attribute"), identity/domains block from aliases; center tabs Activity
  (condensed bursts) + Notes; right rail Spaces · People↔Companies · Deals (on company) ·
  Mentioned-in; full-page nav. Deferred by name: Overview/Highlight cards (needs
  interaction+enrichment data), Emails/Calls/Tasks/Files tabs (arrive with their
  features), drawer-over-table.
- **Cmd-K everywhere:** search, create, navigate, jump to record.
- Optimistic updates, no page reloads.
- **Never show an empty table.** Onboarding aha = connect Gmail, companies and people are already
  there, _then_ organize. Demo-data seed for anyone who skips Gmail.

---

# Hosting

Target: `docker compose up` works first try.

```yaml
services:
  app: # Nitro node-server (web) + pg-boss worker, two processes, one image
  db: # pgvector/pgvector:pg17
```

Two processes in one image, selected by entrypoint. Web must never run CPU-bound extraction or
embedding inline — those block the event loop and are the worker's job. Dev mirrors the
split: `pnpm dev` is web only; run `pnpm worker` alongside, or extraction never runs and
Office previews sit on "Extracting text…" forever.

Rules that decide adoption:

- Migrations auto-run on boot. No `docker exec` step.
- Every env var optional except `DATABASE_URL` and `APP_URL`. `MASTER_KEY` auto-generated if absent.
- **No build-time env vars.** Vite bakes `VITE_*` at build time, so nothing client-visible may
  come from one — the browser gets runtime config from an endpoint or the root loader. Same trap
  as Next's `NEXT_PUBLIC_*`; a prebuilt image cannot be reconfigured at `docker run` otherwise.
- Prebuilt multi-arch image (arm64 matters) on GHCR + Docker Hub.
  Non-root UID 1000. Docs tell people to pin tags, not `latest`.
- **Onboarding direction lives on the surface, not in the wizard (decided
  2026-08-07).** Goal: the user thinks in spaces from minute one. Considered a
  wizard "name your markets" step; rejected — same question asked one screen
  later on /spaces teaches the same model _on the surface they'll use
  tomorrow_, and the wizard stays minimal. Shipped as: (1) /spaces empty state
  is an active **markets creator** ("What markets do you look at?" — three
  inputs → real top-level spaces via createSpace); (2) a dismissible
  **getting-started card** on /spaces (map markets → first memo → mandate →
  track companies → invite partner) whose steps are _derived_ — done when the
  real artifact exists (getOnboardingProgress counts spaces/notes/active
  mandate/companies/users+invites), never by being clicked; dismissal is
  localStorage, guidance not state. Persona bifurcation (angel vs fund)
  rejected: every difference is copy or a default, nothing structural —
  empty states let users self-select. Setup-wizard copy made
  persona-neutral instead.
- First-run web wizard (**minimal, decided 2026-08**): setup token -> admin + workspace
  name -> optional demo data. Under a minute. AI-key and Gmail steps join the wizard only
  when their features ship — a wizard step collecting a key nothing consumes is a broken
  promise on first boot. The mandate is written from its page's teaching empty state, not
  a wizard step.
- Healthcheck endpoint, sane logs.
- Publish Coolify / Railway / Render / Unraid templates. Cheap, huge reach — that's where
  self-hosters live.

Env surface:

```
DATABASE_URL=        # required
APP_URL=             # required, e.g. https://deals.yourfund.com
MASTER_KEY=          # auto-generated on first boot if absent
SMTP_URL=            # optional
OIDC_*=              # optional
STORAGE_DRIVER=local # or s3, then S3_* vars
```

Upgrade: `docker compose pull && docker compose up -d`. Never ship a breaking migration;
CI must test the upgrade path from every prior release.

## Hostability decisions (locked 2026-08, implementation slots later)

Six contracts, decided before any release work so nothing gets built against weaker ones:

1. **`./data` ownership is fixed structurally, not by docs.** Entrypoint starts as root,
   repairs `/data` ownership if wrong, drops to UID 1000 via `su-exec` before running
   anything. The Linux bind-mount trap stops existing. (Named volume rejected — plain
   files under `./data` that the operator can `tar` anywhere _is_ the you-own-your-data
   story.)
2. **Either process dies → the container exits.** `ROLE=all` currently waits on the web
   PID only; a crashed worker leaves a "healthy" container with extraction silently
   stopped. Supervision contract: worker death kills the container; `restart:
unless-stopped` heals it.
3. **The app never terminates TLS.** Reverse proxy always in front; `APP_URL` is the
   single source of truth for scheme, cookies, OAuth redirects; `X-Forwarded-Proto`
   trusted only from the proxy. Ship a worked Caddy overlay
   (`docker-compose.tls.yml` + Caddyfile) so HTTPS is copy-paste.
4. **`/api/health` checks the DB**, not just the process — otherwise the compose
   healthcheck gates nothing. Later: worker heartbeat row so `ROLE=worker` containers
   get a real check too.
5. **Backup is both-or-neither, and rollback is restore.** `pg_dump` + `tar ./data`
   together — content-addressed blobs are worthless without the DB and vice versa.
   Upgrade = backup → pull → up. Never run an older image against a newer schema.
6. **The required-env set is frozen at `{DATABASE_URL, APP_URL}` — permanently.** Every
   future feature ships with a working default or is optional. This rule is what keeps
   "compose up works first try" true five features from now.

Backup — three artifacts, one cron line, ship as `scripts/backup.sh`:

```bash
docker compose exec db pg_dump -U spaces spaces > dump.sql
tar czf blobs.tgz ./data/blobs ./data/secret.key
```

## Prior art checked

**Wealthfolio** (verified 2026-07): single image, SQLite at `/data/wealthfolio.db`, one volume,
UID 1000, env config (`WF_SECRET_KEY` — same encrypt-API-keys-and-sign-JWTs pattern as our
`MASTER_KEY`), single-user password auth with multi-user only via OIDC, reverse-proxy docs for
Caddy/nginx/Traefik/NPM, guides for Coolify/Unraid/Proxmox.

Copy: multi-arch GHCR + Docker Hub, non-root UID, pinned tags, platform guides.
Don't copy: their first-run requires running `openssl rand` and `argon2` on the host before the
container starts — real drop-off. Our auto-generate + web wizard is better. Also don't copy SQLite
or OIDC-only teams.

Structural difference: Wealthfolio is local-first, single-user, no external integrations.
Ours is server-shaped — OAuth callbacks, background sync, shared team graph. We cannot be as
simple as them. Target is "as simple as Plane/Cal.com".

**Others surveyed:** Twenty (AGPL, closest existing option, custom objects, but generic),
Huly, EspoCRM/SuiteCRM/Odoo (sales-shaped, not investing-shaped), NocoDB/Baserow/Teable +
Docmost/Outline as a two-tool stack. None are investor-opinionated. That's the gap.

**Investor-specific products surveyed (2026-08):** Affinity (auto email/calendar capture →
relationship graph + warm-path scoring — validates Gmail-sync-as-endgame and our
`interaction_entity` scoring primitive; also ships meeting-prep agents and an MCP server,
so MCP is trending table-stakes), Edda (mechanics verified: "once Dealflow companies move to
the 'Invested' stage, their data is automatically transferred to your Portfolio" —
independent convergence on our Invested-births-a-holding seam; their metric kit
IRR/MOIC/NAV/DPI/TVPI matches phase 15's; two features banked from them —
**deal scorecards** with weighted per-partner votes, a post-portfolio candidate for
multi-member workspaces that maps onto rating attributes, and a **funding-status/runway
lens** over the portfolio as the first consumer if MIS ever lands; their deal
tasks/reminders reinforce that known gap), 4Degrees (warm-intro paths as the differentiator), TagHash (fund-admin tier —
fenced out of phase 15), Visible.vc (portfolio MIS = structured founder requests with a
standard-six metric default — Revenue, Net Income, Cash, Runway, Burn, Headcount — via
login-free tokenized links; the shape to copy if MIS ever lands). US-stack contrast (2026-08): US
emerging managers _outsource_ the entire fenced tier to service platforms (AngelList
Stack, Carta fund admin at $8–30k/yr, Juniper Square) and run the front office on
Airtable/Notion/Excel — which makes our fence doubly correct there and the DIY front
office our exact wedge; US integration targets are Carta exports and Standard Metrics,
vs India's MIS-workbook parsing. Three ideas banked for
the BYOK AI phase: **meeting-prep brief** (one-pager from record + filed notes + recent
interactions ahead of a calendar event — our research half makes this richer than
Affinity's), **pass-letter drafting** from the recorded pass reason (Edda's Decision
Writer), and deck-reader autofill (already implied by extraction + AI-autofill
attributes).

---

# Hard parts, in order

1. **Entity resolution + merge semantics.** ~~Design this before the first migration~~ —
   **done, spec'd 2026-07, see _Entity resolution & merge_ in the data model.** Doctrine:
   deterministic auto, probabilistic suggest. Repoint-at-write merge with snapshot. Still
   hard to _build well_ (merge preview UI, dedupe inbox), but no longer blocks the schema.
2. **The table component.** Spreadsheet-grade or investors leave. See UI.
3. **The note editor.** `[[mention]]` autocomplete over all entity kinds, backlink panel,
   glossary auto-linking, paste-a-URL-becomes-a-source. Everything in the research half routes
   through this one component.
4. **Gmail OAuth setup doc.** Longest step in the install, decides whether people finish.
5. **Email noise filtering.** Not every thread is a deal.
6. **Indian data sources.** MCA/CIN registry, Tracxn/Crunchbase licensing. No cheap legal
   enrichment source. Scraping is a legal and reliability liability. Answer: BYOK for data too.

Unglamorous work that decides 50 stars vs 5000: the Gmail doc, the demo seed, arm64 images,
and migrations that never break.

---

# MVP scope

Both halves ship, or the seam — the whole point — doesn't exist.

1. Auth: first-run wizard, invites, roles
2. Entity core + `link` table + unified search (tsvector across notes, docs, entities)
3. Spaces: seed taxonomy, custom nodes, space page (notes + sources + companies + contacts)
4. Notes: markdown, `[[mentions]]`, backlinks, attach to anything
5. Documents: upload + URL clip, text extraction, attach to any entity
6. Deals: object with stage/value/company attributes, table + kanban by stage, activity feed
7. ~~Theses~~ — shipped 2026-07, **removed 2026-08** (see _Thesis — removed_); the
   mandate page takes the "why we invest" slot
8. Glossary with in-note auto-linking
9. Entity resolution: `resolveEntity()` choke point, aliases, dedupe inbox, merge + snapshot
10. BYOK AI: deal summary from attached material, memo draft, space tag suggestions

Then: **Gmail sync (forward-only)**, Apollo enrichment, signals, co-investor graph
(seeded by round co-investor links from the portfolio layer, phase 15), Outlook.

MIS, when it lands, is **dual-path**: structured founder requests (tokenized links,
standard-six default) _and_ parsing what founders actually send (MIS Excel / board-deck
PDF / update email — India reality). Parsing rides the existing document-extraction
pipeline plus a BYOK extraction job; results land as append-only
`kpi_observation(company, metric, period, value, currency, source, source_document,
confidence)` events — restatement-friendly, as-of capable — and AI-extracted numbers
always enter through the review inbox, never silently (a hallucinated revenue figure
in fund records kills trust permanently). Known hard parts, non-architectural:
per-company metric aliases, Indian fiscal periods and lakh/crore units.

**Ordering rationale.** Nothing in 1–10 needs an external dependency, OAuth consent screen,
or provider doc. Gmail is the single longest step in the project and gates nothing above it.
Build the graph first and feed it automatically second — a hand-populated graph is already
useful, an auto-populated one with nowhere to land is not. Gmail sync, when it lands, is
forward-only (no historical backfill) and just another `resolveEntity()` caller.

Outlook is cut from v1: it doubles the OAuth doc and the sync adapter work for a user base
that skews Google Workspace.

---

# Next step

**Object-model build (phases 1–5): done, 2026-07.** Attribute engine, Attio-style tables
for Companies/People/Deals with inline typed editing and add-column, registry rails,
reference editors, condensed attribute timelines, object settings (rename/options/
archive/reorder — option ids preserved on rename so stored values survive). Kanban was
dropped in favor of stage-group filters on the deals table.

**Interactions: done, 2026-07** — manual meeting/call logging, attendee edges, timeline
integration, last-touched columns. Calendar sync later automates rows into this shape.

**Documents (phase 6): done, 2026-07.** Files tab on company/person/deal records; upload is
browser-hashed → presigned PUT → file the row, so bytes never stream through a server
function. The local driver verifies the digest as it writes, which is what makes "same sha ⇒
same bytes" true enough for the dedupe, the immutable cache header, and the worker to rely
on. Extraction runs on the worker (`unpdf`, `mammoth`, `fflate` + OOXML for PPTX/XLSX) and
writes `extracted_text` + `tsv` together — phase 8 search inherits a populated index.
Decisions worth keeping:

- **`extraction_status` is three-way, not a boolean.** `unsupported` (scanned deck, image —
  a BYOK vision model is its upgrade path) is a normal permanent state, not a failure.
- **Downloads are always `attachment` + `application/octet-stream`.** Echoing an upload's own
  content-type would make an uploaded `.html` stored XSS against the app's own origin.
  **The preview surface arrived (2026-08) and kept this intact:** the blob route is
  unchanged; `document-preview.tsx` fetches the same opaque bytes and renders them itself —
  PDF via pdf.js to a canvas (the browser never navigates to the file), images via an
  object URL whose type _we_ choose, Office via the worker's already-extracted text (a
  tab-separated sheet renders back into a grid). SVG stays download-only — it is a script
  vector and `<img>` is the only safe element for it. Preview is a modal, argued for: an
  inspection, not a destination — a route would make the back button undo reading position.
  Known limits: whole file loads into memory (no `Range` support in blob route or preview —
  fine for 5–30MB decks, slow for a 200MB scan); Office preview depends on the worker
  running, PDF and images do not; no automated test — a Playwright upload→preview→assert
  test is the natural first CI case.
- **Delete is real, and GCs the blob when no other row shares its digest.** A misfiled upload
  the operator can't remove is worse than the audit trail it costs.
- Deferred by name: URL clip (`origin: 'url'`, `@mozilla/readability` + `linkedom`) moves to
  phase 7 where space pages actually want _sources_; chunking + embeddings wait on BYOK; the
  S3 driver still throws.

**Theses (phase 7): done 2026-07 — removed 2026-08.** Shipped as claim/conviction/status
with evidence on both sides, then removed by owner decision; the reasoning and the
removal's scope live in _Thesis — removed_ in the data model. Migration 0010 dropped the
tables, the entity kind, and the evidence relations; routes, space-page claims, and the
demo-seed thesis went with them.

**Search (phase 8): done, 2026-07.** One Cmd-K box over names, note bodies, and extracted
document text, fused in Postgres. Decisions:

- **Everything searchable is an entity, so RRF is honest.** Trigram similarity and `ts_rank`
  produce incomparable scores, but ranks fuse cleanly — reciprocal rank fusion (k=60) over
  three CTEs ranking the same id space. The pgvector half joins as a fourth CTE when
  embeddings land; nothing else changes.
- **`word_similarity` (`<%`), not `similarity` (`%`), for names.** The plain operator
  compares whole strings, so a short query against a long name always falls under the
  threshold — "orbitl" would never reach "Orbital Composites". Needs the trigram GIN index
  on `entity.canonical_name` added in 0009.
- **`note.tsv` is a STORED generated column**, not a trigger or an app-side write. `body_md`
  is already derived on save, so the vector derives from it and cannot drift. Title carries
  weight A over body B. (`document.tsv` stays worker-written — its text arrives async.)
- **cmdk's client-side filtering is off.** It would re-filter server-ranked results and
  silently drop the fuzzy matches the trigram index exists to find.
- **Snippets come from `ts_headline` with `«»` markers, rendered as text.** Never HTML —
  extracted deck text is not something to hand to a parser.
- **Document hits route to the record they are filed against**, since documents have no page.

**Glossary + seeds (phase 9): done, 2026-07.** Aho-Corasick auto-linking in the editor,
per-space glossary, starter taxonomy, opt-in demo data. Decisions:

- **Auto-linking is a ProseMirror decoration, not document content.** This is the TipTap
  escape hatch this doc reserved, reached through BlockNote's `_tiptapOptions.extensions`.
  Writing highlights into `body_json` would put derived data in the source of truth and
  force a rewrite of every stored note whenever a definition changes. Decorations are
  presentation only and vanish when a term does. `@tiptap/core` and `@tiptap/pm` are now
  direct deps, pinned to BlockNote's exact version — two ProseMirror copies break plugin keys.
- **Matching is whole-word and longest-wins, deliberately without stemming.** "stage" does
  not match inside "backstage" — nor inside "stages". A highlight you cannot predict is
  worse than one that misses a plural.
- **Terms inherit down the tree, never up.** PUE defined at Data centers is true in
  Cooling; a term defined in Cooling says nothing about Aerospace. That asymmetry is the
  whole reason terms are scoped — `ltree` ancestor containment gives it for free.
- **The term set is captured when the editor mounts.** Defining a term while a note is open
  highlights it on next load; recreating the editor would discard cursor and undo history.
- **Starter taxonomy seeds on first boot only**, so nodes the operator deletes stay deleted.
  No seed keys, no reconciliation — the tiny-seed decision bought that away.
- **Demo data is opt-in at setup, guarded on "no companies exist"**, and goes through
  `resolveEntity()` like every other creator. Shipping it silently would put fictional
  companies in someone's CRM.

**Design craft pass (partial): 2026-08.** Not a redesign — the v1 scope lines held.
Shipped: the token/primitive layer (see _UI craft debt_ below), **one shared record table
behind Companies/People/Deals** (three copies collapsed; the table is the hardest UI in
the project and now has one implementation to be good at), per-option badge colours
(auto-assigned, overridable in settings), and in-browser document preview (see the phase 6
notes — the download hardening survives it). Verified by driving the real app, which is
what caught a colour picker that didn't close on selection, a sticky-column hover seam,
and mouse-only column resizing. Remaining craft work is itemised in _UI craft debt_.

**Auth + onboarding (phase 10): done, 2026-08.** Workspace singleton (CHECK-enforced one
row; sidebar shows its name), /setup one-time token (file under DATA_DIR, printed to
logs, deleted when the first admin exists), minimal two-step wizard (token + admin +
workspace name → optional demo data; the AI-key step was removed until a feature
consumes keys), invites (hash-only storage, single-use, 7-day, role baked in, copyable
/join link — no SMTP needed), member management in settings (roles, suspend, last-admin
guard), and the authz choke points. Decisions worth keeping:

- **Token and invite enforcement live in the Better Auth database hook**, not routes —
  the public signup endpoint would bypass anything checked route-side. Wizard and /join
  merely carry the token as a header. Verified by driving the endpoint directly: no
  token rejected, wrong token rejected, valid path creates the admin, invite single-use
  enforced, `used_by` attributed.
- **`canRead` enforced in SQL, not per-row in Node** — private-note filters live in the
  queries (list, get, search CTEs, space page, autocomplete), because a title surfacing
  in Cmd-K is as much a leak as a body. Private note reads return "not found", never
  403 — a 403 confirms existence.
- **Visibility is the author's alone** — not even an admin flips someone's private note
  shared; the default-shared trust model depends on that. Shared notes stay
  team-editable.
- **updateAttribute is admin; createAttribute stays member.** Renames/options/archive
  reshape shared vocabulary (settings, admin-owned); adding a column is additive and a
  two-person fund needs no ceremony for it.
- Ops fixes landed alongside: `scripts/backup.sh` (both-or-neither, partial deleted on
  failure), entrypoint supervision (either process dies → container exits), and a
  `FOR UPDATE` on the `setValues` read-modify-write so concurrent partners can't lose
  each other's attribute edits.

**Mandate page (phase 11): done, 2026-08.** `mandate` table (one active enforced by a
partial unique index; archived rows are vintages), prose as a real memo note, facts rail
(stage chips off the live `funding_stage` vocabulary, geo tags, check range), Mandate
first in nav with login still landing on `/spaces`, teaching empty state, and the
outside-mandate hint on the deal record. Decisions worth keeping:

- **Member-writable, not admin.** The mandate is judgment, not settings — same
  no-ceremony rule as merge. Note prose follows normal note rules.
- **`mandate.stages` stores option ids**, so the operator renaming "Seed" in settings
  never breaks the mandate — ids are stable under rename by the registry's own rule.
- **The hint computes server-side in `getDeal`** and is tri-state: null (no mandate, no
  stages, or company has no stage) renders nothing — only a real mismatch shows, as a
  quiet amber tint linking to the mandate, never red, never blocking.
- Verified live: empty state SSR, facts rail renders vocabulary, series_a company under
  a pre-seed/seed mandate shows the hint, flipping the company to seed removes it.

**Templates (phase 12): done, 2026-08.** One `template` table, three kinds, all creation
by-example ("Save as template" on a note, record, or space — no builder UI anywhere), one
shared picker component with `suggest_on` context ordering, management in settings.
Decisions worth keeping:

- **Mentions are stripped to plain text at note-template capture** — a template holding a
  real entity reference would materialize ghost backlinks on every instantiation.
- **Record templates exclude reference/actor slugs at capture** and pre-fill the create
  modal visibly; nothing writes silently. The original v1 limit (picker on the company
  dialog only) was lifted 2026-08 by the dialog restructure: person and deal creates now
  render registry fields in a type-driven two-column grid (`fieldSpanClass` — half-width
  default, long-form `description` spans both; layout survives any custom attribute), so
  all three dialogs carry the template picker.
- **Scaffold stamping is skip-existing** (same-named child reused, never duplicated) and
  captures names + glossary terms only, never memo content — a scaffold that copied
  memos would smuggle one market's research into another.
- `createSpaceRow` moved to `server/shared.ts` (not barrel-exported) so the scaffold
  stamper and `createSpace` share slug/path logic without leaking db code client-side.
- Verified by driving the real app end-to-end: note → template → new note carries the
  body; Data-centers subtree + PUE term captured and stamped intact onto a new
  "EV batteries" root; company template visibly pre-filled Business model / Funding
  stage / Location in the create modal; settings lists all three with context chips.

**S3 storage driver (phase 13): done, 2026-08.** `S3Storage` behind the frozen `Storage`
interface (`@aws-sdk/client-s3` + presigner), selected by `STORAGE_DRIVER=s3`; env is
`S3_BUCKET/S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE`
(path-style defaults **on** — right for R2/B2/MinIO/Garage). MinIO + one-shot bucket-init
live in the _dev_ compose only. Local FS stays the default; production compose unchanged.
Decisions worth keeping:

- **The checksum matrix, answered.** `x-amz-checksum-sha256` is baked into the presigned
  PUT's signature and returned as a required header for the browser to send. Empirical:
  MinIO rejects mismatched bytes (`XAmzContentChecksumMismatch`, 400) and refuses PUTs
  omitting the signed header. Documented: AWS verifies server-side (BadDigest); R2 and
  B2 added sha256 checksum support (2024 / July 2025); **Garage remains doubtful**.
- **Universal integrity backstop, nearly free:** the extraction worker already holds
  every blob it processes, so it re-verifies the digest there regardless of driver —
  partially-compatible endpoints can't quietly break "same sha ⇒ same bytes". Mismatch
  → extraction fails loudly, document flagged.
- **Download hardening survives S3:** attachment + octet-stream are baked into the
  _signed_ response params of every presigned GET — an uploaded `.html` can't be served
  inline from the bucket either.
- **Interface changes the second driver forced** (the predicted leak-finding):
  `getUploadUrl` now returns `{url, headers}` (local returns empty headers), and the
  worker reads via `storage().getBytes()` instead of a direct file path.
- Verified: 12-check driver suite against MinIO (lifecycle + both integrity rejections),
  then the full app driven by browser with `STORAGE_DRIVER=s3` — upload via presigned
  PUT, extraction from the bucket, pdf.js preview via presigned GET; blob present in
  MinIO under its sha, local blobs dir never created.

Remaining phases (**sequence grilled and decided 2026-08** — features first, ship polish
once, immediately before strangers can install):

**Design-debt pass (phase 14): done, 2026-08.** The sweep: every hand-written translucent
focus ring (51, across 16 app files) replaced by the `focus-ring` utility; all bracketed
type sizes collapsed to the named scale (92 instances — the one surviving `text-[17px]`
is the prose register's, by design); every sub-100% `text-muted-foreground` opacity
removed (10 files — the contrast-floor doctrine now holds everywhere); motion timing made
explicit per the Freiberg doctrine (dialogs 180/120ms, menus 150/100, tooltips 120/80,
all on ease-out-quart, exits always faster) and buttons gained the physical pressed
compression (scale 0.97). Then `/impeccable document` ran: DESIGN.md now carries full
machine-readable frontmatter tokens (OKLCH, per doctrine), a real §5 Components section
scanned from the shipped code (record table and typed value editors documented as the
signature components; motion doctrine folded in per the six-section spec), and an
`.impeccable/design.json` sidecar with ramps, motion tokens, and renderable component
snippets. 15. **Portfolio layer** (decided 2026-08; the full domain vocabulary behind this layer —
terms, fund mechanics, ideologies, and what each surveyed vendor covers — lives in
`docs/private-capital-glossary.md`, annotated with [P15]/[banked]/[fenced] tags;
surveyed against TagHash-class products —
this is the tier where an investing CRM stops being a pipeline tracker; it is also
where we currently lose any feature comparison). Pure graph + registry + computed
values: no external dependency, no OAuth, fully in-wheelhouse. Build order is the
dependency order: 1. `round` — financing event per company: date, kind, raised, pre/post-money,
co-investors (link rows → the co-investor graph falls out later). 2. `investment` — _our_ checks: amount, **currency**, instrument
(SAFE / CCD / priced — CCDs matter for India), date, round ref, shares or
ownership %. **A deal reaching Invested births one** — the pipeline→portfolio
seam, same philosophy as research→pipeline. 3. Ownership & dilution ledger — % at entry, recomputed per subsequent round.
An ownership _history_, deliberately not cap-table management (Carta's job). 4. `mark` — fair value per holding over time, each carrying basis
(round price / manual / 409A) and date, never overwritten: death-is-information
applied to valuations. 5. `distribution` — realized proceeds: exits, secondaries, dividends, write-offs. 6. Computed performance, live at our scale (dozens of holdings, no metrics
warehouse): MOIC, TVPI, RVPI, DPI, XIRR, realized/unrealized — per holding and
portfolio roll-up. 7. Portfolio surface — holdings table (invested / current value / ownership /
MOIC / IRR / last mark) on the existing record-table engine + holding detail. 8. Multi-currency minimally but from the first migration: per-cash-flow currency,
base-currency roll-up, manual rates first. 9. **Portfolio bootstrap import** (decided 2026-08) — inside this phase, not
deferred with general CSV import: an empty financial engine is dead on arrival
for anyone with existing checks. One wizard — upload (CSV/XLSX) → map columns
onto the registry/event fields → resolve-preview (`resolveEntity` does the
matching; `source: 'import'` provenance already exists) → dry-run report →
idempotent commit. Target shape is the universal tracking spreadsheet: company /
date / amount / instrument / round info / current mark, decomposed into dated
`round` + `investment` + `mark` events so IRR and as-of views work on day one
for pre-existing positions. Per-row errors, never all-or-nothing.
Spec refinements (2026-08, stress-tested against a TagHash analytics dashboard): - **Append-only dated events; aggregates always derived, never stored.** This is
what makes "as on <date>" point-in-time views free — filter events ≤ date and
recompute. Stated as a rule so nobody adds a mutable current_value column. **A
correction is an append too (decided 2026-09-18 as D12, built 2026-09-19 by
SPA-150):** there is no edit path and no delete path on a ledger event. A void
appends a compensating event — same holding, the _original's_ date, negated
amount and shares — citing the original through a nullable self-referencing
`reverses_id`, so the record of what was believed and when survives the
correction. A partial unique index on `reverses_id` makes a second void a
database refusal; a nullable `batch_id` (no FK yet — nothing owns a batch
until import-9 and ai-22 stamp it) lets one wrong forty-row import be voided
in a single transaction, all or nothing. **`fx_rate` is deliberately not one
of them:** it is a lookup rather than a summed event, its `rate_to_base > 0`
CHECK forbids a negated row, and `setFxRate` already upserts on
`(currency, date)` — correcting a rate recomputes every derived number, so
there is nothing for a reversal to undo. Readers get the other half of the
rule: the loader hands the pure libs only live originals, each carrying
`reversedAt` (the void instant), and a reversal counts only once the as-of day
has reached it — so "as on <date>" before a void still shows what was believed
then. The derived numbers never depend on the negation summing to zero. - **Instrument subtypes carry ownership semantics** (2026-08, YC mechanics):
post-money SAFEs lock ownership at signing (amount ÷ cap — display as _implied %_);
pre-money SAFEs and CCDs have cost basis only until conversion — never fake a %.
Enum: priced / safe_post_money / safe_pre_money / ccd. - **Share-level columns from day one**: price_per_share + shares_outstanding on
`round`, optional shares on `investment` and `distribution` (shares_outstanding stated as the _fully diluted_ count) — ownership %,
dilution deltas, and divestment math all need them; retrofitting means
re-entering history. Ownership stays ours-position-only (our shares ÷
outstanding ⇒ our % and fully-diluted %); a full all-shareholder cap table is
Carta-tier and stays out. - **Nullable `vehicle` label on money events** — data, not tenancy (the
no-workspace_id rule is untouched — _that rule was itself rescinded 2026-08-15 by the
multi-workspace reversal; what survives here is the narrower point: `vehicle` is a label
on a money event, never a scope_): one optional column so an All-funds/Fund-I
grouping is possible later without a migration. Doctrine (2026-08): ~~**workspace =
firm, never fund** — research, relationships, and pipeline are firm-level~~; which
vehicle wrote the check is a late accounting detail, and cross-vehicle follow-ons
must land on one holding. **Amended 2026-08-15** (multi-workspace reversal): the
install/org is the firm and a workspace is a **book** — entity graph, taxonomy,
mandate, pipelines and portfolio are per-workspace, not firm-level. What survives
unchanged is the vehicle rule: a workspace is never a _fund_, and `vehicle` stays a
label on a money event rather than a scope. Known limit, accepted: one-active-mandate assumes
serial vintages; parallel distinct-strategy vehicles would need
mandate-per-vehicle (a loosening, not a redesign). - **Currency conversion (decided 2026-08-06):** original currency is truth —
every money event stores amount + currency as entered; converted values are
never stored (same derive-don't-store rule as aggregates). One workspace
`base_currency`. Sparse manual `fx_rate(currency, date, rate_to_base)` table,
append-only; lookup = latest rate ≤ event date; a missing rate is _surfaced_
("N events need a rate"), never silently 1.0. Convention: cash flows convert at
transaction-date rates, unrealized value (marks) at current/as-of rates — FX
gain/loss correctly lands inside base-currency performance. Holdings whose
flows share one currency compute natively; conversion enters only at roll-up.
Auto rate fetch is a later BYOK provider; manual entry at check-time is fine
and audit-friendly at our scale. - **The follow-on decision is a new deal** — "one deal = one opportunity" means a
pro-rata decision enters the pipeline with its own judgment trail and can be
Passed without touching the original holding. Banked alongside: structured
**deal-rights capture** (pro-rata, information rights, board/observer, MFN) —
prose until the follow-on flow needs them as data.
**LP-portal extension doctrine (recorded 2026-08, demand-gated, after this
phase proves out):** LPs are never workspace members — not even a read-only role
(hiding the workspace behind filters is one missed WHERE clause from leaking deal
flow and other LPs' data). LPs are _data_ (contacts linked to commitments);
access is **publish-don't-expose**: the GP publishes immutable snapshots
(quarterly statement, capital-account roll-forward, docs) and any portal reads
only published snapshots via tokenized links (the invite/founder-link pattern) —
never live tables. Forced sequence: capital ledger lite → published statements →
portal login. Valuations nuance, restated: marks (with basis + date) are core to
this phase; the valuations _ceremony_ (IPEV/ASC-820 committee workflows, audit
packets) stays fenced. Tax/compliance is permanently export-only.
**Deliberately not in this phase (TagHash-scale fund admin):** capital ledger
(commitments/drawdowns/notices), fund-level NAV statements, multi-vehicle/SPV
structures, LP reporting (standing non-goal), FoF look-through (wrong customer),
MIS collection. A lightweight single-vehicle capital ledger may earn a later slot
if fund-I customers ask; nothing else on that list should.
15b. **Tasks + Today page (decided 2026-08-07; tasks pulled ahead, built now —
Today page follows post-phase-15).** The known gap the Edda survey flagged,
made concrete: **Parked ("Early — revisit") is a silent grave** — nothing
resurfaces a parked deal; tasks are the resurrection machinery ("revisit
when their round closes"), plus diligence chores and portfolio hygiene.
Model: plain `task` table (content, nullable due_date, assignee,
done_at, created_by) + `task_entity` join — deliberately NOT an entity
kind (no backlinks/search/mentions payload; kinds stay fixed) and not
attributes. **Composer-first UX, Attio's create-bar as the reference**
(screenshots reviewed 2026-08-07): one-line input; pills for due date
(natural-language parse — deterministic parser, not AI — plus
Today/Tomorrow/Next week/**No date** chips; dateless tasks are legal),
assignee (defaults to creator), linked records (existing entity
search); Create-more toggle; global `t` shortcut. Mention-in-content
(`@Pixxel` auto-linking the record) is the v2 nicety once the composer
reuses mention infra. **Re-examined 2026-09-14, stays a non-entity** (a
task is a verb against a subject, fails the "would you `[[mention]]` it"
test; `task_entity` + `ENTITY_REFS` + the assembler's `task` ContextKind
already give the graph sight of it; flips to a system _object_ like `deal`
only on a custom-fields / task-views ask). **Decided: tasks join the Cmd-K
search union** as a fourth RRF CTE over `task.content` (ts_rank), hits
route to /tasks with the row focused — a search lane, not a kind. Surfacing: /tasks page grouped by urgency
(overdue/today/this week/later/no date), record-page rails, and — the
self-hosted divergence from Attio — **the Today page is the reminder
channel**, not email: no SMTP by doctrine, so opening the app is the
notification. Optional SMTP daily digest is additive, later, never
required. Skipped from Attio: workflow-generated tasks (no workflow
engine), round-robin (wrong scale). **Overview/Today page banked with
it (2026-08-07): attention-driven, not chart-driven** — overdue/due
tasks as its spine, plus stale marks, missing fx rates, dedupe inbox,
deals idle in stage, compact portfolio strip, activity feed;
getting-started card migrates there until 5/5. A metrics dashboard
answers "how are we doing" (a solo GP knows); the landing page answers
"what needs my attention today." **Shipped 2026-08-08** along with the
dealflow-completeness pass: /today (due tasks · idle active deals >21d
from the stage log · stale marks >180d · missing-fx count · compact
portfolio strip · activity feed; getting-started card migrated here),
login/index now land on /today (setup still lands /spaces where the
markets creator lives), deal **board view** (native-drag stage columns,
table/board toggle, per-column median days-in-stage from
dealFunnelStats), **close_reason** system attribute captured via a
skippable dialog on Passed/Lost board drops, task rails on deal/company
records, and the FX-rates settings section (base currency +
sparse manual rate table). 16. **Ship polish — deferred, scope TBD (2026-08).** No release before this: more dev
work and manual testing come first. CI, images, upgrade CI, install docs get decided
when a release is actually in sight. Still banked from the earlier grill, to reuse
then: rename mechanics first (Angle — domain/npm diligence before images bake the
name in), test-db harness before any CI, upgrade CI only once there is a release to
upgrade _from_. Also banked for launch: a **comparison page** (vs Twenty/Attio/
vertical tools) assembled from the recorded surveys — honest-claims rule: never
claim a storage advantage (Twenty has the same local-default/S3-opt-in answer);
claim the research half, two-container ops, BYOK-to-Ollama, the investor schema,
and the financial engine.

Post-v1 backlog unchanged: dark theme, Playwright preview smoke test, a **capture
extension** (folkX-style, surveyed 2026-08: add a founder/company from LinkedIn without
leaving the page — just another `resolveEntity()` caller pointed at the operator's own
instance; BYOK-shaped by nature), an **MCP server**
over the deal graph (approved 2026-08, explicitly last — a self-hosted graph your own
AI tools can query is stronger under BYOK than under a cloud CRM), then integrations
(each independent): Google Calendar first, Gmail (forward-only), Apollo enrichment (Exa
alongside as a second `Enricher`), BYOK AI features — each adds its own wizard step when
it lands.

Standing debt:

- ~~**Test-db harness.**~~ **Closed 2026-09-19 (SPA-143 then SPA-145).** Kept here because
  it was quoted for a year. The suite used to share the _dev_ database and mutate it, and
  without a live Postgres on :5432 the DB-backed tests failed with `ECONNREFUSED` — recounted
  2026-09-19 on the `mono-1` branch at **23 files / 183 tests, 10 of them DB-coupled, 27 tests
  red** with Postgres down. (The long-quoted "8 of 52" was from 2026-08 and the "21 files, 9
  DB-backed" revision from early September; both were stale enough to mislead.) ~~This is why
  CI cannot simply run `vitest` yet.~~ Superseded 2026-09-01: `.github/workflows/ci.yml`
  already ran vitest against a `pgvector/pgvector:pg17` service container, without the harness
  this entry banked as a prerequisite.
  **`mono-4` (SPA-143): the suite owns `spaces_test`.** A vitest `globalSetup` per package
  (`packages/db/src/test-db.ts` is the shared half) derives `DATABASE_URL_TEST`, defaulting to
  `DATABASE_URL` with `_test` suffixed onto the database name, creates that database on the
  same server if it is absent, migrates it, and — in `apps/web` — seeds the system attributes,
  the starter taxonomy and **one fixture `user` row**, which is the part a "just migrate it"
  harness misses: sites across the DB-coupled files do `select id from user limit 1` and had
  been resolving against whoever logged into the dev app first.
  **`mono-5` (SPA-145): isolation is per file, and structural.** A `setupFiles` entry truncates
  every table in `public` and reseeds before each test file, so what a test writes is invisible
  to the next one and a second run of the suite is identical to the first. `cleanupTestEntities`
  — eleven hand-ordered deletes driven by a regex over `entity.canonical_name`, which could not
  see an attribute, a view or a duplicate_candidate — is deleted. The grain is a database per
  vitest worker (`spaces_test_web1…4`, `spaces_test_db1`), because a truncate must not be able
  to reach a file running at the same moment in another worker; `packages/db` buys the same
  guarantee with `fileParallelism: false` and one database, which is cheaper at four files.
  `spaces_test` itself is now the reference database — migrated and seeded by global setup,
  the one to point `pnpm db:migrate:run` at, and written to by no test.
  `docker-compose.dev.yml` is untouched throughout and
  nothing drops a database. Runtime, 8-core box, warm: `pnpm test` 6.0s against 6.8s before.
- **`./data` ownership landmine.** The Dockerfile `chown`s `/data` at build, but the
  compose bind mount overlays it with host ownership at runtime. Wrong UID on a Linux
  host → cannot write blobs or generate `secret.key`, and it **fails at first upload, not
  at boot**. macOS hides it. Docs need `chown -R 1000:1000 ./data`.
- **Rollback is unsafe and undocumented.** Migrations are forward-only and auto-apply, so
  pulling an older tag runs old code against a new schema. The upgrade doc must say _back
  up first_.
- **No published images yet.** Compose still says `build: .` — installing means building
  on the target box (583MB of node_modules for a 9.3MB `.output`; tight on 2GB RAM, fails
  on 1GB). Phase 11's GHCR multi-arch pipeline is the fix and the biggest adoption win.
- ~~Note deletion~~ **shipped 2026-09-19 (SPA-125)** — hard delete on the registry
  executor; see _The note model_. S3 storage driver, orphan-blob sweep (a finalize that
  never arrives leaves bytes with no row).

## UI craft debt (catalogued 2026-07 · token pass shipped 2026-08)

**The token-and-primitive layer landed** (`9bb23a8` and after): named type steps
(`text-micro` → `text-display` — if a size isn't on the list it doesn't go in the app),
one focus treatment (`focus-ring` / `focus-ring-inset` at full `--ring`; the two old
translucent rings both missed WCAG 2.2's 3:1 non-text floor), the muted ramp resolved to
≥4.5:1 with sub-100% opacities deleted, `.numeric` making the Tabular Rule structural
(tabular + right-aligned in one class), `--row-h` row rhythm, a global
`prefers-reduced-motion` kill switch, and the two-tier colour rule (twelve-hue badge tint
palette under one saturated primary — vermilion then, **Pine green
oklch(0.55 0.14 155) since 2026-08** by owner decision; success re-hued teal to keep
action and state apart). DESIGN.md §2–§3 now match the code; the reasoning also
lives in `src/styles.css` comments — read those before changing any colour.

**Still open, in order:**

- ~~**Old focus rings** (~60, 5 of them in the shell)~~ **Done — swept as Instrument
  landed, slices 11–17 (2026-09).** The count above was already stale when it
  was written: the shell has none, and the reticle (`focus-ring` /
  `focus-ring-inset`) is the only focus treatment on screen. The last shadcn ring in
  the tree, `focus-visible:ring-destructive/20` on the destructive button
  (`src/components/ui/button.tsx`), went with SPA-16 (2026-09-18) — the destructive
  button now focuses with the reticle like every other control. The 11 remaining
  `outline-none` occurrences are each either paired with `focus-ring` or one of the two
  reticle exceptions DESIGN.md records at 2026-09-11. What keeps this swept is no longer
  a grep: `instrument/vocabulary` runs inside `pnpm lint` (see CLAUDE.md gate 5).
- **`/impeccable polish`** for the surfaces above (arbitrary type sizes ride along).
- **`/impeccable document`** to write DESIGN.md §5 (Components) — _after_ the sweep, not before.
- ~~**Dark theme**~~ **Deferred by decision, 2026-09-19 (SPA-52)** — and the deferral is
  now paid rather than compounded. Three artefacts of the unstarted feature were live and
  are gone: the `dark` custom-variant with no dark token values behind it (so every
  `dark:` class anyone wrote was dead), and `next-themes`, whose only use was
  `sonner.tsx` calling `useTheme()` with no `ThemeProvider` mounted anywhere — always
  `'system'`, which handed sonner's own dark styling to an operator on a dark OS, on an
  app with no dark values. The Toaster takes a literal `theme="light"` (its palette was
  already set by four inline `--normal-*` overrides, so nothing renders differently), and
  `:root` declares **`color-scheme: light`**, which is the load-bearing half: every
  native control the app still owns — the date inputs, the scrollbars — is drawn by the
  OS, and without it a dark OS bolted dark chrome onto paper. **The deferral's terms:**
  surfaces stay token-only, enforced by `instrument/vocabulary`, which since SPA-52
  rejects a raw hex or an arbitrary colour value in tsx and names the tokens (reading a
  custom property, `bg-[var(--badge-amber)]`, is the sanctioned form; the tree had zero
  occurrences when the check landed). Dark is therefore later a second token file, not a
  redraw — which is what the forty surfaces about to be written were the deadline for.
  Dark stays on the post-v1 backlog; light-only is a decision with a date, not an
  omission.

**Also carry into any design run:** the deferral list, or an Attio-shaped brief will
propose most of it back. Deferred by name: saved/shared views, bulk edit, calculations row,
CSV, virtualization + keyboard-grid, kanban, drawer-over-table, Overview/Highlight cards.

## Open questions

- ~~**Space page shape.**~~ **Answered, and shipped:** one scrollable page, memo at top — a
  space is something you _read_, not something you administer. Still unresolved is what
  happens when sources and contacts get sections alongside memo · companies · notes.
- ~~**Does a thesis need its own attributes?**~~ Moot — thesis removed 2026-08.
- ~~**Note vs memo vs document.**~~ **Answered 2026-07: one object.** A memo is a note with
  `kind = 'memo'` — same table, same editor, same links. The kind drives presentation and a
  later PDF export, nothing structural. See _Filed vs referenced_.
- **`values jsonb` indexing strategy** for kanban group-by, per the data model section.
  **Re-examined 2026-09-13: moot until server-side filtering exists** — every
  object list is fetched whole and filtered client-side today (no `values->`
  SQL anywhere). When pagination lands: per-attribute expression index on
  `(values->>'slug')` created at attribute creation behind a
  `filterable`/`sortable` flag, not a GIN over the universe.
- ~~**Space page shape** — sources and contacts sections.~~ Sources answered
  2026-09-14: documents file into spaces via `entity_space`. Contacts: people
  tagged into the space or reached through its companies, same collapsed
  pattern; unbuilt.
- **`object.kind` column** — one source of truth for "what machinery" so the
  code-only invariant (core entity kind ↔ object row) becomes structural and
  the first promotion is an `UPDATE`. Cheap now, painful after the first
  promotion. Undecided.
- **Deck reader trigger default** — manual "Read deck" first; auto-on-upload
  toggle once the suggestion inbox UX exists.
- ~~**The 48 decisions the 2026-09-15 reconciliation surfaced.**~~ **All
  closed 2026-09-16/18 — `docs/decisions-2026-09.md` is the ledger.** Ten were
  the owner's; thirty-eight were ratified as recommended on the rule that the
  recommendation was in every case the reversible option and its carrying
  slice is `hitl`, so the judgement is met again in the code. Four change what
  gets built and are recorded where they bite: the ledger correction policy
  (D12, also struck in CLAUDE.md), the read API's `?since=` cursor shipping in
  v1 because adding it later is breaking (D28), `embed(input, { sensitivity })`
  pinned in the first embedding slice so the local slot is additive (D11), and
  the forwarding lane's shape — IMAP poll of an operator-owned mailbox, bodies
  as notes via `interaction.note_id` born `private` and flipped to `shared` on
  attachment, which answers the _Privacy default_ block above (D30 + D31).
- **Relationship attributes** — two-way reference attributes (Attio) vs
  junction custom objects. Junction works today; the reverse rail is raw
  backlinks, not typed. Undecided.
