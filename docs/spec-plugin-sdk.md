# Spec: the plugin SDK (ingestion adapters, the loader, and the registry)

Status: design draft (2026-09-13/14, main-branch deliberation — grilled
against the code, not yet built). **Amended 2026-09-30 at project 17's
publish (`docs/decisions.md` → Addenda 2026-09-30, D51–D58): kinds
are gone — each job declares a trigger and the ports it uses (§3–§5); a job
calls ports, it does not return claims (§5); plugin signing mechanics (§9).**
Detailed contract behind the CONTEXT.md
"Plugin architecture" decision (which reversed backend-paradigm decision 7).
Builds on: the claim-type lanes (CONTEXT "Machine-write design"), the BYOK
vault, `resolveEntity()`, the Effect ratchet, the AI substrate
(`spec-ai-substrate.md` (removed) — AI sits _below_ this SDK, never inside it),
and the hostability contracts. Competitive grounding: Twenty's apps
framework (§1), Grafana's plugin loader and Backstage's extension points
(§7), Nextcloud's install-from-running-instance (§9).

## 1. Stance — plugins feed the graph; they never extend the product

Twenty ships _apps_: custom objects, serverless functions, React components
rendered inside their UI, AI skills — a platform play, Salesforce-shaped.
We ship _ingestion adapters_. A plugin writes **claims** through ports, and
each port routes them into the existing lanes with the doctrine enforced in
the port, not trusted to the plugin. No plugin React, no plugin db handle, no plugin DDL
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
  sdk/            @spaces/sdk — manifest, port interfaces, trigger shapes, claims, definePlugin, testing/
  config/         tsconfig.base, eslint, prettier
plugins/
  apollo/ exa/ rss/ gmail/ google-drive/ …   each imports sdk only; builds to bundle.mjs + manifest.json + migrations/
docker/           Dockerfile (turbo prune --scope=web --scope=worker --docker), compose*.yml, entrypoint.sh
registry.json     plugin index; committed; copied into the image
```

Rules the turbo graph and `no-restricted-imports` enforce:

- `sdk` → `effect`, `zod`, `tldts` (D55: the identity normalizers need the
  public suffix list; a test pins this list). Nothing internal. **If sdk ever
  needs core, the contract leaked.**
- `core` → `db`, `sdk` (it _implements_ sdk's port interfaces). Never `web`.
- `web` → `core`, `sdk` (manifest types only, to render settings/actions).
  Never `plugins/*`, never `worker`.
- `worker` → `core`, `sdk`. Never `plugins/*` at compile time; runtime
  `import()` only.
- `plugins/*` → `sdk`. Never `core`, `db`.
- `db` → nothing internal.

Versioning: changesets; core and each plugin version independently. CI
builds the image on `core@x` tags and a plugin release on
`plugin-<id>@x` tags. The worker gets bundled (`vite build --ssr` — D26,
decided 2026-09-29; this line said tsup until SPA-185 built it) so `src/`

- `tsx` leave the image. Package scope is `@spaces/*` from the first package —
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
  name, description, icon?,
  roles?: ['enrichment' | 'research' | 'email-calendar' | 'files'
           | 'meeting-notes' | 'import' | 'feeds'],   // catalogue grouping (D81, SDK 1.4)
  requires: {
    credential?: { kind: 'enrichment' | 'search' | 'llm', scope: 'workspace' },
    connection?: { provider: 'google', scopes: ['drive.readonly'] },   // §12
  },
  settings: ZodSchema,                   // operator config; rendered by web; typed Config port
  jobs: {
    [name]: {
      trigger: 'action' | 'schedule' | 'event' | 'webhook' | 'file',   // §5 — fixes the job's input/output
      uses: ['Identity', 'Facts', 'Http', …],                          // §4 — the ports this job is granted
      schedule?: cron,                   // trigger = schedule
      on?: ['entity.created'],           // trigger = event
      accepts?: { filename: regex },     // trigger = file — which dropped files web routes to it (SDK 1.1)
      concurrency?: n, timeout?: '60s', retry?: n, interactive?: boolean,
    }
  },
  ingress?: { signature: 'hmac-sha256' | 'none' },       // §11 — any job with trigger = webhook
  actions?: [{ id, label, on: 'company' | 'person' | 'deal', job }],  // "Enrich" button → an action-trigger job
  http?: { rateLimit?: { rpm: n } },
  provides?: 'storage-source',           // §5 — a provider interface core calls into; not a job
  mcp?: { url: https, auth: { header, scheme?: 'Bearer' } },  // D72 — a remote MCP server Ask mounts; needs requires.credential (SDK 1.5)
  sensitivity?: 'inherit',               // storage-source bindings may override per binding
}
```

Slug frozen after first publish (the attribute-slug rule). `sdk` decides
compat at load; `manifestVersion` decides whether web can render it. There
is no plugin-level `kind` (D51): one plugin may carry a `schedule` job and a
`webhook` job (Gmail), and is still one install, one integration row, one
credential, one breaker.

## 4. Ports — the SDK contract

Effect service tags. A plugin _imports the interfaces_; core _implements_
them over the real DB; the loader _provides_ the implementations bound to
one `integration` row. The plugin never links against core.

| port           | methods                                           | lane / doctrine enforced inside                                                                      |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Identity`     | `resolve(kind, keys, name?)`, `addAlias`          | `resolveEntity`; identity collisions → `duplicate_candidate`, never an error                         |
| `Facts`        | `fill(entityId, values)`                          | `setValues`, fill-blanks only; conflict with a human value → suggestion                              |
| `Content`      | `fileDocument`, `logInteraction`, `emitSignal`    | document pipeline / `interaction` / `signal`                                                         |
| `Judgment`     | `suggest(claim)`                                  | review inbox; never a silent write                                                                   |
| `Receipts`     | `store(entityId, raw)`                            | `enrichment_record` — the provenance anchor                                                          |
| `Import`       | `stage({ columns, rows })`                        | lands a grid in the waiting `import_batch`; mapping, preview and commit stay core's (SDK 1.1)        |
| `Spaces`       | `brief(spaceId)`                                  | read-only, as actor `integration`; the space as data (D71/D72); sensitive or archived refuses (1.5)  |
| `Discover`     | `candidate(claim)`                                | a watch's found company → a card, never a record or a deal (D72); declared in 1.5, no live port yet  |
| `Ai`           | `complete(lane, items, schema?)`                  | AI substrate: lane routing, sensitivity gate, cost attributed to this integration                    |
| `Read`         | `entity(id)`, `search(q)`, later `context(id, …)` | `canRead` as actor `integration` — private notes never visible; `search` lexical + fuzzy in v1 (D56) |
| `Secrets`      | `get()`, `accessToken()`                          | vault decrypt in the worker only; scoped to this row's credential / connection                       |
| `Config`       | `get()`                                           | `integration.config`, typed by `manifest.settings`                                                   |
| `PluginDb`     | drizzle scoped to schema `plugin_<id>`            | own tables; cannot see `public.*` DDL                                                                |
| `Http`         | rate-limited fetch                                | header-driven throttle (`Retry-After`, `X-RateLimit-*`), receipts logged, no raw `fetch`             |
| `Log`, `Clock` |                                                   | prefixed `[plugin:<id>]`                                                                             |

**Provenance is stamped by the port, not the plugin.** Every write carries
`source_class: integration, source_ref: <integration.id>` and
`attribute_event.actor_type: integration` (§8). A plugin cannot forge who
wrote what.

**Ports are granted per (integration, job), by declaration (D51).** Each
job lists the ports it uses (`jobs[name].uses`); the admin sees that list at
install, like OAuth scopes; the Layer the loader builds holds exactly those
ports and is the privilege boundary; the job's `R` type documents it and a
job that yields a port it did not declare fails typecheck. A bundle that
lies in its types gets a runtime "service not found" because the host never
handed the service over. This replaced a frozen kind → ports table: v1
loads first-party signed plugins only (§9), so the grant is a guardrail
against bugs and a readout for the admin, not a sandbox — the doctrine that
matters (fill-blanks only, conflicts become suggestions, provenance stamped
by the port) lives inside the ports whatever the job declares. Layer built
per `(integration, job)`, cached.

Two limits stay in core rather than in a table: `Ai` is metered and
sensitivity-gated by the port whoever calls it (AI substrate spec), and a
`storage-source` provider never calls `Ai` — core's `document.extracted`
event fires core features on what it files (§5).

**Worked example — Exa, one `action` job** (manifest:
`research: { trigger: 'action', uses: ['Config', 'Http', 'Read', 'Content', 'Ai', 'Judgment', 'Log'] }`).
This is the canonical shape (D52): the job calls ports, each port writes
through its lane at once, and the plugin can react to what a port returns.

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
    const refs: Array<Ref> = []
    for (const h of hits) {
      const { signalId } = yield* content.emitSignal({
        _tag: 'signal',
        entityId,
        kind: 'web',
        url: h.url,
        title: h.title,
        publishedAt: h.date,
      })
      refs.push(`event:${signalId}`) // cite the signal, not the URL (D4)
    }
    const ai = yield* Ai
    const brief = yield* ai.complete('synthesize', toContextItems(hits))
    const judge = yield* Judgment
    yield* judge.suggest({
      entityId,
      proposal: { kind: 'note', body: brief },
      rationale: 'Exa web research',
      refs,
    })
  })
// R = Config | Http | Read | Content | Ai | Judgment. No Facts, no Identity — this job never declared them.
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
// FactsLive absent — the job's `uses` did not name it.
```

## 5. Triggers, port calls, claims (amended 2026-09-30, D51–D53)

There are no plugin kinds. A job declares a **trigger**, and the trigger
fixes what the job is handed and what it hands back. The set is closed and
semver-frozen with the SDK; a new trigger is a minor.

```ts
action:   run | { run, cost? }                                        // manifest actions[] — the "Enrich" button
            run:  (input: { entityId }) → Effect<void, JobError, R>
            cost: (input: { entityIds, fields? }) → { credits: number }   // D53, pure, action jobs only
          with `input: 'payload'`: (input: { payload: JsonObject }) → Effect<void, JobError, R>   // host-prepared, no record: Send (D67, SDK 1.5)
schedule: (input: { cursor: string | null }) → Effect<{ nextCursor: string | null }, JobError, R>   // Gmail, Calendar
event:    (input: { event: DomainEvent }) → Effect<void, JobError, R>  // on: ['entity.created'] — enrich-on-create
webhook:  (input: { payload, receivedAt }) → Effect<void, JobError, R>  // call recorders; §11 ingress
file:     (input: { stream: ReadableStream<Uint8Array>, filename, mime }) → Effect<void, JobError, R>   // an importer
watch:    (input: { watchId, spaceId, settings, state }) → Effect<{ state }, JobError, R>   // once per space_watch row (D72, SDK 1.5)
```

The types are `packages/sdk/src/contract.ts` (sdk-4a), one file: `JobError`
is `JobRetryable | JobRateLimited | JobPermanent`, the worker's three
`runJob` outcomes under the same tags; `DomainEvent` is closed over
`DOMAIN_EVENTS` (`entity.created` in v1 — the manifest's `on` validates
against it); `PORT_NAMES` is the §4 table minus Clock (Effect ships one) and
is what `uses` validates against.

**A webhook job has no `verify` (checkpoint review, 2026-10-01).** Plugin
code runs only in the worker, after web has already answered the provider's
request, so a plugin-side check could gate nothing; running it in web would
break "web never executes plugin code". Signature checking is
manifest-declared (`ingress.signature`) and done by core in web (sdk-23)
before the payload is stored; the job is handed the stored payload like any
other. If a provider ever needs a plugin-side check, it arrives as an
optional field — a minor; shipping `verify` now and removing it later would
have been a major.

**A job calls ports; it does not return claims (D52).** Each write port
calls its lane at once and returns what the lane decided —
`Identity.resolve` returns the entity id the next call uses, `Facts.fill`
returns the conflicts it refused, `Content.logInteraction` returns the
interaction id. "Claim" survives as the name of the **typed arguments of
the write-port methods** (identity keys, a values record, an interaction, a
signal, a document, a suggestion): that vocabulary is the semver-frozen
surface, and no claim type carries a source, actor, actorType,
integrationId or sourceRef field — provenance is the port's, from the bound
row. There is no batch, no router and no handle grammar: dependency order is
the order the job's code runs in, and each lane keeps its own idempotency
(`resolveEntity` on identity keys, `Facts.fill` inside the row lock,
interactions on `message_id`). An importer of documents (the `file`
trigger) speaks claims through Identity/Facts/Content; a **dialect importer
hands core a grid** through `Import` (D39 as amended 2026-10-06, §5.2).

The claims (sdk-4a): `IdentityClaim { kind: company | person, keys:
{ domain?, email?, linkedin? }, name? }` and `AliasClaim` — a company is
identified by its domain and a person by their email (D75); a LinkedIn URL
identifies neither and only fills a new record's LinkedIn;
`FactClaim { entityId, values, receiptId? }` — `receiptId` is evidence (it
becomes the attribute events' `refs`), not provenance; `ReceiptClaim
{ entityId, raw, creditsUsed? }`; the three Content claims tagged by `_tag`
— `document { body: { stream } | { bytes }, filename, mime, kind?,
fileAgainst, url? }`, `interaction { kind, occurredAt, entityIds (≥1),
subject?, messageId?, threadId?, body? }`, `signal { entityId, kind,
title?, url?, publishedAt?, payload? }`; `JudgmentClaim { entityId,
proposal: { kind: 'note', body } | { kind: 'attribute', slug, value },
rationale, refs }`, where a ref is the shipped grammar (D4) and a URL is
not one — cite the signal it was emitted as.

**Cost (D53).** An `action` job may declare `cost`, a pure function of the
input returning `{ credits }` in the provider's own unit. The host drops
entities with a fresh receipt (90-day cache) first, asks `cost` about the
rest, and refuses before any API call when the estimate does not fit the
integration's remaining daily cap. Spend is counted from
`Receipts.store(…, credits_used)`, never from the estimate; an
under-estimate overruns by at most one batch.

**Storage sources are a provider interface, not a job.** Core calls into
them; they call nothing:

```ts
storage-source: { resolveLink(url); listFolder(id, { cursor?, pageSize? }); getFolder(id);
                  getFile(id); changes(cursor | null); pickerConfig();
                  ensureFolder?(rootId, path); putFile?(folderId, name, { stream, mime, sha256 });
                  move?(id, folderId); rename?(id, name) }   // write half: storage-sources §4 as built
```

A plugin that implements it says `provides: 'storage-source'` in the
manifest. It never decides filing — core's `resolveItem` (storage design,
CONTEXT "Storage sources") maps folders to entities; the plugin is a bytes
pipe with hints (`source_path`, folder names). Its body is owned by the
storage area (project 20).

**As built — the read half (SPA-229).** The read half is typed in
`StorageSource` (`@spaces/sdk`): each method returns an `Effect` failing
with the tagged `NotFound`, `CursorExpired`, `RateLimited { retryAfterMs }`
or `AuthExpired`; `getFile` streams a `ReadableStream<Uint8Array>`; no
member carries a provider hash. The shapes are in
`spec-storage-sources.md` (removed) §4's as-built note. **The grant rule** is the
manifest's: `manifestSchema` refuses a `provides: 'storage-source'` plugin
any job whose `uses` names `Facts` or `Ai` (`STORAGE_SOURCE_WITHHELD`),
naming the rule; every other port in `PORT_NAMES` stays grantable, and
`manifest.test.ts` walks the whole list.

### 5.1 As built (2026-10-01, SPA-200/201/202/203/204)

What the Live ports do beyond the table above, recorded here so the next
reader does not re-derive it from the tests:

- **`Content.emitSignal`** also writes one `signal.emitted` activity row with
  the integration in `meta`; it is how the record timeline shows the signal
  at all ("`<plugin>` reported a signal"). `Content.logInteraction` is the
  mailbox's own writer (`writes/interactions/write.ts`): one row per
  `message_id` through the unique index, a new row each call without one; a
  plugin-written body is born **`private`** (D30) until a syncer decides per
  connection, and the claim carries no visibility field.
- **`Facts.fill`** decides "blank" under the entity row lock (`fillBlanks`
  in `setValuesInTx`): a slug held by anyone other than this integration —
  a person, another integration, the system, or a value with no
  `attribute_event` at all — is a conflict. A conflict is returned to the
  job **and** raised as one open suggestion in the fill's own transaction,
  rationale "`<slug>: <plugin> says <proposed>; the record holds
<existing>`", refs = the receipt. `receiptId` must name a receipt this
  integration stored, or the fill is `JobPermanent`.
- **`Judgment.suggest`** and the raised conflicts are deduped by migration
  0057's partial unique index on open `attribute_patch` rows proposed by an
  integration, keyed on (entity, slugs, values) and **not** on
  `proposed_by_id`: two plugins proposing the same value on one record share
  one open row, and an identical MCP re-proposal returns the existing row.
- **`Content.fileDocument`** is `intakeDocumentProgram` with source
  `integration` + the bound row and actor `{ integrationId }`; the
  `document.filed` activity row carries `actorType`/`integrationId` so the
  timeline names the plugin. A merged-away `fileAgainst` id files on the
  survivor.

### 5.2 The `Import` port — a dialect is a plugin, the pipeline stays core (SDK 1.1.0, D39 amended 2026-10-06)

A dialect (an Airtable CSV export first; Notion and CRM exports later) is a
`file` job that reads the file and calls `Import.stage` once with the grid:

```ts
Import.stage(grid: {
  columns: ReadonlyArray<string>                        // the header, in order
  rows: ReadonlyArray<{
    ordinal: number                                     // 1-based data row — per-row errors name it
    cells: ReadonlyArray<string | ReadonlyArray<string>> // a list cell: a multi-select's labels, several names, several URLs
  }>
}) → Effect<{ batchId, staged, malformed: Array<{ ordinal, reason }>, refused: Array<{ ordinal, reason }> }, JobError>
```

- **Pre-mapping input, never claims.** Core lands the grid in the
  `import_batch` the import wizard is waiting on, and the batch then walks
  the same mapping, preview, commit and batch void (D12) as a hand-mapped
  CSV. The plugin never maps, previews, commits or writes a record; the
  rejected alternative — `Identity.resolve`/`Facts.fill` row by row — loses
  the preview, the batch, batch void and the idempotent re-run.
- **The dialect's work is the plugin's.** For Airtable: comma-joined
  multi-selects are split into lists, linked-record display names are kept
  as names (never resolved to ids in the plugin), attachments arrive as their
  URLs.
- **A list cell lands as text core can read back.** Its items, quoted where
  they hold a separator or a quote, joined with `,` — which reproduces the
  dialect's own cell, so every non-list column reads exactly as the plain CSV
  would, and the multi-select reader splits it back item for item (an option
  label holding a comma included). Every label must still be an existing
  option: an unknown one refuses the cell, never mints an option.
- **Per-row errors stay per-row.** A row the port cannot decode (a cell that
  is neither text nor a list of text, more cells than columns) is staged
  under its ordinal with no cells, returned in `malformed` with its reason,
  and plans as `no-land`; a row it cannot
  place (an ordinal that is not a positive whole number, or one already
  used) is returned in `refused`. The rest of the batch stages and commits.
  A grid with no placeable row fails the job permanently.
- **Idempotent.** A second `stage` into a batch that already holds rows
  writes nothing and answers with what is there.
- **Routing.** The job declares `accepts: { filename }`, a regular expression
  (case-insensitive) on the dropped file's name. Web reads it from
  `integration.manifest` — never from the bundle — and, for a runnable
  integration whose matching `file` job `uses` `Import`, stores the blob,
  creates the waiting batch (status `staged`, no rows) and enqueues
  `plugin.<id>.<job>` with `{ batchId, blobSha, filename, mime }`. The
  worker hands the job the stored bytes as its stream and the batch through
  a run-scoped reference only the `Import` port reads; the run's
  `job_run.summary` is led by `batch <id> · `, as the commit's is. A job
  that fails for good marks the batch `failed`. With no runnable plugin
  matching — the plugin disabled, say — the same file takes the plain CSV
  path and its explicit mapping step.
- **SDK 1.1.0.** `Import`, its claim types and `accepts` are additive: a
  minor. A plugin that uses them declares `sdk: '^1.1'`, so a 1.0 host
  degrades it by range before it parses the manifest.

### 5.3 The `watch` trigger (SDK 1.5, D72)

- A watch job declares its own `settings` (zod, emitted as JSON Schema like the plugin's; `watchSettingsOf` is the typed read). The manifest refuses a watch job without one, `settings` on any other job, and a second watch job: a `space_watch` row names its integration, not a job.
- The worker registers the job's queue `stately` and keys every run by watch id, so one run of a watch waits at a time; beside it, `plugin.<id>.<job>.tick` on a one-minute cron sends each due watch. A watch is due once per slot of `cadence_minutes` counted from the epoch, so "Run now" (`runWatchNow`, sent at once) never moves or eats the next tick; a null cadence is never due. An archived space, or an archived ancestor, pauses both paths.
- The run hands the job `{ watchId, spaceId, settings, state }` and writes the returned `state` in the transaction closing the `job_run` row — a failed run leaves it as it was. `job_run.watch_id` names the watch and `entity_id` the space.
- `Spaces.brief` is `spaceBriefProgram` read as the integration: path, criteria, memos (shared only) and terms on the path, members with their key values and domains (capped, with `memberCount`), the subtree with direct counts. Sensitive or archived subspaces leave the tree with their branch; a member sensitive by any input is left out; a space sensitive anywhere in its path — or by the workspace floor — refuses the call, which fails the run with the reason.

### 5.4 The syncer — meetings, `connectedAt`, `CursorInvalid` (SDK 1.5, D68)

- **`Content.logMeeting(MeetingClaim | MeetingCancellation) → { outcome: created | updated, interactionId } | { outcome: refused, reason }`.** A meeting claim is one calendar event: `uid` (the iCalUID, plus `#<original start>` for an instance of a series — every instance shares the UID), the calendar's `eventId`, `status`, `startsAt`/`endsAt`, `subject?`, `organizer?`, `conferenceUrl?`, `recurringInstanceId?` and `attendees: [{ email, name?, rsvp, self? }]`. A cancellation names only `eventId` (and `uid` when it has one) — what a change feed sends for a deleted event.
- **The host decides, through core's `MeetingLane` service**, whose live Layer is the arrival lane (`logMeetingProgram`, beside the mailbox): the organizer and attendees are addresses judged by `decideParticipants` and resolved by the same program mail uses, and `meetingRefusal` (beside the mail refusals) refuses a birth when the event was cancelled before it was seen, the owner declined, or no attendee is from outside. A meeting already held follows its event whatever it became: `occurred_at`, the meeting `meta` (with `calendar_event_id`, how a bare cancellation finds its row) and the edges — added for new attendees, dropped for what only a departed attendee matched. The row is keyed by `message_id = uid` through `interaction_message_id_unique`, so the same event synced from two calendars is one row: the second insert conflicts and follows.
- **`ScheduleInput.connectedAt`** is the bound connection's `created_at`, else the integration's: the forward-only floor (CONTEXT "Email / calendar ingestion"). A syncer's first pull is bounded by it, and nothing that ended before it is written even when a change feed reports an edit.
- **`CursorInvalid`** is a schedule job's typed outcome for an expired cursor (Google's 410). The host closes the run `succeeded` with `cursor invalid, cleared: <reason>` in `job_run.summary` and writes the cursor null; the next run starts as the first did, from `connectedAt`.
- The testing kit's `makeFakeCalendarApi` is `events.list` over a fake calendar (`timeMin`, `syncToken`, `showDeleted`, `singleEvents`, paging), with `expireSyncTokens`, `rateLimit` and `revoke`; `SPACES_FAKE_PROVIDERS=1` stands it in for `google-calendar`.

### 5.5 The recorder contract — keyed connections, `logRecordedNote` (SDK 1.5, D78)

- **`Content.logRecordedNote(RecordedNote | RecordedNoteGone) → { outcome: attached | born | duplicate, interactionId } | { outcome: removed, interactionId | null }`.** One contract for every recorder, whatever its transport: Granola from a `schedule` job, Fathom and tl;dv from a `webhook` job through §11's ingress. The note carries the provider note id, title, start and end, attendees, `calendarEventId`/`icalUid`, the summary, the opted-in `typedNotes`/`transcript`, `webUrl`, `recordingUrl`, `folderIds`, `deletedAt` and `raw`.
- **The host decides, in core's `writeRecordedNote`**: the receipt first (only on a first delivery), the participants through the `MeetingLane`, then `writeRecordedInteraction` — the calendar meeting by event id, else start plus attendee emails within 30 minutes, else a `call`. The key is `rec:<integration>:<connection or workspace>:<note id>`, the call's `message_id` or the meeting's `recorder_events` id, so a replay is one row and one receipt and two members' notes of one meeting are two copies. What a note becomes beyond that is `landRecordedNote`'s (arrival-7).
- **Removal** (`recorded-note-gone`, `deletedAt`, Disconnect) is `removeRecordedNotesProgram`: the notes and documents the integration wrote for the note's author on that interaction, open `task` suggestions citing the receipt or those notes, the receipt, then the recorder event — or the whole call it had born.
- **A keyed connection** is `requires.connection: { provider, key: true }`: each member pastes their own key (`account_connection`, an `api_key` bundle, no expiry; `accessTokenFor` returns it). The admin's row binds no connection; the worker runs each schedule job once per member's active connection on ports bound to it, with `ScheduleInput.connection.settings` (the ticked `folder_ids`, `typed_notes`, `transcript`) and a cursor keyed `<job>@<connection>`. A member's refused key marks only their connection.
- The testing kit's `makeFakeGranolaApi` is `/me`, `/folders`, a folder's notes and one note, with a request log, `move`, `remove` and `finish`; `SPACES_FAKE_PROVIDERS=1` stands it in for `granola`, in the worker and on You → Meeting notes.

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
…) that record every port call and mint deterministic fake ids where a
lane would return one. A plugin author tests "given this provider JSON, the
job makes these calls" with no Postgres and no network. Core uses the same
kit to test the loader. A DryRun Layer — the recorder in production, over
`previewResolve` — is the later answer to an importer preview.

Authoring loop: `pnpm create spaces-plugin` → template (manifest + one job

- test) → `spaces plugin dev ./plugins/apollo` symlinks the workspace build
  into a local `/data/plugins` → same loader as prod → `pack` → tarball +
  sha + sig → registry.

**SDK versioning.** Own semver. New port method or trigger = minor; changed
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
6. wire        Layer per (integration, job): the ports the job's `uses` names, bound to row, credential, config
7. register    boss.work('plugin.<id>.<job>', runJob(plugin.jobs[job], layer)); boss.schedule(...);
               ingress → row flag so web mounts /api/webhooks/<id>
8. mark        integration.status = enabled | degraded (+ reason)
```

Any failed step → `degraded` with the reason, jobs skipped, **boot
continues**. A plugin never crashes the box. Disable / upgrade = reverse:
unregister queues, release the Layer scope, forget the module. Hot reload
is in-process (Effect scopes release cleanly); if it ever fails, the remedy
is an ordinary restart — there is no exit-75 fallback (D62).

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

**As built (sdk-24a).** Containment is the `plugin_runtime` role, created by
the migration runner as the owning user and entered with `SET ROLE`; it reads
`public`, writes only the `plugin_<id>` schema it owns, and a database that
refuses `CREATE ROLE` degrades the plugin. Migrations are `migrations/*.sql`
in lexical order, journaled in `plugin_<id>.spaces_migrations`. CONTEXT.md
"Plugin architecture" (runtime and hosting contracts) has the whole record.

## 9. Registry, signing, install from the running deployment

```
registry.json  [{ id, version, sdk, name, description, requires?, roles?,
                  tarball: url, sha256, sig, keyId, minCore? }]     // no kind (D51)
```

The format is `registryEntrySchema` in `@spaces/sdk/pack` (sdk-21a), which
also packs: `<id>-<version>.tgz` (gzip'd ustar of manifest.json, bundle.mjs,
migrations/) + `.sha256` + `.sig`. `verifyPlugin` is
`@spaces/core/plugins/verify`; CONTEXT.md "Plugin architecture" records the
key id format, the key directory and the tar choice.

v0: tarballs on GitHub Releases, index committed in-repo and copied into
the image (offline installs see the shipped list; live refresh when
outbound HTTPS exists). v1 upgrade: OCI artifacts in GHCR (one auth, one
mirror story) — not now. As built (ship-9): a `plugin-<id>@X.Y.Z` tag runs
`plugin-release.yml` → `scripts/release-plugin.ts`, which publishes the
release and commits the entry; the procedure is in CONTEXT.md "Plugin
architecture".

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
only. **Signing mechanics (D54, decided 2026-09-30; the scheme is D16's
plugin half):** a detached raw ed25519 signature over the tarball, made and
checked with `node:crypto` (no dependency, no network — what an air-gapped
install needs); the public key is a file baked into the image and named by
key id, so a rotation can trust two keys for one release, and it is never
read from `registry.json` (whoever serves the registry would then choose the
key); the private key is a GitHub Actions secret used only by the plugin
release workflow. The development escape is a marker file,
`./data/plugins/.allow-unsigned`, off by default: an unsigned plugin then
loads with a warning on every boot and an "unsigned" badge on its
Integrations row, and the required-env set stays `{DATABASE_URL, APP_URL}`. Third-party or ToS-exposed code
→ tier 2 companion.

Same page: Installed (version, status, last run, last error, credits),
update badge → one click, disable (key kept), uninstall (key deleted,
schema optionally dropped, files removed).

**As built (sdk-21b).** `runInstaller` (`@spaces/core/writes/plugins/install`)
is the one routine; `installPlugin` / `upgradePlugin` / `uninstallPlugin`
are its entry points, each called once, from the program behind its server
fn (asserted by a source-scanning test). It takes bytes plus the entry, so
an upload can feed it. Verify first, then stage under `plugins/.staging/`
and rename into `<id>/<version>/`, swap the `current` symlink by rename,
write `lock.json` (`{ core, plugins: { <id>: { version, sha256 } } }`),
upsert the row (`installing`, enabled) and NOTIFY after commit. Upgrade keeps
one version back and prunes older ones. Uninstall soft-deletes the row
(`integration.removed_at`, migration 0065) so provenance survives ("Apollo,
since removed"), deletes the files, the lock entry and the key, and drops
`plugin_<id>` only when asked; a reinstall reuses the row. CONTEXT.md
"Plugin architecture" has the decision.

**As built (sdk-22).** Two more doors, no second code path: `installPlugin`
has exactly three callers — the registry install, the upload and first
boot (asserted by the same source scan). **Upload** (Settings →
Integrations → Upload a plugin) takes the release's `<id>-<version>.tgz`
and the `<id>-<version>.json` entry beside it, as a multipart server fn; the
entry gives sha256, `sig` and `keyId`, so an upload verifies exactly as a
registry install does and a refusal carries the same `RefusalCode`. A lone
`.tgz` verifies as unsigned. The bytes go to the installer, never to blob
storage. **`SPACES_PLUGINS`** and **`SPACES_CREDENTIAL_<ID>`** are
`firstBootPlugins` (`@spaces/core/writes/plugins/first-boot`), the last step
of `boot()`: each named plugin without a live row gets the snapshot's newest
entry whose `sdk` range and `minCore` this box satisfies; the key is seeded
only when the vault has none for that provider, bound to the row, as the
page writes it. Tarballs are fetched by `fetchPluginTarball`
(`@spaces/core/plugins/source`, `https:` or `file:`), the one fetcher the
registry install and first boot share. CONTEXT.md Hostability contract 6 has the rules.

## 10. Hosting lifecycle

```
image                      core web + worker + loader + registry.json snapshot. No plugins.
./data/blobs               existing
./data/secret.key          existing
./data/plugins/<id>/<ver>/ bundle.mjs · manifest.json · migrations/     (+ current symlink)
./data/plugins/lock.json   { core: '1.4.0', plugins: { apollo: { version: '1.2.0', sha256: '<bundle.mjs>' } } }
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
- **Pinned by sdk-11 (2026-10-01).** A lock entry carries the sha256 of the
  `bundle.mjs` it pinned beside the version (`@spaces/core/plugins/lock`);
  until the installer writes one, an absent file or entry loads the plugin
  **unpinned** (said in its verdict line) and an entry that disagrees with
  the bytes degrades it. The loader (`apps/worker/src/plugins/loader.ts`)
  writes the validated manifest to `integration.manifest`, which web renders
  from; `core.*` rows (the mailbox) are first-party and never reconciled;
  a bundle's bare `effect` / `zod` / `@spaces/sdk` imports resolve to the
  worker's own copies through a `node:module` resolve hook, which is why the
  worker bundle leaves `@spaces/sdk` external and the image carries it in
  `/app/node_modules`. `/api/health` lists `degradedPlugins`.
- **Upgrade, as built (sdk-13).** "Satisfying" is one rule
  (`updateFor` / `runsOn`, `@spaces/core/plugins/registry`): newer than the
  installed version, `minCore` at or below `CORE_VERSION`, and the entry's
  sdk range admitting `SDK_VERSION` (`satisfiesSdk`). The ledger's badge
  names the newest satisfying version and Update takes exactly that one;
  when the registry's newest fails the rule the row shows no badge and says
  why (`2.0.0 needs sdk ^2.0; this host provides 1.1.0`). Install and the
  Available pane never offer an entry this host cannot run
  (`newestPerPlugin`). An upgrade writes the row's upgrade record —
  `upgraded_from`, `upgraded_at`, `upgrade_migrated` null (migration 0067)
  — and the loader answers it after step 5: true once any migration file
  applied since the upgrade (sticky), false when step 5 applied none,
  including a failing run, which rolls back whole. The ledger and the card
  read it as `rollback available`, `rollback unsafe — restore from backup`,
  or not yet known; rollback itself is the restore, not a button. A
  failing migration leaves the row degraded with the refused statement, the
  previous directory intact, `public` untouched, and `current`, lock.json
  and the row all naming the new version. An upgrade the installer refuses
  changes nothing; one whose lock.json write fails swaps `current` back.
  `SPACES_PLUGINS_AUTOUPDATE=compatible` runs in the worker at boot, before
  the first reconcile (it owns the data directory and the loader, and web
  may be a separate container): every installed row takes its satisfying
  target from the bundled snapshot through `upgradePlugin`, one log line per
  take or refusal; unset or any other value does nothing, silently.

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

**Every plugin invocation is a job.** Every trigger lands in pg-boss; D51
names five (`action` · `schedule` · `event` · `webhook` · `file`, §5). The
three a user or core starts:

| trigger  | example                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| action   | `actions[]` → "Enrich" button → `enqueue('plugin.apollo.enrich', { entityId })`                                                                                                 |
| schedule | `manifest.jobs[].schedule` → `boss.schedule`                                                                                                                                    |
| event    | `on: ['entity.created']` — `resolveEntity` and `createDeal` emit it (D65); a dispatcher maps it to jobs. Attio's enrich-on-create is this trigger, not a different architecture |

This is the whole "workflow engine" we will ever have: declarative in
manifests, never a UI (the tasks decision already rejected a builder).

- **Interactive jobs** (`interactive: true`): own priority queue, low batch,
  short timeout. Status via `LISTEN/NOTIFY job_status → SSE` to the record
  page, through one shared LISTEN client in web (D64); the cell shows "Enriching… → Apollo says X, accept?". No polling.
- **`query` (deferred; not one of D51's five triggers — adding it is a
  minor)**: narrow, read-only, budgeted request/reply over pg-boss — web sends, awaits NOTIFY with the reply, 3s budget. For "search
  Exa inside a picker". Works unchanged in split-role deployments; a
  worker localhost HTTP would not.
- **Ingress**: web verifies the manifest-declared signature (generic HMAC,
  no plugin code), stores the raw payload, enqueues `plugin.<id>.ingest`,
  returns 200 in ms. Route mounted only for enabled rows — disabled → 404.
  **As built (sdk-23):** the route is `POST /api/webhooks/<integration row
id>` — the row's uuid, not the plugin id, so it is unguessable and names
  one install. There is no "mounted" flag (§7 step 7's row flag was not
  needed): the route always exists and answers only for a row that is
  enabled, status `enabled`, not removed, and whose stored
  `integration.manifest` declares `ingress` and a `webhook` job; every
  other case — disabled, degraded, tripped, installing, removed, unknown or
  malformed id — is the same 404 body after the same row lookup. The
  program is core's `receiveWebhookProgram`
  (`@spaces/core/writes/ingress/receive`); web's route only enforces the
  size limit (`INGRESS_MAX_BYTES`, 1 MiB, against Content-Length and again
  while reading → 413) and maps refusals to statuses. For
  `hmac-sha256` the sender puts `sha256=<hex>` of the raw body in
  `x-spaces-signature`; the secret is the row's `webhook_credential_id`
  (vault kind `webhook`, provider `<plugin id>:webhook`, saved on the
  integration card), compared with `timingSafeEqual`; a missing header, a
  wrong signature or no saved secret is 401 with nothing stored or
  enqueued. An accepted delivery is stored raw in `ingress_payload`
  (headers minus cookie/authorization, body as bytea), then
  `{ payload, receivedAt }` — the `WebhookInput` the job receives, payload
  parsed as JSON or else the text — is enqueued on `plugin.<id>.<job>` for
  each `webhook` job the manifest declares (`.interactive` appended for an
  interactive one); there is no fixed `ingest` name. Stored but not queued
  answers 503 so the sender retries. Rows are deleted after
  `INGRESS_RETENTION_DAYS` (7) by the nightly `ingress.prune` job (04:40
  UTC). A per-provider header name is not in the manifest yet; adding
  `ingress.header` would be a minor.
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
   privilege (a job calling `Facts` without `uses: ['Facts']` → "service not
   found"). pg-boss on
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

**As built (layers 2, 3 and 7, for the enrichers).**

- **Cassettes, no msw.** A provider's recorded answers are committed beside
  its plugin at `plugins/<id>/fixtures/cassette/cassette.json`: interactions
  matched on method and URL, exact first, a `*` query value matching
  anything and spliced into the response file's `{{name}}`; the header the
  provider reads its key from; what it answers a revoked key. The worker
  serves one through the Http port's own `fetch` seam, so the live throttle,
  scrub and 429 handling are what runs against it. A small mutable fake
  sits in front of the cassette (`makeFakeProvider`): a revoked key, a run
  of 429s with a `Retry-After`, a failing URL. Apollo has one; a stateful
  provider (Drive, Gmail) gets its own fake when its plugin lands.
- **`SPACES_FAKE_PROVIDERS=1`** (passed through turbo's `dev`) makes the
  worker stand a fake in for every plugin that committed a cassette: the
  grant hands it the fake's transport, and an unkeyed row a fake key, which
  is also why the loader's `requires.credential` check lets that row load
  (`standInFor` is the one question both ask). Unset, the fakes module is
  never imported. Outside a workspace — the image — there are no cassettes,
  so every plugin runs live whatever the flag says.
- **Conformance.** One file per port under the worker's
  `plugins/conformance/`, each `describe.each` over an `IMPLEMENTATIONS`
  array: the live port on the test database and the SDK's in-memory one
  (Http, Secrets, Config, Log, Read, Identity, Facts, Receipts, Content's
  interaction and signal lanes, Judgment, Import). The provider-facing
  contract is `enricher-conformance` over `ENRICHERS` — Apollo alone today,
  so that file is the contract written down rather than a comparison; a
  second enricher is one more entry. PluginDb has one implementation (its
  behaviour is Postgres's) and Ai none yet.
- **Chaos.** `chaos.test.ts` runs each enricher's real bundle through a real
  pg-boss and `runJob` against its fake: a 429 waits the provider's
  `Retry-After`, a 429 that persists re-sends the job for then without
  spending a retry or charging the breaker, a key revoked mid-run fails the
  next job permanently and at once without the key in the error, and half a
  failing batch leaves the succeeding half written and the rest retrying.
  "Webhook delivered twice" lands with the webhook ingress; the storage
  sources' half of the list is below.
- **No network.** CI's `offline` job runs the worker's and every plugin's
  suite in a group whose outbound traffic is rejected (loopback open for
  Postgres), after a self-check that `https://example.com` does not answer.

**As built (layers 2 and 3, for storage sources — the read half).**

- **The fake Drive is in-process, not a server**, and lives in the testing
  kit: `makeFakeDrive({ seed?, credentials? })` from `@spaces/sdk/testing`
  is a `StorageSource` over a mutable seeded tree (`FAKE_DRIVE_SEED`: a My
  Drive root, a data room of five children, a three-deep folder, a
  shared-drive root, one native Google Doc that exports to docx bytes).
  Mutators (`add`, `remove`, `rename`, `move`, `edit`) feed the change
  log; toggles for the chaos list — `rateLimit(calls, retryAfterMs)`,
  `evictCursors()` (Drive's 410), `vanishAfterList(id)` (deleted between
  list and get), `revoke()`/`restore()`. Each file carries a Drive-style
  `md5Checksum` that the fake never surfaces, so a test can prove it.
- **Conformance is a function, not a file**:
  `storageSourceConformance({ make, fixture, secrets })` returns named
  cases (`{ name, run: Effect }`), so the sdk takes no vitest dependency; a
  provider's test runs them with
  `it.each(cases)('$name', ({ run }) => Effect.runPromise(run))`. The
  `fixture` is what the seeded tree holds, written separately from the seed
  (`FAKE_DRIVE_FIXTURE`), so an entry deleted from the seed fails the
  paging case naming it — nothing skips for being absent. The cases:
  `resolveLink` (folder, file, foreign → null), `listFolder` at page size 2
  (no duplicate, no omission, no extra), the native doc exported and hashed
  by the suite (SHA-256 over the stream; any `hash`/`checksum`/`md5`/`sha`
  key on a result fails), `getFolder` ancestry to the root, `NotFound`
  typed on a missing id, `changes(null)` and back, and `pickerConfig` as
  plain JSON with none of the `secrets` in it. The suite needs no network
  and no Postgres (`packages/sdk/src/testing/storage-source.test.ts`).
- `SPACES_FAKE_PROVIDERS=1` stands Drive's v3 REST API in process
  (`makeFakeDriveApi` over the fake Drive) in for the `google-drive` plugin,
  with a fake access token, so the real plugin code runs with no network and
  no connection.

**As built (layer 7, for storage sources — the chaos list).**

- **A second suite beside the first**: `storageSourceChaos(subject)` returns
  cases of the same shape, so a provider's test runs both. Its subject's
  `make` hands back `{ source, chaos }`, where `chaos` is the provider's
  bad-day handle (`rateLimit(calls, retryAfterMs)`, `evictCursors()`,
  `vanish(id)`, `revoke()`/`restore()`) — the fake Drive's `chaos` is one,
  and a plugin's test implements it over its HTTP fake. A happy-path
  subject does not type-check as a chaos subject. The fixture
  (`StorageSourceChaosFixture`, the fake's is `FAKE_DRIVE_CHAOS_FIXTURE`)
  adds a file to vanish and a large file with its SHA-256; the subject adds
  `secrets` and a `memory()` probe (`process.memoryUsage.rss` under node).
- **Every bad day is a typed failure.** A throw or a rejected promise fails
  a case as loudly as a wrong tag (the case says "died … not a typed
  failure"). The cases: a 429 with `Retry-After: 1` is `RateLimited` with
  `retryAfterMs` 1000, and a retry after sleeping that long succeeds; a file
  deleted between list and get is `NotFound` naming it; half a batch — every
  file in the data room read with that one vanished — reads the rest and
  fails that one alone; an evicted change cursor is `CursorExpired` naming
  it, and a fresh one reads; `changes(c)` replayed gives a deep-equal page
  (the poll's idempotency); a token revoked mid-run fails all six methods
  `AuthExpired` with no secret in the error, and `restore` brings them back.
- **The 200 MB file is streamed, never held.** `makeFakeDrive({ largeFiles })`
  takes files whose bytes are generated a 16 KiB chunk at a time on read
  (`fakeDriveLargeChunks`; `FAKE_DRIVE_SCAN` is 200 MB). The case hashes
  each chunk as it arrives with an incremental pure-JS SHA-256
  (`makeSha256` — WebCrypto digests only a whole buffer), compares it with
  the fixture's hash, and samples `memory()` per chunk: the peak may not
  rise more than `LARGE_FILE_MEMORY_BOUND` (96 MB; read chunks are garbage
  until V8 collects them late, near 50 MB cold) over the start, and the
  file must be at least twice that so buffering always shows.
- **Each assertion is shown to bite**: the sdk's own test runs every chaos
  case against a fake broken for it — the rate-limit toggle off, the hint
  lost, a rejected promise for a vanished file, a batch that aborts on the
  first miss, eviction ignored, a cursor consumed on read, a revoke undone,
  a provider that buffers the scan — and asserts the failure message.
  "Webhook delivered twice" still lands with the webhook ingress.

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
