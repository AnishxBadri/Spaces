# Spec: the plugin SDK (ingestion adapters, the loader, and the registry)

Status: design draft (2026-09-13/14, main-branch deliberation — grilled
against the code, not yet built). Detailed contract behind the CONTEXT.md
"Plugin architecture" decision (which reversed backend-paradigm decision 7).
Builds on: the claim-type lanes (CONTEXT "Machine-write design"), the BYOK
vault, `resolveEntity()`, the Effect ratchet, the AI substrate
(`docs/spec-ai-substrate.md` — AI sits _below_ this SDK, never inside it),
and the hostability contracts. Competitive grounding: Twenty's apps
framework (§1), Grafana's plugin loader and Backstage's extension points
(§7), Nextcloud's install-from-running-instance (§9).

## 1. Stance — plugins feed the graph; they never extend the product

Twenty ships _apps_: custom objects, serverless functions, React components
rendered inside their UI, AI skills — a platform play, Salesforce-shaped.
We ship _ingestion adapters_. A plugin returns **claims**; core routes them
through the existing lanes with the doctrine enforced in the port, not
trusted to the plugin. No plugin React, no plugin db handle, no plugin DDL
in `public.*`. Cost accepted: a third party cannot add a record-page panel
or a new shape of thing — those land in core. That is the ratchet, not a
gap.

Three tiers, by where code runs:

| tier                      | what                                                                    | burden when off                                      |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| 1. registry plugin        | tarball in `/data/plugins`, loaded by the worker at boot                | zero: not on disk, no jobs, no routes, no migrations |
| 2. companion container    | own image on a compose profile, talks to the webhook ingress with a PAT | zero: profile not up                                 |
| 3. third-party in-process | npm loaded at runtime                                                   | **rejected** — see §15                               |

Tier 1 is the plugin architecture. Tier 2 is the escape hatch for foreign
runtimes and ToS exposure (WhatsApp bridge); its design is deferred.

Why "dormant compiled-in" (the reversed decision 7) lost: it zeroes runtime
cost but not image bytes, `node_modules` attack surface, migrations run on
the operator's box, or — decisive — vendor names baked into shared enums.
A plugin cannot ship a migration that edits a shared enum safely, so the
compiled-in model blocked an ecosystem at the schema level.

**The weight test, five costs:**

| cost                         | compiled-in dormant | registry plugin |
| ---------------------------- | ------------------- | --------------- |
| runtime memory / CPU         | 0                   | 0               |
| routes + deps attack surface | deps remain         | 0               |
| image bytes                  | yes                 | 0               |
| migrations on their box      | yes                 | 0               |
| project build / typecheck    | yes                 | plugin repo     |

## 2. Monorepo (Turborepo) and dependency rules

```
apps/
  web/            TanStack Start — routes, components, server-fns. Knows ZERO plugin code.
  worker/         pg-boss host + runJob + plugin loader. The ONLY process that executes plugin code.
  site/           marketing/docs (Vercel). Never in the image.          (later)
  extension/      MV3 capture.                                          (later)
packages/
  db/             drizzle schema, public.* migrations, ENTITY_REFS, migrate
  core/           Effect services: ports/lanes, resolveEntity, setValues, vault, storage, jobs/, ai/
  sdk/            @spaces/sdk — manifest, port interfaces, kind interfaces, claims, definePlugin, testing/
  config/         tsconfig.base, eslint, prettier
plugins/
  apollo/ exa/ rss/ gmail/ google-drive/ …   each imports sdk only; builds to bundle.mjs + manifest.json + migrations/
docker/           Dockerfile (turbo prune --scope=web --scope=worker --docker), compose*.yml, entrypoint.sh
registry.json     plugin index; committed; copied into the image
```

Rules the turbo graph and `no-restricted-imports` enforce:

- `sdk` → `effect`, `zod`. Nothing internal. **If sdk ever needs core, the
  contract leaked.**
- `core` → `db`, `sdk` (it _implements_ sdk's port interfaces). Never `web`.
- `web` → `core`, `sdk` (manifest types only, to render settings/actions).
  Never `plugins/*`, never `worker`.
- `worker` → `core`, `sdk`. Never `plugins/*` at compile time; runtime
  `import()` only.
- `plugins/*` → `sdk`. Never `core`, `db`.
- `db` → nothing internal.

Versioning: changesets; core and each plugin version independently. CI
builds the image on `core@x` tags and a plugin release on
`plugin-<id>@x` tags. The worker gets bundled (tsup) so `src/` + `tsx`
leave the image. Package scope is `@spaces/*` from the first package —
the SDK name is public-facing and the one place the DealOS→Spaces rename
would otherwise bake in.

Migration from today's flat tree, each a shippable PR: workspace scaffold
with everything under `apps/web` unchanged → extract `packages/db`
(verify the drizzle journal path against a dump — a moved journal re-runs
history) → extract `packages/core` (pure libs first; split
`lib/attributes` into registry → core, cell renderers → web) →
`apps/worker` + `runJob` + `packages/sdk` skeleton → test-db harness
(forced by per-package vitest) + Dockerfile prune → `plugins/apollo`.
`packages/ui` waits for `apps/site`; a premature package is churn.

## 3. Manifest

`manifest.json`, validated by a zod schema exported from the SDK. Web
renders settings cards and record actions from it without loading the
bundle.

```ts
{
  manifestVersion: 1,
  id: 'apollo',                          // the source_ref slug; immutable
  version: '1.2.0',
  sdk: '^1.0',                           // semver range against SDK_VERSION
  kind: 'enricher',                      // §5
  name, description, icon?,
  requires: {
    credential?: { kind: 'enrichment' | 'search' | 'llm', scope: 'workspace' },
    connection?: { provider: 'google', scopes: ['drive.readonly'] },   // §12
  },
  settings: ZodSchema,                   // operator config; rendered by web; typed Config port
  jobs: {
    [name]: { schedule?: cron, concurrency?: n, timeout?: '60s', retry?: n,
              on?: ['entity.created'], interactive?: boolean }
  },
  ingress?: { signature: 'hmac-sha256' | 'none' },       // §11
  actions?: [{ id, label, on: 'company' | 'person' | 'deal', job }],  // "Enrich" button, rendered by web
  http?: { rateLimit?: { rpm: n } },
  sensitivity?: 'inherit',               // storage-source bindings may override per binding
}
```

Slug frozen after first publish (the attribute-slug rule). `sdk` decides
compat at load; `manifestVersion` decides whether web can render it.

## 4. Ports — the SDK contract

Effect service tags. A plugin _imports the interfaces_; core _implements_
them over the real DB; the loader _provides_ the implementations bound to
one `integration` row. The plugin never links against core.

| port           | methods                                           | lane / doctrine enforced inside                                                          |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Identity`     | `resolve(kind, keys, name?)`, `addAlias`          | `resolveEntity`; identity collisions → `duplicate_candidate`, never an error             |
| `Facts`        | `fill(entityId, values)`                          | `setValues`, fill-blanks only; conflict with a human value → suggestion                  |
| `Content`      | `fileDocument`, `logInteraction`, `emitSignal`    | document pipeline / `interaction` / `signal`                                             |
| `Judgment`     | `suggest(claim)`                                  | review inbox; never a silent write                                                       |
| `Receipts`     | `store(entityId, raw)`                            | `enrichment_record` — the provenance anchor                                              |
| `Ai`           | `complete(lane, items, schema?)`                  | AI substrate: lane routing, sensitivity gate, cost attributed to this integration        |
| `Read`         | `entity(id)`, `search(q)`, later `context(id, …)` | `canRead` as actor `integration` — private notes never visible                           |
| `Secrets`      | `get()`, `accessToken()`                          | vault decrypt in the worker only; scoped to this row's credential / connection           |
| `Config`       | `get()`                                           | `integration.config`, typed by `manifest.settings`                                       |
| `PluginDb`     | drizzle scoped to schema `plugin_<id>`            | own tables; cannot see `public.*` DDL                                                    |
| `Http`         | rate-limited fetch                                | header-driven throttle (`Retry-After`, `X-RateLimit-*`), receipts logged, no raw `fetch` |
| `Log`, `Clock` |                                                   | prefixed `[plugin:<id>]`                                                                 |

**Provenance is stamped by the port, not the plugin.** Every write carries
`source_class: integration, source_ref: <integration.id>` and
`attribute_event.actor_type: integration` (§8). A plugin cannot forge who
wrote what.

**Ports are granted per (integration, job), by kind.** The Layer the loader
builds is the privilege boundary; the job's `R` type documents it; a
bundle that lies in its types gets a runtime "service not found" because
the host never handed the service over.

| kind             | ports granted                                                     |
| ---------------- | ----------------------------------------------------------------- |
| `enricher`       | Identity, Facts, Receipts, Http, Secrets, Config, Read, Log       |
| `researcher`     | Read, Content, Ai, Judgment, Http, Secrets, Config, Log           |
| `syncer`         | Identity, Content, Judgment, Http, Secrets, Config, PluginDb, Log |
| `ingress`        | Identity, Content, Judgment, Config, PluginDb, Log                |
| `importer`       | Identity, Facts, Content, Judgment, Config, Log                   |
| `poller`         | Content, Ai (classify only), Http, Config, PluginDb, Log          |
| `storage-source` | Content, Http, Secrets, Config, PluginDb, Log                     |

Only `researcher` calls `Ai` freely; storage sources never do — core's
`document.extracted` event fires core features (AI substrate §3 of that
spec). Per job, not per plugin: Apollo `enrich` gets `Facts`; Apollo
`estimateCost` gets only `Http`. Layer built per `(integration, job)`,
cached.

**Worked example — Exa (`researcher`):**

```ts
research: ({ entityId }) =>
  Effect.gen(function* () {
    const cfg = yield* Config // { maxResults, lookbackDays }
    const http = yield* Http // key injected under the hood
    const read = yield* Read
    const co = yield* read.entity(entityId) // name + domain from aliases
    const hits = yield* http.post('https://api.exa.ai/search', {
      query: co.name,
      numResults: cfg.maxResults,
    })
    const content = yield* Content
    for (const h of hits)
      yield* content.emitSignal({
        entityId,
        kind: 'web',
        url: h.url,
        title: h.title,
        publishedAt: h.date,
      })
    const ai = yield* Ai
    const brief = yield* ai.complete('synthesize', toContextItems(hits))
    const judge = yield* Judgment
    yield* judge.suggest({
      entityId,
      kind: 'note',
      body: brief,
      rationale: 'Exa web research',
      refs: hits.map((h) => h.url),
    })
  })
// R = Config | Http | Read | Content | Ai | Judgment. No Facts, no Identity — research never fills fields.
```

The loader provides, for this row:

```ts
Layer.mergeAll(
  ConfigLive(row.config, manifest.settings),
  SecretsLive(row.credentialId),
  HttpLive({ integrationId: row.id, rateLimit: manifest.http }),
  ReadLive({ actor: { type: 'integration', id: row.id } }),
  ContentLive({ source: { class: 'integration', ref: row.id } }),
  AiLive({ callerId: row.id, sensitivityGate: true }),
  JudgmentLive({ proposedBy: row.id }),
  LogLive('[plugin:exa]'),
)
// FactsLive absent — by kind table, not by trust.
```

## 5. Kinds, interfaces, claims

Each `kind` is a typed interface the bundle must implement. All return
**claims**, never writes; core routes claims to lanes.

```ts
enricher:       { enrichCompany(input) → Claim[]; enrichPerson(input) → Claim[]; estimateCost(n) → { credits } }
researcher:     { research(entityId) → Claim[] }
syncer:         { pull(cursor) → { claims: Claim[]; nextCursor } }              // Gmail, Calendar
ingress:        { verify(req) → boolean; handle(payload) → Claim[] }            // call recorders
importer:       { parse(file) → Claim[] }                                       // CSV, WhatsApp export
poller:         { poll() → Item[] }                                             // RSS
storage-source: { resolveLink(url); listFolder(id, cursor?); getFile(id); changes(cursor);
                  putFile(folderId, name, stream); move; rename; ensureFolder(path); pickerConfig() }

Claim = Identity | Fact | Content | Judgment
```

`storage-source` plugins never decide filing — core's `resolveItem`
(storage design, CONTEXT "Storage sources") maps folders to entities;
the plugin is a bytes pipe with hints (`source_path`, folder names).

The existing `Enricher` interface stays as the `enricher` port; the
manifest wraps it.

## 6. `definePlugin()` and the testing kit

The one export a bundle has:

```ts
export default definePlugin({
  manifest,
  jobs: { enrich: (input) => Effect.gen(function* () { … }) },
  onEnable, onDisable,
})
```

Returns a `Plugin` value; the loader wraps it into a scoped Layer and
registers jobs under `plugin.<id>.<job>`.

`@spaces/sdk/testing`: in-memory port Layers (`IdentityTest`, `FactsTest`,
…) that record claims. A plugin author tests "given this provider JSON, it
emits these claims" with no Postgres and no network. Core uses the same kit
to test the loader.

Authoring loop: `pnpm create spaces-plugin` → template (manifest + one job

- test) → `spaces plugin dev ./plugins/apollo` symlinks the workspace build
  into a local `/data/plugins` → same loader as prod → `pack` → tarball +
  sha + sig → registry.

**SDK versioning.** Own semver. New port method or kind = minor; changed
signature = major. Core exports `SDK_VERSION`; the loader checks
`manifest.sdk`. Core keeps a shim Layer one major back so a core bump does
not strand plugins overnight.

## 7. Loader — files on disk → running jobs

~200 lines in `apps/worker`. Runs on boot and on `NOTIFY plugin_changed`.
Grafana's discovery → bootstrap → validation → initialization, same beats.

```
1. discover    integration rows where enabled = true
2. locate      /data/plugins/<id>/current/{manifest.json, bundle.mjs}
3. validate    manifest zod-parses; manifest.sdk satisfies SDK_VERSION; bundle sha matches lock.json
4. import      const plugin = (await import(pathToFileURL(bundle))).default
5. migrate     plugin/migrations/* in schema plugin_<id>, own journal table
6. wire        Layer per (integration, job): ports allowed by kind, bound to row, credential, config
7. register    boss.work('plugin.<id>.<job>', runJob(plugin.jobs[job], layer)); boss.schedule(...);
               ingress → row flag so web mounts /api/webhooks/<id>
8. mark        integration.status = enabled | degraded (+ reason)
```

Any failed step → `degraded` with the reason, jobs skipped, **boot
continues**. A plugin never crashes the box. Disable / upgrade = reverse:
unregister queues, release the Layer scope, forget the module. Hot reload
is in-process (Effect scopes release cleanly); fallback is worker exit code
75, which the entrypoint treats as reload, not crash.

What the loader is not: not a package manager (the installer, §9, moves
bytes); not a sandbox (trust comes from signing); never in web.

## 8. The `integration` row, the enum collapse, the typed actor

```
integration(id, capability_id /* manifest.id */, version, enabled, status: installing | enabled | degraded | disabled,
            config jsonb, credential_id?, connection_id?, error_count, last_run_at, last_error, created_by, created_at)
```

Capability = code (what it _can_ do, the registry array). Integration =
row (what the host _did_). The row is the `source_ref` target and the typed
actor target.

**Enum collapse (before Apollo lands).** `entity_source`, `alias_source`,
`interaction_source`, `document_origin` bake gmail/apollo/clip; `credential`,
`account_connection`, `signal` already carry open `provider` text with class
in a separate enum. Converge:

```
source_class enum: manual | integration | ai | import | seed | merge | extracted | inherited
source_ref   uuid → integration.id   (null unless class = integration)
```

One migration, backfill from the old values, one code branch in
`resolve.ts`. `link_source` and `tag_source` are already pure class enums;
keep. `attribute_event.actor_type: user | integration | system` +
`actor_ref` (attribute-engine spec §4) points at the same row.

Plugin-owned tables live in Postgres schema `plugin_<id>.*` with their own
migration journal; FK to `public.entity.id` allowed (plugin depends on
core); no FK from `public.*` to a plugin schema (core never depends on a
plugin); shared-enum edits impossible by construction. Uninstall =
optional `DROP SCHEMA`.

## 9. Registry, signing, install from the running deployment

```
registry.json  [{ id, version, sdk, kind, name, description, requires,
                  tarball: url, sha256, sig, minCore? }]
```

v0: tarballs on GitHub Releases, index committed in-repo and copied into
the image (offline installs see the shipped list; live refresh when
outbound HTTPS exists). v1 upgrade: OCI artifacts in GHCR (one auth, one
mirror story) — not now.

**Install flow, admin only, no redeploy:**

```
Settings → Integrations → Available → [Install]
  web:    fetch tarball (or accept an uploaded .tgz — air-gapped) → verify sha256 + signature
          → unpack /data/plugins/<id>/<version>/ → symlink current → write lock.json
          → insert integration(status: installing) → NOTIFY plugin_changed
  worker: loader §7 → status enabled
  web:    card renders manifest.settings + the credential field from requires.credential
          → operator pastes the key → vault → status enabled, actions appear
```

Web moves bytes and writes rows; it never executes plugin code.
`SPACES_PLUGINS=apollo,rss` is an optional first-boot convenience that runs
the same installer; `SPACES_CREDENTIAL_<ID>=…` seeds the vault once, then
is ignored (env is an input to the vault, never the store). Required env
stays `{DATABASE_URL, APP_URL}`.

Trust: in-process Node has no sandbox. v1 loads first-party signed tarballs
only; `--allow-unsigned` for development. Third-party or ToS-exposed code
→ tier 2 companion.

Same page: Installed (version, status, last run, last error, credits),
update badge → one click, disable (key kept), uninstall (key deleted,
schema optionally dropped, files removed).

## 10. Hosting lifecycle

```
image                      core web + worker + loader + registry.json snapshot. No plugins.
./data/blobs               existing
./data/secret.key          existing
./data/plugins/<id>/<ver>/ bundle.mjs · manifest.json · migrations/     (+ current symlink)
./data/plugins/lock.json   { core: '1.4.0', plugins: { apollo: '1.2.0' } }
postgres public.*          core
postgres plugin_<id>.*     plugin, own journal
integration                enabled rows
```

`/data` is already the backup unit, so **backup/restore covers plugin code
and versions with zero new steps**; "both-or-neither" (hostability
contract 5) stays true.

- **Boot reconciliation**, every start, idempotent: row present + files
  present + sdk satisfied → enabled; else `degraded` with the reason.
  `/api/health` lists degraded plugins; a `worker_heartbeat` row makes
  `ROLE=worker` containers checkable (contract 4).
- **Core upgrade**: `backup → pull → up`, unchanged. Plugin bytes untouched.
  sdk minor → plugins load; sdk major → incompatible plugins degrade with
  the fix named from the bundled registry snapshot.
  `SPACES_PLUGINS_AUTOUPDATE=compatible` (default off) fetches the newest
  satisfying version on boot; off = UI badge.
- **Plugin upgrade**, independent: fetch → verify → new version dir → its
  migrations (forward-only, its schema) → swap `current` → reload Layer.
  Previous dir kept one back; `plugin rollback` is safe only if no
  migration ran, else restore.
- **Rollback of either = restore** (contract 5). Never an older image
  against a newer schema; never an older plugin against its newer schema.
- **Split roles** (`ROLE=web` + `ROLE=worker`): both mount `/data`;
  `NOTIFY` crosses processes via Postgres. Same flow.
- Three sources of truth, reconciled at boot: DB row = intent (enabled),
  disk = code present, `lock.json` = pinned versions for reproducibility.

## 11. Workers and jobs

pg-boss stays the queue (paradigm decision 6). The worker is a plain Node
process; handlers become Effect programs run by one wrapper:

```ts
JobDef { name, schema: zod, run: (data) → Effect<void, JobError, Ports>, retry, timeout, concurrency }
runJob = parse job.data → provide Layer → Effect.runPromise → map typed failure to complete | retry | fail
```

Core jobs and plugin jobs use the same wrapper; only the Layer differs.
Queue names encode ownership: `core.<domain>.<verb>` vs
`plugin.<id>.<job>` — also what the breaker groups on.

**Every plugin invocation is a job.** Three triggers, all landing in
pg-boss:

| trigger  | example                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| manual   | `actions[]` → "Enrich" button → `enqueue('plugin.apollo.enrich', { entityId })`                                                                                                 |
| schedule | `manifest.jobs[].schedule` → `boss.schedule`                                                                                                                                    |
| event    | `on: ['entity.created']` — core write paths emit domain events; a dispatcher maps them to jobs. Attio's enrich-on-create is this implicit trigger, not a different architecture |

This is the whole "workflow engine" we will ever have: declarative in
manifests, never a UI (the tasks decision already rejected a builder).

- **Interactive jobs** (`interactive: true`): own priority queue, low batch,
  short timeout. Status via `LISTEN/NOTIFY job_status → SSE` to the record
  page; the cell shows "Enriching… → Apollo says X, accept?". No polling.
- **`query` kind (narrow, read-only, budgeted)**: request/reply over
  pg-boss — web sends, awaits NOTIFY with the reply, 3s budget. For "search
  Exa inside a picker". Works unchanged in split-role deployments; a
  worker localhost HTTP would not.
- **Ingress**: web verifies the manifest-declared signature (generic HMAC,
  no plugin code), stores the raw payload, enqueues `plugin.<id>.ingest`,
  returns 200 in ms. Route mounted only for enabled rows — disabled → 404.
- **Isolation**: contract 2 (worker death kills the container) means an
  uncaught throw must be impossible past the wrapper. Failure → retry with
  backoff → after N, fail + `integration.error_count++`. Breaker: N
  failures/hour → auto-disable the plugin, surface on Today. Never the
  worker.
- **Not a job**: core sync features (search, single-cell `Ai.complete`,
  mandate hint, page context) run in web, request-scoped, with a timeout.
  `packages/core` is shared by both processes, so the `Ai` port exists in
  web too. Only _plugins_ are worker-only.
- **Cost of the rule**: a plugin can never render inline in a request.
  Every plugin result arrives as a table row + notification. Same
  constraint that gives provenance and zero web-side plugin code; matches
  "machine writes are suggestions, pull-based, never silent". Mitigation:
  eager event jobs on create + the SSE stream, so "later" is usually under
  a second.

```
job_run(id, queue, integration_id?, entity_id?, status, started_at, finished_at, error, tokens?)
```

One table, three consumers: the interactive status stream, the
Integrations page "last run", later the AI run log.

## 12. Vault, connections, providers

- **Pasted API keys → workspace-scoped `credential`.** Decided 2026-09-14:
  the per-user credential scope stays in the schema (resolution order
  `user → workspace → none` is already coded) but v1 UI exposes workspace
  only. A scheduled job needs a deterministic answer to "whose key"; the
  workspace key is it. Manifest declares `requires.credential.scope:
'workspace'` by default.
- **OAuth grants → per-user `account_connection`**, unavoidable: it is
  _their_ Gmail/Drive. One row per user per provider; `scopes[]` grow
  incrementally (connecting Calendar never grants Gmail).
- **Suites are providers, not integrations.** `provider: google` = one
  OAuth app the operator registers once (client id/secret → workspace
  `credential(kind: oauth_client)`); `login` (core OIDC), `gmail`,
  `calendar` (syncers), `google-drive` (storage-source) hang under it.
  `box`/`dropbox` = providers with one plugin each. Same machinery,
  different fan-out.
- **The OAuth dance lives in core, once, per provider**: redirect URI from
  `APP_URL`, PKCE, refresh, encryption, revocation. Plugins never implement
  OAuth; they declare `requires.connection: { provider, scopes }` and get a
  fresh access token from `Secrets.accessToken()` at job time.
- Provider registry (auth URLs, scope vocabulary) is a small table in code.
- Bindings run on the binder's connection; binder leaves → binding `error`,
  data already copied stays, admin re-binds.
- Only admins install/update/disable plugins and hold workspace keys
  (`requireAdmin()` already gates settings). Members get the actions and
  their own connections. A future `viewer` gets neither.

## 13. Testing

Layered; most value never touches a provider.

1. **Claims are data → unit tests.** `@spaces/sdk/testing` in-memory ports;
   feed fake provider JSON, snapshot the claims. Every PR.
2. **Provider fakes, in-repo.** Recorded cassettes (`msw`/`nock`, secrets
   scrubbed) for stateless APIs (Apollo, Exa); small fake servers
   (`packages/fakes/drive|box|gmail`) implementing only the endpoints the
   port uses, seeded with a fixture tree, mutable — so change detection,
   rename, revision, loop prevention are testable. `SPACES_FAKE_PROVIDERS=1`
   points every plugin at them: the dev and demo environment. A fake OAuth
   IdP (`mock-oauth2-server` image) for the consent flow.
3. **Port conformance suite.** One shared test per port run against every
   implementation (`StorageSource` × drive/box/dropbox on their fakes) —
   the `Storage`-driver-against-MinIO pattern. A provider plugin passes or
   does not ship.
4. **Pipeline tests, provider-agnostic.** Stream + metadata → document
   pipeline: blob, row, edges, unfiled inbox, extraction, GC. `Fact` claim
   → `setValues`: fill-blanks, conflict → suggestion, actor stamping. Needs
   the test-db harness (standing debt; forced by the monorepo split).
5. **Loader + jobs.** Fixture plugins in `plugins/_fixtures/`: `echo`,
   `throws` (breaker), `old-sdk` (degraded), `needs-key`. Boot the loader on
   a temp dir; assert `integration.status`, registered queues, Layer
   privilege (a `poller` calling `Facts` → "service not found"). pg-boss on
   the test DB for enqueue → run → status stream.
6. **Real sandboxes, nightly, opt-in.** Dedicated Google Cloud project + Box
   developer account, secrets in CI, conformance for real; failures open an
   issue, never block PRs.
7. **Chaos list, via fakes:** 429 with `Retry-After`, token revoked
   mid-sync, half a batch failing, webhook delivered twice, file deleted
   between list and get, Google Doc export, 200MB file, cursor expired
   (Drive 410).
8. **Browser E2E** (Playwright, standing want): upload → preview; connect
   Drive (fake IdP) → pick → filed.

## 14. Build order

1. `packages/sdk`: manifest, ports, kinds, claims, `definePlugin`, testing
   kit. `runJob` in the worker; move `extractDocument` onto it (first
   Effect tenant). Loader reading a plugins dir. `worker_heartbeat`.
2. `integration` table; `source_class`/`source_ref` collapse; typed actor.
   `job_run`.
3. Apollo as `plugins/apollo`, loaded by path in dev through the same
   loader. Enrich-on-create as the first event trigger; Integrations page
   (installed / available / upload); interactive SSE status.
4. Registry fetch, signing, install-from-UI. `SPACES_PLUGINS`.
5. Provider registry + OAuth in core; `account_connection` UI; first
   syncer (Calendar, then Gmail forward-only).
6. Plugin schemas with the first plugin that needs tables (RSS); then
   `storage-source` (Google Drive), `storage_binding`, `document_revision`.
7. Shim Layer one sdk major back — when the first sdk major ships.

Sequencing rationale unchanged from the integration map: inbound arrival
first, enrichment second, calendar/recordings third.

## 15. Deferred, with the reason on record

- **Companion containers (tier 2)** — the WhatsApp bridge shape is
  deliberated in CONTEXT; a `kind: 'companion'` manifest row with a
  heartbeat via ingress is the likely form. Designed when the first one is
  near.
- **Third-party in-process plugins (tier 3)** — rejected: no Node sandbox,
  supply-chain exposure on a self-hosted box. MCP + webhooks + API +
  companions cover "extend from outside".
- **Per-user credential UI** — schema and resolution exist; UI waits for a
  real ask (cost attribution has a cheaper answer in `ai_usage`;
  sensitivity routes per record, not per user).
- **`llm-provider` kind** — a manifest kind exposing only an AI SDK
  `LanguageModel` factory (Bedrock/Vertex/Azure). AI is substrate, not
  integration; providers are core adapters until someone asks.
- **Plugin-requested custom objects** — a manifest may _request_ an object
  by shape, created on enable as an ordinary user-owned attribute-bag
  object so plugin data is graph-visible without plugin UI (copied from
  Twenty). Noted, not built.
- **Hot reload vs restart** — ship in-process reload with the exit-75
  fallback; revisit if pg-boss registration proves fragile.
- **Eager Drive folder creation on deal birth** — lazy `ensureFolder` on
  first document ships; the eager toggle waits for a Drive-first fund to
  ask.
- **OCI-artifact registry** — v1 upgrade over GitHub Releases; same loader.
