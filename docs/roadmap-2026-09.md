# Roadmap — reconciled

_2026-09-15, trimmed 2026-09-27. The order of all 23 projects and why, the milestones of the unshipped ones, the decisions still ahead, and the open audit findings. The reconciliation narrative, the shipped projects' milestones and the decisions carried by shipped slices are in this file's git history._

**230 slices · 23 projects · 2 initiatives · 80 added · 3 deleted · 227 with written bodies, 3 still key-and-title only**

**Status: projects 1–13 are published to Linear as SPA-16…SPA-150** (134 issues, 169 blocking relations, 44
milestones, published 2026-09-16). The bodies for those live in Linear, which is their store of record; this file
carries their structure. **Projects 14–23 are not published**, and their 98 slice bodies live in
`docs/roadmap-backlog.md` — publish a project when you reach it, not before. All 48 open decisions are closed:
`docs/decisions-2026-09.md`.

_Historical note from before publication:_ The 35 unresolved placeholder blockers from the first pass (`clean-integration-table`, `mono-test-db-harness`, `ai-suggestion-inbox` and friends) have been mapped to real keys, so every blocker in projects 1–13 exists before the slice that names it. Exactly one slice blocks the rest: `import-10` (P14) is blocked by `sdk-5` (P17) and `sdk-12a` (P18); defer it and projects 14–16 unlock too. The second audit's warning was against publishing projects 2, 5 and 6 _out of order_, not against publishing more than one. See §4 for the eleven collisions this pass introduced at the new seams, which a serial reader should close before the projects that contain them.

---

## 1. Projects

Projects 1–12 have shipped (their slice bodies are the Linear issues). Project 13 is in Linear; 14–23 are in `docs/roadmap-backlog.md` and are published to Linear when reached.

**Shipped:**

- **1.** Ship polish first — the name, the box, and the vocabulary
- **2.** Worker spine, the workspace, and a test database of its own
- **3.** Provenance without vendors, deletes that don't lie
- **4.** The Instrument port — a new surface is born ported
- **5.** Custom objects, and one review inbox
- **6.** The note model — filed, not just mentioned
- **7.** Documents file into spaces
- **8.** The documents shelf, one row birth, two byte lanes
- **9.** Views leave the browser — server-side filters and pagination
- **10.** AI substrate — it reads a deck
- **11.** Everything Cmd-K can find
- **12.** AI on every object, and the graph from outside

### 13. Doors that are not an upload — a mailbox, a link, and an API with a spec

_Spaces v1 · 10 slices_

The cheapest inbound channel CONTEXT sequences first, finally sliced: BCC an address and a thread lands on the right company with its participants and its deck. Then deck links snapshotted before they expire, then one versioned external door that describes itself, mints scoped tokens from the same store MCP uses, and turns a captured page into a filed document and a founder suggestion.

**▸ Forwarding mailbox — the cheapest door in** — Configure a throwaway IMAP mailbox, BCC it on a founder thread, and within a cadence the company's timeline carries the thread with its participants, the founder and the free-provider lawyer exist as records, your own partner does not, a domain you already track lands in the review queue instead of as a twin, and the attached deck is on the Files tab, extracted and searchable. No OAuth, no consent screen, no plugin loader in the path.

| slice       |      |     | title                                                                          | blocked by                                   |
| ----------- | ---- | --- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `arrival-1` | hitl | M   | Forwarding mailbox — an address you BCC, polled over IMAP                      | `clean-2a`, `clean-3`, `clean-4`, `clean-2b` |
| `arrival-2` | hitl | M   | Participants become records — work domains, free providers, one collision door | `arrival-1`, `objects-3`                     |
| `arrival-3` | afk  | M   | Forwarded attachments file themselves — the deck lands on the company          | `arrival-1`, `storage-6a`, `docsurf-7`       |

**▸ Deck links — a DocSend before it expires** — Paste a DocSend, Pitch or Notion link into a deal's upload box and get a searchable PDF of the deck in the document pipeline, still readable after the link dies — registered as a renderer on the clip job's link-kind table rather than a second branch inside a guarded fetch.

| slice       |      |     | title                                                                                                                                                | blocked by                                 |
| ----------- | ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `arrival-4` | hitl | M   | ~~Deck links — a DocSend or Pitch link becomes a PDF before it expires~~ **cancelled 2026-09-25 (owner; D32 superseded — a deck link stays a link)** | `docsurf-10a`, `docsurf-10b`, `storage-6a` |

**▸ A door with a spec on it** — One versioned external namespace on the HttpApi already in the pinned package, one handshake procedure, and $APP_URL/api/v1/openapi.json importable into Postman or n8n before a single credential exists. Then the read half: n8n pages through records and the object registry as the token's user with canRead applied in SQL — no filter dialect, no second search, no write path.

| slice   |      |     | title                                                               | blocked by       |
| ------- | ---- | --- | ------------------------------------------------------------------- | ---------------- |
| `api-1` | hitl | M   | HttpApi door — one definition, OpenAPI out (D8)                     | `mono-1`         |
| `api-2` | afk  | S   | OpenAPI emission — one spec document, versioned and snapshot-tested | `api-1`          |
| `api-6` | afk  | M   | Public read API — records and registry, paginated, no filters       | `api-2`, `api-3` |

**▸ Capture without an extension** — A token minted in settings — from the same store MCP uses, not a second one — opens the API as its user with per-scope refusals; a page's text posted by curl becomes a filed, searchable document with its source URL; and a moment later a founder suggestion is in /inbox with role and company filled in, ready to accept into a real person. The MV3 extension is then a thin client with nothing left to invent.

| slice   |      |     | title                                                                  | blocked by                                             |
| ------- | ---- | --- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `api-3` | afk  | S   | Scoped tokens on the API door — one personal-token store, not a second | `api-1`, `ai-23a`                                      |
| `api-4` | afk  | M   | /api/capture v1 — page text in, a filed document out                   | `api-2`, `api-3`, `storage-6a`, `clean-4`, `docsurf-7` |
| `api-5` | hitl | M   | Capture extraction — the deck reader's twin, pointed at a person       | `api-4`, `ai-6`, `ai-7`, `ai-8a`                       |

### 14. Import and export — a spreadsheet becomes the graph

_Spaces v1 · 12 slices_

The onboarding-critical channel: every prospective user has deal flow in a spreadsheet today and a portfolio that predates the product. Read CSV and XLSX into one grid, map onto the object registry so a custom object imports with no importer change, preview attach-or-create before anything is written, commit idempotently, and bootstrap holdings as dated events rather than balances — with a correction door, because the event tables are append-only and an import commits forty rows at once.

**▸ A spreadsheet reads and maps** — Drop the messy CSV or xlsx onto /import, pick any object in the registry, and every column says where it lands and how many of its values will parse — '38 of 40', with the two offenders and their reasons one click away, and a Stage column reading 'Seed' against an option that does not exist refused by name rather than invented. Nothing has touched the graph and no new dependency entered package.json.

| slice      |      |     | title                                                                     | blocked by               |
| ---------- | ---- | --- | ------------------------------------------------------------------------- | ------------------------ |
| `import-1` | afk  | M   | Spreadsheet reader — CSV and XLSX to one cell grid                        | —                        |
| `import-2` | hitl | M   | Staged import — a spreadsheet becomes a batch, nothing reaches the graph  | `import-1`, `storage-6a` |
| `import-3` | afk  | M   | Column mapping onto the registry — the type system is already the mapping | `import-2`, `objects-5`  |
| `import-4` | afk  | M   | Cell coercion per attribute type — and the columns that will not parse    | `import-3`               |

**▸ The first import lands** — A 46-row company sheet and a 40-row deal sheet become companies, deals and people: the preview says '31 create · 12 attach · 3 errors' before anything is written, reference cells find their record or error naming both candidates, near-duplicates queue in the existing review inbox instead of appearing as silent twins, and re-running the same file writes nothing.

| slice      |     |     | title                                                                   | blocked by                                    |
| ---------- | --- | --- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `import-5` | afk | M   | Resolve preview — attach or create, decided before anything is written  | `import-4`, `clean-3`                         |
| `import-6` | afk | S   | Reference cells find their record — a deal's company column             | `import-5`                                    |
| `import-7` | afk | M   | Idempotent commit — the first import lands, and a re-run writes nothing | `import-6`, `objects-1a`, `sdk-1`, `clean-2b` |

**▸ An angel arrives with a portfolio** — A 12-row tracking sheet becomes holdings with dated rounds, investments and marks — events, never balances — so MOIC, IRR and as-on views work on day one for checks that predate the product, with missing FX surfaced rather than faked. And because those tables are append-only with no edit path, the correction door lands first: a reversing entry with a reason, the same door ai-22's accepted proposals use.

| slice       |     |     | title                                                               | blocked by             |
| ----------- | --- | --- | ------------------------------------------------------------------- | ---------------------- |
| `import-8`  | afk | M   | Ledger mapping — one spreadsheet row becomes dated events           | `import-6`             |
| `import-11` |     |     | _body not yet written_                                              |                        |
| `import-9`  | afk | M   | Ledger commit — holdings born, events appended, nothing overwritten | `import-7`, `import-8` |

**▸ Out as well as in, and a dialect is a plugin** — The data can leave — the question a self-hosted product must be able to answer — and an Airtable export imports through the same preview and the same commit as a hand-mapped CSV, proving the pipeline stays core while dialects live outside it. This milestone is the one part of the project gated on the SDK.

| slice       |      |     | title                                                                              | blocked by                     |
| ----------- | ---- | --- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `import-12` |      |     | _body not yet written_                                                             |                                |
| `import-10` | hitl | M   | The importer kind gets its tenant — a dialect is a plugin, the pipeline stays core | `import-7`, `sdk-5`, `sdk-12a` |

### 15. packages/core and apps/worker

_Extensibility · 8 slices_

The attribute and identity write paths, the vault, storage, seeds and the boot composition, the assembler and canRead move into packages/core; the dependency fence becomes lint; apps/worker becomes its own package carrying the already-shipped wrapper and heartbeat. This project ships no user-visible surface and is verified by regression — that is the success criterion for an extraction, not a smell.

**▸ The write paths move** — Edit a select cell and a reference cell, merge two duplicate people, save a shared and a private view — all through code now in packages/core, with setValues' single-write-path fence enforced by lint and the author/admin guard still refusing a stranger.

| slice     |     |     | title                                                                             | blocked by         |
| --------- | --- | --- | --------------------------------------------------------------------------------- | ------------------ |
| `mono-8a` | afk | M   | packages/core, attribute write path — setValues keeps its single-write-path fence | `mono-5`, `mono-7` |
| `mono-8b` | afk | M   | packages/core, identity write path — resolve, merge, and the view store           | `mono-8a`          |

**▸ Vault, storage, seeds and boot — three silences, three PRs** — Delete secret.key on a scratch database and boot: it regenerates at 0600 with the warning, a credential written before the move still decrypts, and a session cookie from before the PR still logs you in. Uploads round-trip under both drivers with the blob beside the ones already on disk. One command still migrates then seeds, in that order, and a deleted taxonomy space stays deleted.

| slice     |     |     | title                                                                  | blocked by |
| --------- | --- | --- | ---------------------------------------------------------------------- | ---------- |
| `mono-9a` | afk | S   | Vault into core — the master key, /data, and nothing regenerates       | `mono-8a`  |
| `mono-9d` | afk | S   | Storage into core — one driver interface, both drivers, the same bytes | `mono-9a`  |
| `mono-9e` | afk | S   | Seeds and the boot composition — one command migrates, then seeds      | `mono-8a`  |

**▸ The assembler moves, the fence goes up, the worker is its own app** — The context readout returns the same items in the same order with canRead intact, now running through packages/core. Dependency rules stop being aspirational: a db import from the plugins fixture fails with the rule's message and the spec section. apps/worker becomes its own package, an apps/web import inside it is refused, and the queue names are renamed once with the consequence for in-flight jobs and the 03:30 schedule row recorded.

| slice      |     |     | title                                                                      | blocked by           |
| ---------- | --- | --- | -------------------------------------------------------------------------- | -------------------- |
| `mono-9b`  | afk | M   | Context assembler into core — and canRead leaves the server barrel with it | `mono-8b`            |
| `mono-10`  | afk | S   | Dependency rules as lint — packages/config and the import zones            | `mono-9a`, `mono-9c` |
| `mono-11a` | afk | S   | apps/worker — its own package, behaviour untouched                         | `mono-9c`, `mono-10` |

### 16. A published image anyone can run

_Extensibility · 8 slices_

The pruned, source-free image; the first browser coverage the project has ever had; multi-arch images on GHCR and Docker Hub from a tag; install, upgrade and rollback docs; upgrade CI that boots the last release against this commit's schema; and one-click templates. Placed here rather than last because the rename already landed in project 1, so nothing bakes DealOS in — and because the image is the adoption win CONTEXT calls the biggest one outstanding.

**▸ A source-free image** — turbo prune --docker layering, the docker/ layout, the ROLE branch, and the worker, migrate and health entries bundled so src/ and tsx leave the image — with su-exec and both entrypoint privilege phases intact, a PDF and a DOCX still becoming searchable, and the before/after image sizes recorded.

| slice      |      |     | title                                                                  | blocked by          |
| ---------- | ---- | --- | ---------------------------------------------------------------------- | ------------------- |
| `mono-13a` | afk  | M   | Pruned image — turbo prune --docker, docker/ layout, built on every PR | `mono-12`, `mono-6` |
| `mono-13b` | hitl | M   | Bundled worker — src/ and tsx leave the image                          | `mono-13a`, `sdk-1` |

**▸ A browser proves it works** — A real Chromium proves you cannot reach /today signed out, cannot claim /setup without the log token, cannot claim it twice, and cannot sign up once an admin exists — then composes the image built from the PR, waits for health to say db ok and worker ok, drops a DOCX on a company's Files tab and asserts the extracted text in the preview. The first time any of that has been checked outside a person's hands, and a harness every later UI slice adds one spec to.

| slice    |     |     | title                                                                | blocked by                                |
| -------- | --- | --- | -------------------------------------------------------------------- | ----------------------------------------- |
| `ship-6` | afk | M   | Playwright harness — the login gate and the first-run setup window   | `mono-6`                                  |
| `ship-7` | afk | M   | Upload to preview in a real browser — the smoke that gates a release | `ship-6`, `ship-2`, `mono-12`, `mono-13a` |

**▸ docker compose up from a published tag** — A stranger with no checkout drops in a compose file pinned to a multi-arch tag and is at /setup in a minute on arm64 or amd64, with no 583 MB build on their box. They can back up, they can restore from total loss, and the README tells them what to back up and what losing secret.key costs — in bold.

| slice     |      |     | title                                                                                  | blocked by                     |
| --------- | ---- | --- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `ship-8`  | hitl | M   | Published images — multi-arch GHCR and Docker Hub on a core@ tag                       | `ship-7`, `ship-1`, `mono-13a` |
| `ship-10` | afk  | M   | Install, upgrade and rollback docs — back up first, pin the tag, never lose MASTER_KEY | `ship-3`, `ship-5`, `ship-8`   |

**▸ The path back is tested** — Push a migration that drops a column something still reads and the upgrade job goes red naming that migration, with both images' logs attached, instead of the breakage arriving on an operator's box. And the PaaS templates put the whole thing one click away on the platforms self-hosters actually use.

| slice     |     |     | title                                                   | blocked by          |
| --------- | --- | --- | ------------------------------------------------------- | ------------------- |
| `ship-11` | afk | M   | Upgrade CI — last release's image, this commit's schema | `ship-8`, `ship-5`  |
| `ship-12` | afk | S   | One-click templates — Coolify, Railway, Render, Unraid  | `ship-8`, `ship-10` |

### 17. The plugin SDK — claims without a database

_Extensibility · 13 slices_

@spaces/sdk, the semver-frozen claim and kind contracts, the testing kit, the loader, the live ports, and claims landing as graph writes with provenance a plugin cannot forge. Born inside the dependency fence rather than retrofitted into it, and tested with Postgres stopped — the cheapest second agent you can have running.

**▸ A plugin can be written and tested without the app** — An author writes a manifest in TS (emitted as JSON Schema so web renders it without the bundle, with the supported type subset refused at validation time rather than rendered badly), a job against typed ports, normalizes identity keys the same way the choke point does, and proves 'this provider JSON produces these claims' with no Postgres, no network and no running product. Pack and verify settles the signing scheme and the unsigned escape.

| slice     |      |     | title                                                                    | blocked by                |
| --------- | ---- | --- | ------------------------------------------------------------------------ | ------------------------- |
| `sdk-3`   | afk  | M   | @spaces/sdk skeleton — manifest as TS, JSON Schema on disk, definePlugin | `mono-workspace-scaffold` |
| `sdk-4a`  | hitl | M   | Claims and kind interfaces — the semver-frozen contract                  | `sdk-3`                   |
| `sdk-4b`  | afk  | S   | Identity-key normalizers move into the SDK — one list, no drift          | `sdk-4a`                  |
| `sdk-5`   | afk  | M   | Port tags and the testing kit — claims provable without a database       | `sdk-4a`                  |
| `sdk-21a` | hitl | M   | Pack and verify — the signing scheme, registry.json, and a tamper check  | `sdk-3`                   |

**▸ Ambient ports and the loader's verdict** — Point the data dir at four fixtures and start the worker: one verdict line per plugin, /api/health listing the degraded ones with reasons beside the worker line it already carries, manifests cached on the integration rows, and the extraction queue serving throughout. Config, Secrets, Log, Http and ReadLive are live and bound to one integration row — the log shows the redacted key and shows a private note was never read.

| slice    |     |     | title                                                                           | blocked by                         |
| -------- | --- | --- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `sdk-11` | afk | M   | Loader part one — discover, locate, validate, cache the manifest, mark degraded | `sdk-3`, `clean-integration-table` |
| `sdk-6a` | afk | M   | Ambient ports live — Config, Secrets, Log and Http bound to one integration row | `sdk-5`, `clean-integration-table` |
| `sdk-6b` | afk | S   | ReadLive — the plugin's view of the graph, as actor integration                 | `sdk-5`, `clean-integration-table` |

**▸ Claims become graph writes** — A fixture plugin's claims land as entities, aliases, receipts, interactions, signals, documents and values — each stamped to an integration row by the port, fill-blanks decided inside the row lock, collisions becoming duplicate candidates and conflicts becoming suggestions in the queue that already exists. Content.fileDocument is a thin port over the intake and birth modules with no pipeline of its own.

| slice    |     |     | title                                                                                | blocked by                                                         |
| -------- | --- | --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `sdk-7a` | afk | M   | Identity and Receipts live — provenance the plugin cannot forge                      | `sdk-5`, `clean-integration-table`, `clean-source-class`           |
| `sdk-7b` | afk | M   | Content's interaction and signal lanes — evidence rows with a typed source           | `sdk-5`, `clean-integration-table`, `clean-source-class`           |
| `sdk-8`  | afk | S   | Content.fileDocument — a plugin's bytes through intake and birth                     | `sdk-7a`, `clean-3`, `clean-4`, `storage-6a2`                      |
| `sdk-9`  | afk | M   | Facts live — fill blanks only, inside the existing row lock                          | `sdk-5`, `sdk-7a`, `clean-integration-table`, `clean-source-class` |
| `sdk-10` | afk | S   | Judgment live — machine writes that are suggestions, and Facts conflicts become them | `sdk-9`, `ai-suggestion-inbox`                                     |

### 18. Plugins run unattended, Apollo enriches

_Extensibility · 10 slices_

A Layer per (integration, job), queues by kind, the breaker, hot reload, then Apollo end to end with credit safety, manifest actions, live status and event triggers.

**▸ A Layer per job, and queues by kind** — The privilege boundary is built and released per (integration, job): an over-reaching job fails with service-not-found while the database stays clean and the worker stays up. Queues register, schedule and unregister without a restart.

| slice     |     |     | title                                                                          | blocked by |
| --------- | --- | --- | ------------------------------------------------------------------------------ | ---------- |
| `sdk-12a` | afk | M   | A Layer per (integration, job) — the privilege boundary, built and released    | —          |
| `sdk-12b` | afk | M   | Queues per job (migration) — register, schedule, unregister without restarting | `sdk-12a`  |

**▸ Failures disable the plugin, never the worker** — Five failures fill job_run, flip the integration to disabled with a reason and put one line on Today while extraction keeps working in the same worker. Enable, disable and upgrade happen over NOTIFY with no restart, and the exit-75 escape hatch is reconciled with the either-process-dies contract.

| slice     |     |     | title                                                                    | blocked by |
| --------- | --- | --- | ------------------------------------------------------------------------ | ---------- |
| `sdk-13`  | afk | M   | Plugin breaker — five failures disable the integration, never the worker | `sdk-12b`  |
| `sdk-14a` | afk | M   | NOTIFY plugin_changed — enable, disable and upgrade without a restart    | `sdk-12b`  |
| `sdk-14b` | —   | —   | Dropped (D62) — exit-75 reload is not built                              | —          |

**▸ Apollo enriches a company** — Paste a key, see the Enrich action appear on records rendered from the row's manifest, click it and watch blanks fill with Apollo as actor and the raw payload in an enrichment_record — credit-capped, 90-day cached, refusals visible on Today. This is the plugin arc's undeclared L and should be split at the provider-client seam before it is grabbed.

| slice    |     |     | title                                                              | blocked by         |
| -------- | --- | --- | ------------------------------------------------------------------ | ------------------ |
| `sdk-15` | afk | M   | plugins/apollo — the provider mapping, tested with no database     | —                  |
| `sdk-16` | afk | M   | Credit safety — daily cap, 90-day cache, refusals that are visible | `sdk-13`, `sdk-15` |
| `sdk-17` | afk | M   | Manifest actions — the Enrich button, in the record head (D63)     | `sdk-12b`          |

**▸ Under a second, and on creation** — LISTEN/NOTIFY to SSE so the cell goes pending then resolves with no refresh, survives a mid-run reload, and settles into failure rather than spinning when the worker dies. New companies with a domain enrich themselves on creation, with the emitter's home decided.

| slice    |     |     | title                                                                     | blocked by                    |
| -------- | --- | --- | ------------------------------------------------------------------------- | ----------------------------- |
| `sdk-18` | afk | M   | Interactive status — one LISTEN client, SSE to the record (D64)           | `sdk-13`, `sdk-14a`, `sdk-17` |
| `sdk-19` | afk | M   | Event triggers — enrich-on-create from resolveEntity and createDeal (D65) | `sdk-12b`, `sdk-15`           |

### 19. Install from the app, no redeploy

_Extensibility · 10 slices_

The integrations ledger, manifest-generated settings forms, install/upgrade/uninstall, the plugin release pipeline, air-gapped install, webhook ingress, plugin schemas, and the chaos suite that decides whether a plugin ships.

**▸ The integrations ledger** — Settings → Integrations shows installed rows with version, status, last run and last error — Apollo enabled, a fixture breaker-disabled with a working reset, an old-sdk fixture degraded with the fix named — in the settings shell rather than a third invented layout. A manifest becomes an editable card with an inline-validated key field, and saving reloads the worker with the new config.

| slice     |      |     | title                                                                       | blocked by                                     |
| --------- | ---- | --- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `sdk-20a` | hitl | M   | Integrations ledger — installed rows, version, status, last run, last error | `sdk-13`, `sdk-14a`, `clean-integration-table` |
| `sdk-20b` | hitl | M   | Settings form and the key field — a manifest becomes an editable card       | `sdk-20a`, `sdk-6a`                            |

**▸ Install, upgrade, uninstall — and how a plugin reaches anyone** — Click Install and watch files land under the data dir and the worker load and enable it without touching a terminal; a tampered tarball is refused with the data dir untouched. A new version gets its own directory and runs its own migrations, the previous is kept one back, and a rollback after a migration refuses by name rather than corrupting. Merge a changeset and a plugin-<id>@x tag builds, tests, packs, signs and publishes it with the registry entry updated in the same commit.

| slice         |      |     | title                                                                               | blocked by                      |
| ------------- | ---- | --- | ----------------------------------------------------------------------------------- | ------------------------------- |
| `sdk-21b`     | hitl | M   | Install from the running deployment — fetch, unpack, row, notify, uninstall         | `sdk-21a`, `sdk-20a`, `sdk-14a` |
| `sdk-22`      | afk  | M   | Air-gapped install and SPACES_PLUGINS — the same installer, two other doors         | `sdk-21b`                       |
| `backfill-13` | afk  | M   | Plugin upgrade — a new version dir, its own migrations, and a rollback that refuses | `sdk-21b`, `sdk-24a`, `sdk-20a` |
| `ship-9`      | afk  | M   | Changesets and the plugin tag — how a plugin reaches the registry                   | `ship-8`, `sdk-21a`             |

**▸ Webhooks and plugin schemas** — A signed payload returns 200 in milliseconds with the raw body retained and claims landing a moment later — on a raw route outside the versioned API namespace, because HMAC is computed over the exact bytes; a flipped byte is 401 and a disabled plugin is 404. A plugin owns tables in its own Postgres schema under a role that cannot write public, proven by a real RSS poller.

| slice     |      |     | title                                                                   | blocked by                                    |
| --------- | ---- | --- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `sdk-23`  | afk  | M   | Webhook ingress — verify in web, store, enqueue, return in milliseconds | `sdk-12b`, `sdk-20b`, `clean-credential-kind` |
| `sdk-24a` | hitl | M   | PluginDb — own schema, own journal, and a role that cannot touch public | `sdk-12a`, `mono-test-db-harness`             |
| `sdk-24b` | afk  | M   | plugins/rss — the first real PluginDb tenant, and the first poller      | `sdk-24a`, `sdk-7b`, `sdk-20b`                |

**▸ A plugin passes or does not ship** — Provider fakes and the chaos suite: with no API keys anywhere and the network off, SPACES_FAKE_PROVIDERS=1 gives a clickable Enrich with plausible data, and the chaos suite runs green.

| slice    |     |     | title                                                                 | blocked by                                 |
| -------- | --- | --- | --------------------------------------------------------------------- | ------------------------------------------ |
| `sdk-25` | afk | M   | Provider fakes and the chaos suite — a plugin passes or does not ship | `sdk-15`, `sdk-23`, `mono-test-db-harness` |

### 20. Storage sources — connect an account, attach a file

_Extensibility · 11 slices_

The provider registry, the consent dance split at the redirect boundary, token custody, the StorageSource read port with its fake and chaos list, the Drive plugin's read side, and attach-from-Drive. Needs the TLS overlay from project 1: Google and Box reject non-localhost http redirect URIs, so the dance cannot be proven without a real https origin.

**▸ Connect an account** — Register the Google app once without clobbering an existing Gemini key (credential.kind opened in project 3), click Connect and land on Google's own consent screen listing exactly the scopes asked for at the redirect URI Settings printed, then watch one encrypted grant row appear with its scopes and expiries. Scopes grow without a second account row, tokens refresh once under a cross-process lock so a rotating refresh token is never spent twice, and a revoked grant shows the provider's own reason.

| slice         |      |     | title                                                                  | blocked by                 |
| ------------- | ---- | --- | ---------------------------------------------------------------------- | -------------------------- |
| `storage-1`   | hitl | M   | Provider registry — one OAuth app per provider, in the vault           | —                          |
| `storage-2a`  | hitl | M   | The outbound leg — PKCE, a signed state, and the provider's own screen | `storage-1`                |
| `storage-2a2` | afk  | M   | The grant row — code exchange, provider identity, one encrypted bundle | `storage-2a`               |
| `storage-2b`  | afk  | S   | Incremental scopes — consenting to Drive never re-grants Calendar      | `storage-2a`               |
| `storage-3a`  | afk  | M   | Token custody — refresh under a row lock, revoke, one accessor         | `storage-2a`               |
| `storage-3b`  | hitl | M   | Settings → Connections — whose account, which scopes, disconnect       | `storage-3a`, `storage-2b` |

**▸ The port and its fake** — A read conformance suite green against an in-process fake Drive, plus the chaos list — 429, vanished files, expired cursors, a 200 MB scan — with the assertions proven real by flipping the fake's toggles. The reason Box later is one array entry rather than a project.

| slice        |     |     | title                                                                | blocked by                         |
| ------------ | --- | --- | -------------------------------------------------------------------- | ---------------------------------- |
| `storage-4a` | afk | M   | The StorageSource read port — a fake Drive and its conformance suite | `sdk-sdk-package`, `mono-packages` |
| `storage-4b` | afk | S   | The chaos list — 429, vanished files, expired cursors, a 200 MB scan | `storage-4a`                       |

**▸ A file arrives from Drive** — Paste a Drive URL or open the picker on a record: the file streams through the one intake module into our blob, is extracted, is searchable in Cmd-K, shows the folder path it came from and opens back in Drive — with the gone state and the Open-in-source action decided here, by the slice that first produces one.

| slice        |      |     | title                                                              | blocked by                                                     |
| ------------ | ---- | --- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `storage-5`  | afk  | M   | Google Drive plugin, read side — a bytes pipe with hints           | `storage-3a`, `storage-4a`, `sdk-loader`, `sdk-runjob`         |
| `storage-6b` | hitl | M   | Arrival from a link — paste a Drive URL, get the file and its path | `storage-6a`, `storage-5`, `storage-3a`, `sdk-integration-row` |
| `storage-7`  | hitl | M   | The provider picker — attach from Drive without leaving the record | `storage-6b`, `storage-2b`                                     |

### 21. A bound data room

_Extensibility · 9 slices_

storage_binding, first sync, resolveItem's match-only filing, the change poll, revisions, and the change table split one row per failure mode — renames and moves, gone pointers, tombstones and the expired-cursor re-list.

**▸ Bind a folder** — Link a Drive folder to a deal, company or space with overlap refused by name; the Files tab fills with 14 documents carrying their Drive paths, and re-running keeps the count at 14. Kind folders become kinds, company folders resolve through a match-only lookup that creates nothing, and a typo lands as a suggestion rather than as a company.

| slice        |      |     | title                                                                         | blocked by                                                          |
| ------------ | ---- | --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `storage-8a` | hitl | M   | storage_binding — one folder, one owner node, guarded at bind time            | `storage-7`, `storage-4a`, `docsurf-space-filing`                   |
| `storage-8b` | afk  | M   | First sync — a bound data room fills the Files tab, twice with the same count | `storage-8a`, `storage-6a`, `storage-5`                             |
| `storage-9`  | afk  | M   | resolveItem — folder names are hints, never identity                          | `storage-8b`, `ai-5`, `ai-8a`, `docsurf-1a`, `docsurf-2`, `clean-3` |

**▸ The change poll** — A cursor per drive and a filter per binding: new files inside the bound subtree arrive and files outside it do not, and edits become revisions keyed on the provider's revision id with the prior sha kept.

| slice         |     |     | title                                                               | blocked by                              |
| ------------- | --- | --- | ------------------------------------------------------------------- | --------------------------------------- |
| `storage-10a` | afk | M   | The change poll — a cursor per drive, a filter per binding          | `storage-8b`, `storage-9`, `storage-4b` |
| `storage-10b` | afk | M   | Modified files — the row advances, the prior sha becomes a revision | `storage-10a`                           |

**▸ The rest of the change table, one failure mode at a time** — A rename advances the path and a move across companies proposes rather than repoints; a provider-side delete and a file leaving the binding both mark the pointer gone with the same badge and propose nothing; an app-side delete leaves a tombstone and an expired cursor re-lists the whole bound subtree without resurrecting it — the two halves tested against each other, which is the only way either is proven.

| slice         |     |     | title                                                                        | blocked by                           |
| ------------- | --- | --- | ---------------------------------------------------------------------------- | ------------------------------------ |
| `storage-11`  | afk | M   | Renames and moves — the path advances, a crossing move is a suggestion       | `storage-10b`, `ai-suggestion-inbox` |
| `storage-11b` | afk | S   | Gone pointers — deleted at the provider, or moved out of the binding         | `storage-11`                         |
| `storage-11c` | afk | M   | The resurrection guard — a tombstone on app-side delete, and a clean re-list | `storage-11b`                        |

**▸ Retain per binding** — retain: text makes a 40 GB data room searchable without holding its bytes — ./data/blobs grows by nothing while Cmd-K hits the contents and preview streams from the provider — with the policy stated for the derived layers and the import payload too, not only for blobs. Flip to full and watch the backfill fill the disk.

| slice        |      |     | title                                                        | blocked by   |
| ------------ | ---- | --- | ------------------------------------------------------------ | ------------ |
| `storage-12` | hitl | M   | Retain policy — full keeps the bytes, text keeps the meaning | `storage-8b` |

### 22. Drive as the archive, Box on the same port

_Extensibility · 9 slices_

The write half of the port, write-through, the mirror root, live files proposing ledger events through the correction door, binding health, sensitivity riding the filing, and Box proved by a diff that shows no core file changed. Half of this is speculative until a real user asks — treat it as a backlog with an order.

**▸ Write-through and the mirror root** — ensureFolder, putFile, move and rename pass the extended conformance suite including the concurrent case. An upload on a bound record lands in Drive too with no duplicate row on the poll that sees it, and a mirror root fills Drive with the Space/Company/Deal/Kind tree the fund would have built by hand — lazily, sanitised, no empty folders.

| slice        |      |     | title                                                            | blocked by                                |
| ------------ | ---- | --- | ---------------------------------------------------------------- | ----------------------------------------- |
| `storage-13` | afk  | M   | The write half of the port — ensureFolder, putFile, move, rename | `storage-5`, `storage-4b`                 |
| `storage-14` | afk  | M   | Write-through — an upload on a bound record lands in Drive too   | `storage-13`, `storage-10b`, `storage-11` |
| `storage-15` | hitl | M   | Mirror root — Drive fills itself with the tree you'd have built  | `storage-14`                              |

**▸ Live files propose ledger events** — Follow a cap table and watch its revisions accumulate as an append-only ledger; change it in Drive and /inbox offers 'ownership moved 12.4% → 9.8%, propose a mark'. Accept and the holding's ledger gains one append-only row — through the same programs the import commit uses, so the append-only tables keep exactly one writer each.

| slice        |      |     | title                                                                        | blocked by                            |
| ------------ | ---- | --- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `storage-16` | hitl | M   | Live files — follow a Sheet, keep its revisions                              | `storage-10b`, `storage-8a`           |
| `ai-22`      | hitl | M   | Live-file revisions propose ledger events — the append-only tables' one door | `ai-8a`, `storage:document-revisions` |

**▸ Safe hands** — A revoked token or a departed binder surfaces on Today and on Connections and can be re-bound by another user whose access is checked first, resuming with no duplicates. Sensitivity is decided at ingest and rides from the binding down to the chunk, into the local embedding slot that has been waiting for it since project 11.

| slice        |      |     | title                                                                           | blocked by                                |
| ------------ | ---- | --- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `storage-17` | hitl | M   | Binding health — the binder left, the token died                                | `storage-8b`, `storage-3b`, `storage-14`  |
| `storage-18` | afk  | M   | The sensitivity stamp — one writer, raised in the transaction, lowered by a job | `ai-26`, `ai-12a`, `ai-10b`, `storage-8b` |

**▸ A second provider, no core diff** — A Box-first fund gets the same connect, bind, filing and write-through — single-use refresh tokens and an eventless items API absorbed inside the plugin — and the proof is git diff --stat showing no core file changed.

| slice         |     |     | title                                                  | blocked by                  |
| ------------- | --- | --- | ------------------------------------------------------ | --------------------------- |
| `storage-19a` | afk | M   | Box, read side — the same port, a second fake          | `storage-11`, `storage-4b`  |
| `storage-19b` | afk | M   | Box, bound and writing — the port measured by the diff | `storage-19a`, `storage-14` |

### 23. The researcher lane, syncers, recorders and feeds

_Extensibility · 8 slices_

The last unimplemented port goes live and every kind interface the SDK froze finally gets a tenant: a researcher, a syncer, an ingress, a poller. Placed last because each needs OAuth, the loader and the fakes — but every one of them is a channel CONTEXT names, and none of them may be dropped silently.

**▸ The last unimplemented port** — The Ai port's live layer with the sensitivity gate and the spend ceiling enforced by core rather than trusted to the plugin, tokens attributed to the integration and not to a user; then Exa as the researcher kind's first tenant — five web signals on a record and a one-paragraph brief in /inbox citing the five URLs.

| slice         |     |     | title                                                                          | blocked by                                             |
| ------------- | --- | --- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `backfill-11` | afk | M   | Ai port live — the researcher lane, budgeted and attributed to the integration | `sdk-12a`, `ai-4a`, `ai-26`, `backfill-4`              |
| `backfill-12` | afk | M   | plugins/exa — the first researcher, its signals and its brief                  | `backfill-11`, `sdk-12b`, `sdk-6b`, `sdk-7b`, `sdk-10` |

**▸ The first syncer** — Connect Google Calendar and let the schedule fire: this week's external meetings appear on the right companies' timelines with matched attendees, last week's do not, the internal standup never appears, and an expired sync token recovers without re-importing five years of history.

| slice       |     |     | title                                                                          | blocked by                                                                       |
| ----------- | --- | --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `arrival-5` | afk | M   | plugins/google-calendar — the first syncer, forward-only from the connect date | `arrival-2`, `sdk-4a`, `sdk-7b`, `sdk-12b`, `sdk-25`, `storage-2b`, `storage-3a` |

**▸ The first ingress** — A signed Fathom payload lands a call with its attendees, files the transcript on everyone in the room and links it back to the call; replay it and nothing doubles. The recorder's summary arrives as a suggestion you accept into a real editable note with the transcript cited — sdk-23's ingress stops having a fixture for a customer.

| slice       |     |     | title                                                                          | blocked by                                |
| ----------- | --- | --- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `arrival-6` | afk | M   | plugins/recorder — a webhook lands the transcript on the call                  | `arrival-2`, `sdk-23`, `sdk-8`, `notes-5` |
| `arrival-7` | afk | S   | The recorder's summary is a suggestion — accept it and the call has a write-up | `arrival-6`, `ai-15`, `sdk-10`, `notes-6` |

**▸ Feeds, and a mailbox that syncs itself** — A feed URL attached to a space or a record, polled on a cadence you can mute, items matched deterministically into signals with the unmatched kept visible because that is where the next company comes from. Then Gmail forward-only from the connect date, deduped against threads the forwarding lane already saw, with the privacy default decided, recorded and enforced at read time.

| slice        |      |     | title                                                                            | blocked by                                                                  |
| ------------ | ---- | --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `arrival-8`  | hitl | M   | feed and feed_item — one URL, three scopes, a cadence you can mute               | `sdk-24b`, `docsurf-1b`                                                     |
| `arrival-9`  | afk  | M   | Feed items match the graph — a signal on the record, the unmatched still visible | `arrival-8`                                                                 |
| `arrival-10` | hitl | L   | plugins/gmail — forward-only sync, and the privacy default finally decided       | `arrival-2`, `arrival-3`, `arrival-5`, `sdk-25`, `storage-2b`, `storage-3a` |

---

## 3. Decisions still ahead (18 of 48)

Every decision is closed; answers are in `docs/decisions-2026-09.md`. The full question, options and reversal costs are kept here only for decisions whose carrying slice has not shipped, because the ledger's "Option 1" means nothing without them. The 30 carried by shipped slices were removed 2026-09-27 and are in this file's git history.

### D7-entity-refs-and-plugin-fks

**What merge strategy and context role do this plan's roughly ten new entity-referencing columns get, and may a plugin's own schema hold a foreign key to `public.entity.id` at all?**

CLAUDE.md calls a missing ENTITY_REFS entry the worst bug of a review cycle; `entity-refs.test.ts` diffs the 25-entry list against drizzle's FK metadata and fails by name. This plan adds at least suggestion.entity_id, the generalized chunk.entity_id (ai-12a), job_run.entity_id (clean-2b), storage_binding.target_entity_id, document_revision.document_id, interaction.note_id (notes-5), import_row.entity_id and ai_run.caller_id. Separately, spec-plugin-sdk §8 explicitly permits `plugin_<id>.*` to FK `public.entity.id` — and the diff test only sees the core drizzle instance, so those FKs are invisible to it, unrepointed by the merge executor, and will raise an FK violation from a schema clean-7's delete executor does not know exists. The audit missed this entirely.

- **Every new column gets its ENTITY_REFS entry in the same PR as the column with `context` filled in as a deliberate null where it is never AI-visible; and plugin schemas may NOT FK public.entity.id — they store the uuid as a plain column and resolve through merged_into_id at read, exactly as citation refs do (D4)** — Merge and delete stay implementable by core alone with no knowledge of installed plugin DDL. Plugin rows survive a merge pointing at a loser and resolve correctly; a deleted entity leaves a plugin row whose resolve returns a tombstone. _Reversal cost:_ Low now (no plugin schema exists). High later: dropping FKs across installed plugin schemas is a migration core does not own.
- **Keep §8's FK allowance and teach the merge executor and clean-7 to enumerate plugin schemas** — Core gains a dependency on plugin DDL — the exact direction §8 forbids — and every merge does a catalogue scan. _Reversal cost:_ High: the executor's contract widens permanently and each new plugin can break a merge.
- **Forbid plugin references to entities entirely** — plugins/rss and Apollo lose the ability to record which record an item was about, which is their point. _Reversal cost:_ Moderate.

**Recommendation:** Option 1, carried by sdk-24a (which defines what a plugin schema may do) with the per-column entries landing in each column's own slice. Correct spec-plugin-sdk §8's FK sentence in sdk-24a's PR.  
The merge executor and the delete executor are the two consumers CLAUDE.md built the registry for, and both are core-only by design; a cross-schema FK quietly makes them plugin-aware. Deciding it now costs a spec sentence, deciding it after the first PluginDb tenant ships costs a migration in someone else's schema.

_Carried by_ `sdk-24a`. _Blocks_ `sdk-24b`, `sdk-9`, `clean-7`, `clean-2b`, `ai-12a`, `storage-8a`, `notes-5`, `ai-5`.

### D8-api-substrate

**Does the external API ride the `@orpc/experimental-effect` bridge, or on `effect/unstable/httpapi`, which is already installed?**

`@orpc/*` appears nowhere in package.json; the bridge was chosen 2026-09-04 against Effect v3's service APIs and is @beta, while the repo now runs `effect@4.0.0-rc.112`. I verified that the installed effect ships `effect/unstable/httpapi` with HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity, HttpApiScalar, OpenApi and HttpApiTest, plus `effect/unstable/rpc` beside it. oRPC's internal half — typed TanStack Query hooks — is already served by `createServerFn` across twenty modules in src/lib/server, so nothing internal is waiting on it. This is the concrete form of the risk CONTEXT recorded as "the Effect bridge is @beta", and nothing else in the api area can be specified until it is answered.

- **Build the external door on effect/unstable/httpapi; keep server-fns for internal calls; amend CONTEXT decision 3** — Zero new dependencies, version-matched to the Effect the repo already pins, OpenAPI and a Scalar page generated from the same definition, HttpApiTest for the tests. "One procedure serves both audiences" becomes "one HttpApi definition serves every external audience; internal calls stay server-fns" — which is what the repo already does. Settles the Zod-vs-Schema question with it: Effect Schema at the HttpApi boundary (it generates the OpenAPI), Zod stays at the server-fn boundary and in valueValidator, and the two never meet in one file. _Reversal cost:_ Moderate but bounded: handlers are Effect programs either way, so moving to oRPC later rewrites the definition shell, not the logic — provided handlers are written as bare programs the shell calls.
- **Spike @orpc/experimental-effect against the v4 rc first** — If it passes, one vocabulary for internal and external; if it fails, the whole external surface (capture, webhooks, MCP, n8n) waits on a @beta package's v4 support. Adds a dependency whose Effect-version coupling is the thing that already broke once. _Reversal cost:_ The spike is cheap; adopting it and reversing is not.
- **Pin an older Effect in the web process** — Two Effect versions in one repo, against the Effect ratchet CONTEXT records as the backend contract. _Reversal cost:_ High and compounding.

**Recommendation:** Option 1. Rewrite api-1 from "oRPC spike" to "HttpApi door — one definition, OpenAPI out", and record the amendment in CONTEXT with the reason (the named fallback now ships inside the pinned package).  
The bridge's entire advantage was one vocabulary across both audiences, and the internal audience already has a good answer that nobody is proposing to replace — so the bridge is being paid for with a beta dependency and a version-coupling risk in exchange for consistency the repo does not need.

_Carried by_ `api-1`. _Blocks_ `every other api slice`, `sdk-23`, `ai-23a`, `ai-23b`, `ai-24`, `the /api/capture slice`.

### D15-tags-registries-and-the-upgrade-window

**Does `latest` move, do we publish to Docker Hub as well as GHCR, and how far back does upgrade CI test?**

CONTEXT says multi-arch GHCR + Docker Hub, non-root UID 1000, and docs that tell people to pin tags — publishing a `latest` we then tell people not to use. It also says CI must test "the upgrade path from every prior release", which is unbounded. Three questions, one release pipeline, and they are cheaper answered together.

- **Publish `latest` plus `x`, `x.y` and `x.y.z`; docs pin `x.y.z`; GHCR only for v1; upgrade CI covers every tag in the current major plus the last tag of the previous major** — `docker pull <name>` works for someone evaluating the product in thirty seconds — the adoption moment CONTEXT calls the biggest win. One registry, one credential to rotate, no anonymous pull limits to explain. The upgrade window is affordable and still covers the realistic case (someone upgrading from a six-month-old tag). _Reversal cost:_ Adding Docker Hub later is a CI job. Widening the window later is a matrix entry.
- **No `latest`** — Consistent with pin discipline; surprises everyone who types the obvious command, and the first thing they see is an error. _Reversal cost:_ Low to add later.
- **`latest` plus both registries plus every tag ever in upgrade CI** — Two namespaces to defend, two credentials, and an upgrade matrix that grows without bound and eventually gets disabled — at which point it tests nothing. _Reversal cost:_ Removing a `latest` people already pull, or a registry they already depend on, is a breaking change you cannot take back.

**Recommendation:** Option 1, and correct CONTEXT in ship-11's PR: "every prior release" becomes the stated window, with the reason.  
`latest` is a trap only when the upgrade path is unsafe, and contract 5 plus ship-11 exist precisely to make it safe; refusing to publish it trades a real adoption cost for a hypothetical one. The asymmetry runs the other way for Docker Hub — adding is cheap, removing is not — so ship one registry and wait to be asked.

_Carried by_ `ship-8 (tags, registries) · ship-11 (window)`. _Blocks_ `ship-10`, `mono-13a`.

### D16-signing-scheme

**Do images and plugin tarballs share one signing scheme, or two deliberately different ones?**

ship's open questions ask for cosign + SLSA or nothing on images; sdk-21a is separately choosing between minisign/raw ed25519 and sigstore for plugin tarballs. Neither can be retrofitted gracefully once artifacts circulate. sdk-22 exists specifically for air-gapped installs, which constrains the plugin half.

- **Two schemes, deliberately: cosign keyless (GitHub Actions OIDC identity) plus SLSA provenance for images; a detached ed25519/minisign signature over the plugin tarball verified by the loader** — Images are verified by a human with a tool they already have and a transparency log they can check. Plugins are verified by the box itself, offline, with no sigstore client and no network egress in the install path — which is the only thing that works for an air-gapped install. _Reversal cost:_ Low to add a second scheme later on either side; the already-circulating unsigned artifacts stay unsigned either way.
- **Sigstore for both** — One vocabulary; drags a sigstore client and network access into the plugin install path of a self-hosted, sometimes-air-gapped product. _Reversal cost:_ High: sdk-22's whole premise breaks and the installer is rewritten.
- **Nothing** — Cannot be retrofitted for artifacts already in circulation; the registry sdk-21a signs against has nothing to check. _Reversal cost:_ Permanent for everything already published.

**Recommendation:** Option 1, recorded in CONTEXT with the reason stated as the verifier's identity: the image verifier is a human with cosign, the plugin verifier is our own loader with no network.  
"One answer for both" is appealing until you notice the two verifiers have nothing in common — one is interactive and online, one is a Node process that may have no internet at all. Matching the scheme to the verifier is the whole decision.

_Carried by_ `ship-8 (images) · sdk-21a (tarballs)`. _Blocks_ `sdk-21b`, `sdk-22`.

**Image half decided 2026-09-29 (owner): option 1** — cosign keyless + SLSA provenance, built by SPA-187 (`.github/workflows/release.yml`) and recorded in CONTEXT.md under Hosting. The plugin half stays with sdk-21a.

### D26-worker-bundler

**Which bundler produces the source-free worker image — tsup, which is not installed, or `vite build --ssr`, which is already in the toolchain?**

mono-13b removes src/ and tsx from the image, and docker/entrypoint.sh currently runs `node_modules/.bin/tsx` for both the migrate step and the worker, plus sdk-2's ROLE=worker health command. The spec names tsup; package.json has vite 8 (rolldown-backed) and no tsup. Adding a second bundler to the image build is an architecture commitment CONTEXT has not recorded.

- **`vite build --ssr` with three entries — worker, migrate, ROLE=worker health** — No new dependency, one bundler in the repo, same rolldown pipeline the web build already uses. _Reversal cost:_ Trivial: a build script and a config file.
- **tsup** — A second bundler and its config idiom, for a build the existing one can do. _Reversal cost:_ Trivial.

**Decided 2026-09-29 (owner): Option 1, `vite build --ssr`.** Built by SPA-185 (`mono-13b`) and recorded in CONTEXT.md (Stack, under the pin-discipline paragraph).

**Recommendation:** Option 1, with whichever wins recorded in CONTEXT and the reason stated.  
Nothing distinguishes the two for three Node entry points, and the tiebreaker is the frozen-dependency instinct the whole hostability contract runs on. The slice stays hitl only because someone should confirm the three entries actually boot in the pruned image.

_Carried by_ `mono-13b`. _Blocks_ nothing.

### D27-api-versioning

**One `/api/v1` namespace for everything external, or per-surface versions like `/api/capture/v1`?**

CONTEXT promises a versioned capture API, and the capture payload carries its own schema version — so there are already two clocks. The rule for which one moves, and what a v2 costs an extension installed on someone's laptop, should be written once rather than inferred by the third caller.

- **One `/api/v1` for every external procedure, plus the payload's own `schema_version`. The URL version moves only when an existing field changes meaning or disappears; additive fields never move it. The payload version moves when the extension's own shape changes** — An installed extension pins /api/v1 and keeps working for the life of v1; the two clocks have non-overlapping jobs, written down. _Reversal cost:_ Splitting one namespace later is a routing change plus a doc note.
- **Per-surface versions** — Capture, webhooks and MCP each version independently — flexible, and it means the answer to "what version am I on" is three answers. _Reversal cost:_ Merging two namespaces later is breaking for whoever adopted the second.
- **No version at all** — The first breaking change breaks an extension in the field with no migration path. _Reversal cost:_ High.

**Recommendation:** Option 1.  
There is one publisher and one consumer for the foreseeable future; the value of independent version clocks is entirely theoretical, while the cost of explaining three of them to the first integrator is not.

_Carried by_ `api-1`. _Blocks_ `the /api/capture slice`, `sdk-23`, `ai-23a`.

### D28-outbound-delivery

**Does the box ever POST events out, or is polling the read API the whole answer for n8n and the digest?**

CONTEXT's integration map #11 pairs "generic webhooks/API" and nothing in the 153 slices owns outbound event delivery or the digest channel. Outbound is a new subsystem — retries, per-endpoint secrets, a delivery log — and one that would want the same job_run table clean-2b is creating.

- **No outbound in v1. Ship the read API with a `?since=` cursor so polling is cheap and correct, and ship the digest as an internal consumer that sends through the existing optional SMTP_URL** — n8n polls, which is what n8n is good at; the digest needs no new transport. Record outbound webhooks as the deferred shape, reusing job_run for retries when it lands. _Reversal cost:_ Adding outbound later is additive. Note the ordering constraint: a cursor added later is a breaking read-API change, which is why it ships now.
- **Outbound webhooks now** — A retry subsystem, per-endpoint secret storage (needing D3's `webhook` kind) and a delivery ledger, for zero known consumers. _Reversal cost:_ Moderate, and it is a permanent surface once someone points an endpoint at it.
- **Neither — no read cursor, no outbound** — Polling means refetching everything, which is what makes people ask for webhooks. _Reversal cost:_ The cursor becomes a breaking change.

**Recommendation:** Option 1. The cursor is the load-bearing half and it is nearly free today.  
Outbound delivery is a subsystem justified by demand nobody has expressed, while the cursor is the cheap thing that makes its absence tolerable — and the one piece that becomes expensive if it is skipped.

_Carried by_ `api read-API slice`. _Blocks_ `the digest channel work`, `arrival-8`.

### D30-mail-body-and-privacy

**Where does a forwarded or synced email body live, and who can see it before the thread is attached to a deal?**

These two are entangled and must be answered together. CONTEXT's privacy block presumes bodies are stored and records the default as "decide deliberately"; notes-5 deliberately moved bodies out of `interaction` into notes via `note_id`; storing every forwarded mail as a note fills /notes with mail. The repo already has `visibility: shared | private` on note and a private-note carve-out enforced in SQL (see the `not exists … visibility = 'private'` clause in searchEntities).

- **The body is a note via `interaction.note_id`, born `visibility: 'private'` to the connecting user and flipped to `'shared'` when the thread is attached to a record. /notes excludes mail-born notes by default with a filter to include them** — Reuses the privacy machinery that already exists and is already enforced in search — no second access model. The body is searchable, embeddable and mentionable, which is the reason to store it at all. The /notes flooding problem becomes a query, not a schema decision. _Reversal cost:_ Moderate: unwinding to metadata-only means deleting note rows; going the other way is impossible because the bodies were never kept.
- **A body column on `interaction`** — Contradicts notes-5, splits body storage across two tables, and gets none of search, embedding or mentions for free. _Reversal cost:_ High — a migration plus two readers.
- **Metadata and attachments only** — Cheapest and the safest privacy answer; loses the one sentence in a forwarded intro that actually matters ("intro from X, raising Y at Z"). _Reversal cost:_ Unrecoverable: bodies not stored cannot be recovered later.

**Recommendation:** Option 1, carried by arrival-1, with the workspace default expressed as a single setting (bodies private-until-attached) rather than a per-connection exclude list in v1.  
The privacy question already has a shipped answer in this codebase — private notes — and mapping mail onto it means one visibility model instead of two, with the search carve-out already written. It also makes the escalation's two questions collapse into one setting.

_Carried by_ `arrival-1`. _Blocks_ `arrival-2`, `arrival-10`, `notes-5`.

### D31-forwarding-transport

**How do forwarded emails actually reach the box — IMAP poll of an operator-owned mailbox, an inbound SMTP listener, or a provider webhook?**

A forward IS the consent model, which is why this is the first arrival channel in CONTEXT's sequencing instinct. Nothing in CONTEXT or the specs picks a transport, and the required-env set is frozen at {DATABASE_URL, APP_URL} with every feature shipping a working default or being optional.

- **IMAP poll of an operator-owned mailbox** — Zero OAuth, one app password, no new port, no MX record, no external account — and it is optional by construction (no mailbox configured, no lane). Costs polling latency, measured in a minute or two. _Reversal cost:_ Low by construction: the parser and the filing path are identical under all three options; only the transport module changes.
- **Inbound SMTP listener with MX records** — A real MTA and a second exposed port on a two-container product, plus spam handling the operator now owns. _Reversal cost:_ Low code-wise, high operationally once an address is published.
- **An inbound-email provider webhook (SES/Postmark)** — Best latency and no mailbox to own; requires an external account, which breaks "every feature ships a working default or is optional" for the first arrival channel. _Reversal cost:_ Low.

**Recommendation:** Option 1.  
It is the only option that satisfies the frozen-env rule for the channel CONTEXT wants first, and because all three share the parser and the filing path, picking the cheapest now costs almost nothing if it later proves too slow.

_Carried by_ `arrival-1`. _Blocks_ `arrival-2`, `arrival-10`.

### D33-feeds-core-or-plugin

**Is the RSS feed poller a plugin, or core?**

CONTEXT calls feeds "the one capability with no vault dependency; dormant until the first feed URL", which reads core; spec-plugin-sdk §5 lists `poller: { poll() → Item[] } // RSS`, which reads plugin. arrival-8 assumes the plugin, which means a deployment with no plugins installed can attach a feed and never poll it — the slice makes that state legible rather than silent, but it is still a feature that does nothing.

- **Core owns a default RSS fetcher; the SDK's `poller` kind stays for feeds that need credentials or a vendor API** — Attaching a feed works on a box with zero plugins, which is what the CONTEXT sentence promises. RSS parsing is a small, dependency-light amount of code. _Reversal cost:_ Low: moving core RSS into a plugin later is a file move.
- **Plugin only (arrival-8's assumption)** — A legible failure is still a failure — the user attaches a feed, sees an explanation, and installs a plugin to make a URL poll. _Reversal cost:_ Low, but the support conversation happened.
- **Both, core as fallback** — Two code paths for one behaviour and an ambiguous answer to "which one polled this?" _Reversal cost:_ Moderate.

**Recommendation:** Option 1, carried by arrival-8, with spec-plugin-sdk §5's poller example changed from RSS to something that actually needs the port.  
"Dormant until the first feed URL" is a core-capability sentence, and a capability whose default state is inert unless you install something is the kind of quiet disappointment that makes a self-hosted product feel unfinished.

_Carried by_ `arrival-8`. _Blocks_ `the feed-scopes slice`.

### D34-participants-and-interactions

**Which email participants become people, and does an all-internal calendar meeting become an interaction at all?**

Two halves of one policy. CONTEXT says forward-only sync makes "create all, visible" obvious; the Twenty survey's takeaway is SENT-only creation plus a free-email-provider list — and a forwarding mailbox has no sent folder for the SENT rule to read. Separately arrival-5 assumes an all-internal meeting is noise, but that rule silently drops the partner-meeting record of an IC discussion, which is precisely the kind of thing a fund wants on a deal's timeline. The free-email-domain list would be a new in-repo data file nobody currently owns.

- **Create-all-visible for people, minus a shipped free-email-domain list (gmail, outlook, yahoo, proton, icloud and ~30 more) which never mints a company — only a person; and a meeting becomes an interaction when it touches the graph (an attendee or the title resolves to a record), not when an external attendee is present** — The IC discussion lands on the deal's timeline; no "gmail.com" company is ever created; the domain list is a tested data file owned by the arrival area. _Reversal cost:_ The list is data and the rule is a predicate — both cheap. What is not cheap is the thousand junk rows created under a wrong rule before it is fixed.
- **Create-all with no domain list** — Companies named after email providers, and a dedupe inbox full of them. _Reversal cost:_ Merging or deleting them by hand.
- **SENT-only creation** — Unimplementable on the first channel — a forwarding mailbox has no sent folder — so it can only ever be a later Gmail-sync refinement. _Reversal cost:_ n/a

**Recommendation:** Option 1, carried by arrival-2, with the domain list landing as a tested data file in the same slice.  
Create-all is right for forward-only consent, the domain list is the one cheap guard that prevents the characteristic failure, and reframing the calendar rule from "are all attendees internal" to "does it touch the graph" keeps the case the naive rule loses.

_Carried by_ `arrival-2`. _Blocks_ `arrival-5`, `arrival-10`.

### D38-retention-of-derived-layers-and-payloads

**When `retain: text` throws the bytes away, what happens to the page-image cache, the extraction cache, the import payload blob, and the import_batch/import_row rows?**

storage-12's retain policy is per storage binding and says nothing about anything derived. The page-image cache can be larger than its source blob; the extraction cache is sha-keyed so re-asking is free; a portfolio spreadsheet sitting in the blob store forever is both the audit trail and the most sensitive object in the workspace; and import_batch/import_row hold a verbatim copy of every cell of the user's file in Postgres indefinitely. Three areas raised this independently.

- **One rule: derived layers are sha-keyed caches — bounded by a size budget (a setting, default 2 GB), LRU-evicted, rebuildable, and simply absent under retain:text, which is the policy working rather than a bug. Authored inputs are records: the import payload follows retain:full for 90 days then drops to text (the grid lives in import_row anyway); import_batch/import_row are kept until the batch is reversed or explicitly pruned, because the per-row receipt is what makes D12's reversal legible** — A tar of ./data stays a sane size; the audit trail survives; the one sensitive artifact (the raw spreadsheet) ages out while its structured record stays. _Reversal cost:_ Raising a bound later is a setting; data deleted under a bound that was too tight is gone — which is why import_row is on the keep side of the line.
- **Keep everything forever** — A page-image cache larger than its source in a product whose backup story is tarring a directory. _Reversal cost:_ Low to bound later, but the disk was already full.
- **Bound everything including import_row** — The per-row receipt disappears and a reversal cannot name what it reverses. _Reversal cost:_ High — the receipts are unrecoverable.

**Recommendation:** Option 1, carried by storage-12 so the retain policy covers derived layers in the same sentence it covers bytes.  
The distinction that makes all four cases fall out is cache versus record: anything rebuildable from bytes or from a model is a cache and gets a bound, anything a human typed or uploaded is a record and gets kept. Both import questions and the backfill question are the same question under that rule.

_Carried by_ `storage-12`. _Blocks_ `import-9`, `ai-21`, `ai-6`, `the page-image slice`.

### D39-importer-parse-signature

**Does a plugin importer's `parse(file)` return a grid for the mapping wizard, or Claims?**

This is called out as the hitl decision inside import-10, and it also pins `parse`'s signature in a semver-frozen SDK surface — so it is really an sdk-4a decision that import-10 inherits. spec-plugin-sdk §5 already describes the importer kind as `parse(file) → Claim[]`.

- **Claims. The core CSV path keeps its grid internally and converts to claims at the same seam, so there is one commit path** — Claims are the vocabulary every other plugin kind already speaks; they route through the same resolve, dedupe and suggestion machinery; a dialect plugin (Airtable, Notion) knows its own semantics better than a column-mapping UI can infer them. _Reversal cost:_ Widening later to `Claim[] | Grid` is additive.
- **A grid** — The mapping wizard works for plugin dialects too — the one real argument — at the cost of freezing a UI's internal shape into a permanent contract. _Reversal cost:_ High: narrowing a frozen SDK return type is breaking for every installed plugin.
- **A union of both** — Two commit paths and two failure modes inside a semver-frozen surface. _Reversal cost:_ Very high — you can never remove either arm.

**Recommendation:** Option 1, carried by sdk-4a since that is where the kind interfaces freeze; import-10 becomes a consumer.  
The asymmetry decides it: claims can grow into a grid later, a grid can never shrink into claims, and the surface is explicitly semver-frozen. It also matches what the spec already wrote.

_Carried by_ `sdk-4a`. _Blocks_ `import-10`.

### D40-safe-instrument-default

**Should an unmapped "SAFE" in an imported sheet be refused, or default to post-money?**

import-8 refuses rather than guessing, which is right for correctness but costs a click on nearly every angel sheet. Post-money has been YC's standard since 2018; pre-money SAFEs dominate 2016–2018 vintages, which is exactly the back-catalogue a bootstrap import contains. This is a domain call, not an implementation one.

- **Keep the refusal, and add a workspace-level declared default (`safe_default: post | pre | none`, default none) set once in the import wizard** — Correctness stays the shipped behaviour; the click is paid once per workspace rather than once per row; the setting is visible so nobody is surprised by what was assumed. _Reversal cost:_ A setting is a setting; wrongly imported instruments are a ledger correction under D12.
- **Default to post-money silently** — One less click on modern sheets, and every pre-money SAFE in an older portfolio is mis-valued with no signal. _Reversal cost:_ High — it produces exactly the wrong committed ledger rows D12 exists to fix.
- **Refuse always with no setting** — Correct and tedious; a 40-row import becomes 40 clicks. _Reversal cost:_ Low.

**Recommendation:** Option 1.  
The refusal is the right default and the setting is the right escape; guessing silently on the one field that changes a valuation is how an import quietly produces a wrong portfolio.

_Carried by_ `import-8`. _Blocks_ `import-9`.

### D41-ai-mapping-write-doctrine

**When AI proposes a column mapping, is that a `suggestion` row or a pre-selected control the human confirms?**

Every import slice is deterministic today, so import works with no provider configured and required env stays frozen — deliberate. When AI mapping arrives, the answer decides whether the mapping step is ever a machine write, and the same question returns for ai-17's and ai-18's cell-level proposals, so the doctrine sentence is worth writing once.

- **A pre-selection the human confirms, plus one written doctrine line: an AI proposal becomes a `suggestion` row when it would otherwise write without a human present; a pre-filled control in front of a human is not a machine write** — No queue entry per column per import; the doctrine's actual purpose (never silent) is satisfied by the confirmation screen itself. The line then answers the same question for ai-17 and ai-18. _Reversal cost:_ Promoting a pre-selection to a suggestion row later is additive.
- **Suggestion rows for mappings** — /inbox fills with rows the user already answered in the wizard, and "accept all" starts operating on decisions that were already accepted. _Reversal cost:_ Low, but the inbox's credibility is the cost.
- **No AI mapping** — Fine today; the question returns unanswered the moment anyone asks for it. _Reversal cost:_ n/a

**Recommendation:** Option 1 — and land the doctrine sentence in CONTEXT before ai-17 and ai-18 ship, not when AI mapping is built.  
"AI writes are suggestions, never silent" is about absence of a human, not about the existence of a model; without that distinction written down, every future confirmation screen argues about whether it needs a queue.

_Carried by_ `the AI-mapping slice (deferred); the doctrine line lands in CONTEXT with ai-17`. _Blocks_ `ai-17`, `ai-18`.

### D42-export

**Can a user get their data back out, and who owns that?**

The import area is migration-in only; nothing in CONTEXT or the specs covers migration-out. A self-hosted product whose pitch is "you own your data" and which cannot hand the data back is making a lock-in claim it presumably does not intend. The attribute registry already describes every column, so the work is mostly enumeration.

- **One v1 slice: a workspace export writing a zip of CSVs (one per object, from the same registry the import reads), notes as markdown, documents as a manifest plus the blob tree** — The ownership claim becomes true; it doubles as the user-facing half of the backup story beside pg_dump; it is cheap because the registry is the schema. _Reversal cost:_ Additive, but the longer it waits the more surfaces it must cover.
- **pg_dump is the export** — True for the operator, useless for a user who wants their deal flow in a spreadsheet. _Reversal cost:_ Low.
- **Defer** — The claim stays unbacked for the whole of v1 — and it is the claim the product is sold on. _Reversal cost:_ Low technically; it is a credibility cost.

**Recommendation:** Option 1, as a new slice in the import area (which should be renamed "import and export").  
It is the obvious twin of the work already being planned, it reuses the same registry walk, and it is the cheapest possible defence of the sentence the whole product rests on.

_Carried by_ `a new export slice (import area)`. _Blocks_ nothing.

### D43-import-entry-point

**Does the getting-started card gain an Import step, and does /today surface a staged-but-uncommitted batch?**

The import is the first thing a real user does and it currently has no entry point on the landing page. The getting-started card is 5/5 today, and Today is the surface built for unfinished business.

- **Yes to both: Import becomes a step (5/5 → 6/6) and a staged batch shows on Today as "42 rows staged — finish import"** — The onboarding-critical feature is findable, and an abandoned half-import is visible rather than silent. _Reversal cost:_ Trivial.
- **Settings only** — The wizard exists and nobody finds it in the first session, which is the only session that matters for it. _Reversal cost:_ Trivial.
- **Card step but no Today cell** — A half-finished import goes quiet, and staged rows sit in import_batch forever. _Reversal cost:_ Trivial.

**Recommendation:** Option 1.  
Both halves are small and both address the same failure — an import that is hard to start or easy to abandon silently. There is no argument against except step-count tidiness.

_Carried by_ `the import wizard slice`. _Blocks_ nothing.

### D47-plugin-rollback-entry-point

**How does an operator roll back a bad plugin upgrade on a box that ships no CLI?**

Spec §10 names `plugin rollback` as a command and this product ships no CLI; backfill-13 pins "no CLI, the ledger says whether restore is required", which leaves the genuinely safe case — a rollback where no forward migration ran — with no one-click path. The upgrade flow keeps the previous version directory one back.

- **A button on the Integrations ledger row — "Roll back to <version>" — shown only when the previous version directory exists AND no forward migration ran; when a migration did run, the button is absent and the row says restore-from-backup is the only rollback** — The safe case is one click; the unsafe case is told the truth rather than offered a button that would silently revert a schema the new version wrote. _Reversal cost:_ Additive either way.
- **Ledger text only, no action (backfill-13's pin)** — An operator facing a broken plugin uninstalls instead, losing the plugin's data — the worse outcome the button exists to prevent. _Reversal cost:_ Low.
- **Always allow rollback** — Reverts code against a schema the new version already migrated, which is data loss dressed as a safety feature. _Reversal cost:_ Unrecoverable.

**Recommendation:** Option 1, carried by the plugin-upgrade slice the audit adds (not by backfill-13 alone, since the version directory and the migration ledger are that slice's).  
The condition that makes rollback safe — no migration ran — is already recorded, so gating the button on it costs a predicate and converts a documented dead end into a click.

_Carried by_ `the plugin-upgrade slice (sdk area)`. _Blocks_ nothing.

## 4. Audit findings still open

From the second audit (2026-09-15), only the findings that touch a project not yet shipped. Check each against the slice body when its project is published; some may already have been folded in.

### New collisions introduced by this pass (11)

- `backfill-3` `import-2` `backfill-9` `storage-12` — Three subsystems deliberately create blobs with no document row, and only one of them is known to the sweep that reclaims blobs with no document row. backfill-3 (P8) ships the orphan-blob sweep with a 'pending_blob intent row on both writers' and 'one shared is-any-row-on-this-sha helper'. import-2 (P14) stages the import payload as a blob that deliberately never becomes a document and is kept forever as the audit trail. backfill-9 (P12) writes one blob per page image with its own mapping table. The sweep ships six projects before the first violator and twelve before the second.  
  **Fix:** Make the ownership helper an interface, not a list: backfill-3 defines blobOwners[] and its acceptance requires every later blob writer to register. Add import-2 and backfill-9 as declared owners in their own acceptance criteria, and extend the D38 sentence in storage-12 to say the sweep, not only retain policy, must honour them.
- `import-5` `storage-9` `arrival-2` — Three areas each build a match-only / dry-run resolve over src/lib/entities/resolve.ts. storage-9's body already ships `resolveEntity({createIfMissing:false})` returning `{action:'attached'|'fuzzy'|'no_match', candidates}`. import-5's own notes say 'resolveEntity has no dry-run mode... the spec's resolve-preview needs a read-only twin over the same normalizers'. arrival-2 owns src/lib/arrival/participants.ts as 'the single creation policy for mail, calendar, recorder and Gmail'. Nothing blocks any of them on the others. This is the duplicate-evaluator failure repeating on the identity door.  
  **Fix:** import-5 (P14) is the first to land and becomes the owner of the createIfMissing:false seam with the return shape pinned; storage-9 (P21) is blockedBy import-5 and deletes that criterion; arrival-2 (P13) — which lands earliest of all — either owns the seam instead or is blockedBy nothing and calls it, but one of the three must be named in the other two's bodies.
- `api-6` `views-3` — api-6 pages through records for external consumers; views-3 (P9) builds keyset pagination with a server-computed honest count for the same rows. The api area was written before the views area existed — its collisionsAvoided names docsurf-12b and ai-18 but not views at all — so api-6 has no views-3 edge and will invent a second cursor scheme over the same query.  
  **Fix:** api-6 ← views-3, and its acceptance states it returns views-3's keyset cursor verbatim rather than a page/offset or an opaque id of its own. Same edge for api-6 ← views-2 if any external filter ever lands (today api-6 correctly ships none).
- `arrival-4` `ship-6` `mono-13a` `ship-8` — Two new areas each introduce a headless browser without seeing the other. arrival-4 (P13) snapshots DocSend/Pitch links and carries D32, 'does a headless browser ship in the default image'. ship-6 (P16) installs Playwright and a real Chromium for CI. mono-13a/ship-8 own the image contents and its size. Nobody reconciles one browser dependency across runtime and test, and the ship area's notes never mention arrival-4.  
  **Fix:** Answer D32 in ship-8 (image contents) rather than in arrival-4, and record the answer in arrival-4; if Chromium ships, ship-6 reuses the image's browser instead of installing a second one, and the 400 MB is charged once in the before/after size record mono-13a already owes.
- `ship-1` `ship-3` `ship-8` `sdk-2` `mono-13a` `ship-10` — Five slices across two new areas and one old one author the compose overlay set and the README with no stated ownership. sdk-2 (P2) ships docker-compose.split.yml and 'references it from the README'. ship-1 (P1) rewrites the README, which the ship notes record is still the TanStack Start template verbatim including a section on removing Tailwind. ship-3 (P1) adds docker-compose.tls.yml against `build: .`. mono-13a (P16) re-points both compose build contexts. ship-8 (P16) pins published tags in compose. ship-10 (P16) writes install docs and its own open question asks where docs live.  
  **Fix:** Name ship-1 the owner of README structure (it already owns the wordmark), give it a named section sdk-2 appends to, and give ship-8 one criterion that re-points every overlay file by name (docker-compose.yml, .tls.yml, .split.yml) when the build context becomes an image tag.
- `arrival-9` `backfill-12` `sdk-7b` `arrival-8` — Two writers of `signal` on a record, and the decision that separates them (D33, is the feed poller core or a plugin) is unresolved. arrival-9 owns src/lib/arrival/match.ts as 'the only deterministic graph matcher' writing signals from feed items; backfill-12's Exa researcher produces 'five web signals on a record' through sdk-7b's signal lane. Both land in P23. If feeds are core, arrival-9 is a second signal writer beside sdk-7b's port; if they are a plugin, arrival-8's core feed/feed_item tables have no fetcher.  
  **Fix:** Answer D33 in arrival-8 before P19 (sdk-24b already depends on it), and state in arrival-9's body whether it writes signals directly or through sdk-7b's Content port, so the repo has one signal writer per actor class rather than two per row.
- `design-5` `api-3` `backfill-4` — The settings-shell dependency list is incomplete. The dep-fix routes ai-3a, ai-4b, ai-25, sdk-20a, storage-1, storage-3b, storage-17, ai-9a, ai-13 and sdk-21b through design-5, but omits api-3 (mints a personal token from a settings surface) and backfill-4, which is literally the missing fifth section of Settings → AI (Providers · Routing · Embeddings · Usage · Caps). Two more settings surfaces get to invent their own home.  
  **Fix:** api-3 ← design-5 and backfill-4 ← design-5, with backfill-4's Caps section declared as a SettingsSection in the ai group so the five-section spec is closed by construction.
- `storage-6a1` `storage-6a2` `api-4` `import-2` `arrival-3` `arrival-10` — The one-time widening of document birth and server intake names two future callers and misses two. The changeLog says storage-6a1/6a2 'must accept an in-memory payload with a caller-supplied name and mime (api-4 and import-2 both arrive with no stream and no content-length)'. arrival-3 (mail attachments, decoded MIME parts) and arrival-10 (Gmail attachments) have exactly the same shape and both land in P13/P23, after the widening is frozen. The whole point of widening once was to avoid a second widening.  
  **Fix:** Add arrival-3 and arrival-10 to the named callers in storage-6a1/6a2's acceptance so the signature is widened once for four callers, not twice for two.
- `import-2` `views-3` — Two new areas take opposite positions on holding every row in the browser. views-3 establishes that a table cannot hold every row and pages on a keyset cursor with an honest count; import-2 renders the whole parsed spreadsheet as one client-side grid with no row bound stated anywhere, and import-1's parse loads the file into memory. A 20,000-row xlsx is exactly the onboarding case the area exists for.  
  **Fix:** import-2 states a row cap and what happens above it (preview the first N with the count, or refuse with the number), and import-1 states a file-size guard reusing docsurf-6a's existing MAX_UPLOAD_BYTES rather than inventing a second one.

### Still missing (10)

- Opt-in nightly conformance against real provider sandboxes — a dedicated Google Cloud project and a Box developer account, secrets in CI, failures open an issue and never block PRs. This was audit missing[] #32 and it is the only entry of the 34 with no carrier after the merge. storage-4a/4b and sdk-25 test fakes only; ship-11 is upgrade CI; sdk-25 is explicitly 'with no API keys anywhere and the network off'. The backfill area listed 'nightly provider sandboxes' in its deliberately-not-sliced hand-off to the new areas, and none of the seven new areas picked it up. Without it the claim 'a plugin passes or does not ship' and the whole StorageSource port conformance story rest entirely on our own fakes. — storage-20 — Nightly sandboxes: the conformance suite against a real Drive and a real Box, non-blocking, issue on failure (project 20 or 22)
- Changesets itself. Audit missing[] #31 asked for 'changesets versioning and tag-driven release CI (image on core@x tags, plugin release on plugin-<id>@x tags)'. The merge covers only the second half: ship-8 publishes images on a tag and ship-9 publishes a plugin tarball on a plugin tag. Nothing installs changesets, bumps versions across the workspace packages, or generates a changelog — and project 19's milestone text already says 'Merge a changeset and a plugin-<id>@x tag builds...', i.e. it assumes a tool no slice adds. mono-1b owns turbo.json and the task graph but not versioning. — mono-1c or ship-8b — Changesets in the workspace: version bumps, changelog, and the core@x / plugin-<id>@x tags the two release jobs consume
- The two acceptance-criterion edits the backfill area explicitly handed back for gateway passthrough (audit missing[] #22) were dropped in the merge. backfill wrote no slice because ai-3a/ai-3b already ship baseURL + headers, but it handed back: (a) ai-3b's criteria test only baseURL, so add one for the extra-header rows round-tripping through credential.meta; (b) ai-9a must thread the same credential.meta into the embed adapters or the gateway rule holds for llm providers only. The reconciled dep-fix edits ai-9a's signature for sensitivity and says nothing about meta. — No new slice — two acceptance bullets: one on ai-3b (header rows round-trip), one on ai-9a (embed adapters read credential.meta baseURL + headers)
- MIS + runway lens. ARCHITECTURE §12's post-v1 backlog reads 'dark theme · MIS + runway lens · scorecards · meeting-prep briefs, pass-letter drafting...'. backfill-14 records four banked features as deferred (meeting-prep brief, pass-letter drafting, the Monday brief/digest, deal scorecards) per audit #33, and project 12's milestone text says 'four banked features'. MIS + runway lens is the fifth and appears in neither the plan nor the deferral register — despite CONTEXT carrying a fully-formed shape for it (Visible-style: standard six metrics, tokenized founder links, dual-path structured requests plus parsing what founders send). — No new build slice — backfill-14 records five banked features, not four, with MIS + runway lens and its trigger (the first portfolio a fund actually monitors)
- DESIGN.md §5 (Components) — the '/impeccable document' item in CONTEXT's UI craft debt 'Still open, in order', explicitly sequenced after the sweep. design-2 writes docs/design-contract.md (an operational document for agents choosing a pattern) and design-4 adds three primitives; nothing documents the component inventory in DESIGN.md. The design area's own open question #6 asks which of the two files is source of truth once both exist and proposes a rule — that rule is not written into any slice either. — design-11 — DESIGN.md §5: the component inventory after the sweep, and the one rule for which document new decisions land in
- The design deferral list, and CSV's reversal out of it. CONTEXT says 'Also carry into any design run: the deferral list, or an Attio-shaped brief will propose most of it back. Deferred by name: saved/shared views, bulk edit, calculations row, CSV, virtualization + keyboard-grid, kanban, drawer-over-table, Overview/Highlight cards.' Nothing in design-2's contract is said to carry that list. Separately, the plan reverses one entry — CSV becomes an entire twelve-slice project 14 — and no slice amends CONTEXT to record the reversal, while views-3 quietly answers 'virtualization' with pagination instead and views-5 documents 'kanban' as the deals-board exception. — No new slice — design-2's contract carries the deferral list verbatim, and import-1 amends CONTEXT to record CSV moving from deferred to shipped with the reason
- CLAUDE.md gate 5 and mono-6's gate-5 CI step after design-1. design-1 turns the banned-token grep into lint rules, but the merge only adds mono-6 ← design-1 'or its gate-5 CI step ships permanently red'. mono-6's acceptance on disk still reads 'ci.yml runs all five gates as separately named steps: prettier, eslint, tsc, the gate-5 token grep, and vitest' and 'the gate-5 step passes on a clean tree (the grep-exits-1 inversion is in place)'. Nobody rewrites CLAUDE.md's gate-5 block either — the text every agent reads, and the text the slice contract's last acceptance line points at. The design area's own finding is that the grep bans a vocabulary already at zero and misses what is live (border-sidebar-border at _app.tsx:61, bg-sidebar, the --color-sidebar-_/chart-_/card*/accent*/secondary* exports at styles.css:238-250), so leaving it in CI is a permanent false gate. — No new slice — design-1's acceptance rewrites CLAUDE.md gate 5 to 'the rules are in pnpm lint' and mono-6 drops the grep step, leaving four named gates
- apps/site. spec-plugin-sdk §2's monorepo layout lists apps/site (marketing/docs, on Vercel, never in the image) as a later app, and ship-10's own open question asks whether install/upgrade docs should live in docs/ or be read by apps/site. mono-1 creates apps/web only. Unlike apps/extension — which the api area deliberately and explicitly defers with its reason recorded — apps/site appears in neither the plan nor any deferral note. — No new slice — ship-10 records apps/site as deferred with its trigger (the first doc page that needs to be public), and says docs/ is the source those pages would read
- Rate limiting on the public door. api's own open question: there is no rate-limit code anywhere in src, required env is frozen at {DATABASE_URL, APP_URL} so there is no Redis, and api-3/api-4/api-5 open a token-authenticated endpoint on a self-hosted box that enqueues AI work. The merge neither slices it nor records it as deliberately deferred, while ship-3's Caddy overlay — the natural place to delegate it — is authored fifteen projects earlier with no mention. — No new slice if deferred — api-3 records the decision (per-token Postgres counters vs delegate to the proxy vs nothing) and ship-3's Caddyfile carries the commented-out rate-limit stanza if the answer is 'the proxy'
- sdk-15's split. The reconciled plan itself flags this as the one audit finding it did not answer: sdk-15 is an undeclared L carrying the provider client, the header-driven self-throttle, bulk endpoints, response normalisation into claims, receipts, Apollo's own error text and the wired job. It gates sdk-16, sdk-17, sdk-19 and sdk-25 and sits at the head of project 18. — sdk-15a — Apollo provider client and claim mapping, cassette-tested with no DB; sdk-15b — the wired enrich job, receipts and the visible error text

### Ordering violations (10)

- sdk-24b (project 19) is blockedBy arrival-8 (project 23) — the only backward cross-project edge in the merged graph, and it comes straight from the arrival dep-fix ('sdk-24b ← arrival-8, with feeds and per-guid dedupe moving to core feed/feed_item'). Either arrival-8 moves into project 19 beside sdk-24a/sdk-24b, or sdk-24b ships plugin_rss with its own feed_item and arrival-8 later migrates it — which is the two-feed_item-tables outcome the dep-fix exists to prevent.
- mono-7 (project 2) is given a move list containing files that do not exist until projects 9 and 14. The dep-fixes say 'mono-7's move list gains import/read.ts, coerce.ts and ledger.ts' (import-1/import-8, project 14) and 'mono-7's move list gains the shared fixture file views-2 adds beside filter.ts' (project 9). mono-7 cannot move either. The views half needs no fix at all — views-2 can write its fixture beside filter.ts, which is already inside packages/core after mono-7 — and the import half must instead be an acceptance bullet on import-1/import-8 saying the pure modules are born in packages/core.
- mono-9c (project 2) is told 'QUEUES gains import.commit' — a queue whose job is created in project 14 — and this directly contradicts mono-9c's own acceptance criterion on disk: 'Queue name strings are unchanged in this slice — grep the four values before and after and diff empty'. Drop the instruction; import-6/import-9 append to QUEUES when they land.
- mono-11a (project 15) is now the one-time queue rename, but projects 5-14 add roughly ten more queues before it: document.clip (docsurf-10a), the blob sweep (backfill-3), the classify/summarize/extract/vision lanes (ai-14/15/16/21), the embed backfill (ai-13), import.commit (import-6/9), the mail, calendar and feed pollers (arrival-1/5/8), the snapshot job (arrival-4). Its acceptance still says 'registers the four queues' and 'behaviour untouched'. Worse, no convention is stated for queues created in between — storage-8b's acceptance already writes core.storage.sync at project 21 — so mono-11a inherits a half-renamed tree rather than a clean one.
- docsurf-6b is blockedBy backfill-3 but backfill-3 is listed after it inside the same milestone (project 8, positions 5 and 7), and the milestone narration puts the sweep last ('Then bytes stop needing a record: global upload... and a scheduled sweep that reclaims bytes whose finalize never arrived'). Either reorder the milestone so backfill-3 precedes docsurf-6b, or drop the edge and let docsurf-6b state 'aborted uploads are reclaimed by backfill-3' as a forward reference rather than a blocker.
- All three publishNow projects have blockedBy edges into projects that are explicitly not publishable. Project 2: mono-1 ← ship-1 and mono-6 ← design-1, both in project 1, whose bodies are owed. Project 5: objects-2/objects-1a ← clean-1 and objects-7 ← clean-3, both project 3, waiting on clean-2c's body and D1. Project 6: notes-5 ← clean-4 (project 3) and notes-2/notes-3 ← design-8a (project 4, nine unwritten bodies). Publishing 2, 5 and 6 now creates Linear relations pointing at issues that do not exist — the same dangling-relation failure the placeholder-resolution gate was raised to prevent.
- Project 2's summary still reads 'The first ten, one agent at a time, is now sdk-1 · sdk-2 · mono-1a · mono-1 · mono-1b · mono-2 · mono-3 · mono-4 · mono-5 · mono-6' — written before project 1 existed. mono-1 ← ship-1 and mono-6 ← design-1, so the true serial head is ship-1 · ship-2 · design-1 · sdk-1 · sdk-2 · mono-1a · mono-1 ... The ship area's own note agrees ('ship-1 and ship-2 have zero blockers and should go before anything else in the whole roadmap').
- The installable image is outside the initiative it makes installable. Projects 1-14 are 'Spaces v1' (144 slices) and ship-8 / ship-10 — published multi-arch tags and the install docs, what CONTEXT calls the biggest adoption win — are in project 16, inside 'Extensibility'. The non-negotiable 'ship is not last' holds literally (16 of 23), but v1 completes with compose still saying build: . Move ship-8 and ship-10 into project 1 or 2 alongside mono-13a, or move project 16 ahead of project 15.
- ship-3 writes docker-compose.tls.yml in project 1 against `build: .`, and the compose files are then restructured twice — mono-13a re-points both build contexts (project 16) and ship-8 replaces the build with a pinned tag (project 16). No carry-forward criterion is recorded on either, unlike the one the merge correctly wrote for ship-2 into mono-13a ('must carry the root-start, su-exec drop and boot write-probe forward rather than restoring USER node').
- objects-4 is hitl precisely so a human pins the first sweep's flood bound (D25), and the import dep-fix adds 'objects-4's flood bound must cover a 400-row import, the second way a quiet inbox floods'. objects-4 is project 5 and import-7 is project 14 — the decision is made nine projects before the workload that motivates half of it. Either state the caps as a configurable ceiling objects-4 ships and import-7 reads, or record in import-7 that it must re-open D25.

### Orphaned references (7)

- storage-6b ← storage-6a, and storage-6a is deleted. The fold entry lists storage-6b only for absorbing docsurf-11's Source column, gone marker and Open-in-source action; it never remaps the blocker. Its acceptance text is dangling too: 'the path storage-6a built' and 'a Drive file larger than MAX_UPLOAD_BYTES is refused before the blob is written, using storage-6a's streaming guard'. Correct target: storage-6a2 (the streaming guard) plus storage-6a1 (the row), with storage-5, storage-3a, clean-2a and docsurf-11 retained.
- storage-8b ← storage-6a, and storage-6a is deleted. Not remapped anywhere in the changeLog. Its acceptance carries two more dangling references: 'files every file through the storage-6a arrival path' and 'a file whose sha already exists on the target attaches rather than duplicating, reusing the arrival module's dedupe' — the dedupe now lives in storage-6a1 (birth) and the streaming in storage-6a2. Correct target: storage-6a1 + storage-6a2.
- storage-18 ← storage-6a, and storage-6a is deleted. The dep-fix adds ai-26 + ai-12a and is silent on the dangling edge. Its acceptance says 'the stamp is written at arrival time by the storage-6a module' — and which half stamps sensitivity is a real open question, since only storage-6a1 writes the document row. Correct target: storage-6a1, with a criterion moved into storage-6a1 saying birth accepts and persists the sensitivity stamp.
- storage-2b and storage-3a still point at storage-2a after the OAuth split, but storage-2a is now only the outbound leg (PKCE, signed state, the Connect control, the authorize endpoint). Incremental scopes (storage-2b) and refresh-under-a-row-lock (storage-3a) both need the grant row, the encrypted bundle and the expires_at columns that live in storage-2a2. Both edges should be storage-2a2.
- mono-6's acceptance references a CI step design-1 abolishes: 'ci.yml runs all five gates as separately named steps: prettier --check, eslint, tsc --noEmit, the gate-5 token grep, and vitest' and 'The gate-5 step passes on a clean tree (the grep-exits-1 inversion is in place)'. After design-1 there is no grep and no fifth gate. The merge added the blocker but not the body edit.
- ai-8a's body still owns two things the merge gave to objects-3: '/dedupe stays as a redirect so existing links and the keyboard help survive' and the Today ReadoutStrip rewrite ('Dedupe inbox → /dedupe' with duplicates.length at today.tsx:313 becomes 'Review inbox → /inbox' with the combined open count). Unedited, two slices ship the same redirect and the same strip. The changeLog's prose says ai-8a shrinks to the row kind; the body on disk does not.
- Positive confirmations, so these are not re-raised: mono-13a ← mono-12 and mono-13b ← mono-11b are both correctly remapped, and all sixteen placeholder strings in the JSON (mono-workspace-scaffold, mono-packages, mono-test-db-harness, sdk-sdk-package, sdk-loader, sdk-runjob, sdk-integration-row, clean-integration-table, clean-source-class, clean-job-run-table, clean:job-run-table, clean-credential-kind, docsurf-space-filing, docsurf-document-birth, ai-suggestion-inbox, storage:document-revisions) resolve to real keys. No other slice references a deleted or never-created key.

### Size and label drift (14)

- objects-3 — S → M is the merge's biggest understatement. The body on disk is genuinely small (add objectSlug/objectSingular to entityContext, render the singular, link both sides through recordPath, two .at(0) cleanups). The merge adds on top: /dedupe → /inbox with a permanent redirect, git mv dedupe.ts → inbox.ts, listInbox() returning a kind-discriminated InboxRow[], a RENDERERS map with a payload fallback, countOpenInbox() → {open, byKind} in one grouped query, Today's strip, and 'inbox' into RESERVED. That is the whole /inbox architecture plus a route rename: L, not M. And it is afk with no design blocker while defining the row contract every later kind inherits.
- mono-11a — stays S but is no longer 'behaviour untouched'. It now owns the core.<domain>.<verb> rename across every queue created in projects 3-14, the drain-or-abandon policy for in-flight pg-boss jobs, and the 03:30 schedule row. Its acceptance ('registers the four queues', 'a document upload still extracts end to end with the same log lines', 'git diff -M shows the worker move as renames plus import-specifier lines') describes the pre-merge slice. M at minimum, and the rename arguably wants its own slice so the package move stays reviewable as a move — which is the exact argument its own body makes for splitting from the wrapper.
- sdk-2 — S → M is right for the code, but it also now ships docker-compose.split.yml and a README reference, which is ship-1/ship-3/ship-10 territory (see collisions). Either the overlay moves to ship-3, which already owns an overlay, or sdk-2's criterion is reworded to 'appends a named section to the README structure ship-1 establishes'.
- sdk-15 — still an undeclared L, and the plan says so itself. Provider HTTP client, header-driven self-throttle, bulk endpoints, response normalisation into claims, receipts, the wired enrich job, and Apollo's own error text surfaced. It heads project 18 and gates sdk-16, sdk-17, sdk-19 and sdk-25. Split at the cassette-testable provider-client seam before project 18 is published.
- import-9 — almost certainly an undeclared L, against the import area's claim of 'no L'. It writes dated rounds, investments, marks and FX across four append-only tables, surfaces missing FX rather than faking it, and first extracts the write programs out of src/lib/server/portfolio.ts (whose logic is inline in serverFn handlers) so that ai-22 can call them later. That refactor alone is a slice.
- api-1 — likely L and it is also the slice that answers D8. It stands up the first Layer and runtime on the web side (the repo has zero Layer, Context.Tag or Effect.Service today), defines the HttpApi door, mounts the versioned namespace, emits OpenAPI, and ships the first procedure. It should be hitl for D8 regardless of size.
- ship-6 — likely L. Playwright from zero: the dependency, the config, a database and DATA_DIR it creates and drops itself, a global setup, four auth specs, and a new CI job. It is also the first browser coverage the project has ever had, so there is no harness to add to.
- arrival-1 — likely L and hitl. IMAP polling, MIME parsing, the noise-refusal module, a credential of a new kind, the poll job, thread → interaction, and the participants seam — plus it carries D30 (where a forwarded mail body lives, which contradicts notes-5's move of bodies out of interaction) and D31 (the transport choice among IMAP poll, inbound SMTP and a provider webhook).
- import-11 — label unstated and it cannot be afk. CLAUDE.md names the correction policy for the append-only portfolio tables an open decision and says 'don't add mutation paths casually'; import-11 is that door, and ai-22 inherits it. hitl.
- clean-2c — label unstated. The backfill author's own reasoning for the credential.kind decision was 'this is one of the four ownerless decisions the audit says to answer before publishing, which is why that slice is hitl rather than afk'. It also rebuilds a unique key on live rows. hitl.
- arrival-4 — label unstated and it carries D32 (headless browser in the default image), which changes the published image. Cannot be afk.
- backfill-5 — a new suggestion-chip pattern on the record rail with no design blocker, while the merge routed docsurf-5, ai-8a, ai-17, notes-2, notes-3, docsurf-9 and sdk-20b through design-2/4/6/8. Its own open question notes DESIGN.md's Micro-interactions sheet has four proposals and none is a chip carrying an action. backfill-5 ← design-2 (and design-10 if the chip animates), or state explicitly that it is an inert mirror of a shipped control.
- import-2 and arrival-8 add routed surfaces (/import, the feed surface on a space and record page) with no design-6 edge, while docsurf-5 and ai-8a were given one so that 'a nav row is data with a collision test instead of a hand audit'. NAV_ITEMS still groups by index arithmetic (slice(0,4)/slice(4,7)/slice(7)) until design-6 lands, so any insert that is not at the end silently moves a page between groups.
- storage-11b and storage-11c carry asserted sizes with no bodies — the plan admits the prose was truncated. Do not treat their sizes as spot-checked; the gone-pointer half looks S and the resurrection half (app-side tombstone plus expired-cursor re-list, tested against each other) looks M.

---

## 5. What to cut, and known defects

**The audit's cut list** (advice, not decided):

- Project 22 in full (storage-13 through storage-19b, 9 slices) — the plan's own summary says 'Half of this is speculative until a real user asks — treat it as a backlog with an order.' Take it at its word and stop the storage arc at project 21. That also removes storage-19a/19b, whose deliverable is a git diff --stat proving the port abstraction held: valuable as architecture validation, worthless to a user, and unbuyable at two slices before a second provider is asked for.
- Project 23 in full (8 slices: backfill-11, backfill-12, arrival-5 through arrival-10) — every slice needs OAuth, the loader and the fakes, which is three projects of prerequisite for a calendar sync. Keep arrival-1 through arrival-4 (project 13), which need none of that and are the channel CONTEXT sequences first. Cut the rest to the backlog with arrival-8's D33 recorded so the feed tables are not built twice later.
- ship-12 (PaaS templates) — the ship area names this itself as the one slice that could be dropped without leaving a contract unimplemented: it is a CONTEXT Hosting bullet, not a locked decision. Cut it, not ship-11.
- import-10 and import-12 — the only two slices in project 14 gated on the SDK (import-10) or unspecified in shape (import-12, D42). The pipeline's value is projects 14 milestones 1-3; the Airtable dialect proves an abstraction nobody has asked for yet, and export should be one slice re-scoped after a user asks to leave.
- ~~ai-27 (judgment memory) and ai-9b (local embeddings)~~ **overtaken: ai-27 shipped as SPA-139; ai-9b kept by the owner, resequenced Ollama-first (SPA-83) with transformers.js split to SPA-161.** — both are second-order: ai-27 is an assembler mode nobody has asked for, ai-9b is a keyless alternative to a lane that already works with a pasted key. Keep ai-9a's sensitivity argument, which is what makes ai-9b additive later.
- sdk-18 and sdk-19 (LISTEN/NOTIFY to SSE, enrich-on-create) — polish on an enrichment arc whose first real tenant (sdk-15) is still an undeclared L. A cell that resolves on refresh is acceptable until someone complains.
- If more must go: project 19's ship-9 and backfill-13 (plugin release tags and plugin upgrade). Nothing can be released or upgraded until a plugin exists that someone outside the repo wants, and both are cheap to add the week that happens.

**Known defects to fix when the owning project is published:**

- `storage-6a` was split into `storage-6a1` (document birth) and the server intake lane; backlog bodies in projects 20–23 still cite `storage-6a` by name — repoint them.
- Four 2026-09-15 dep-fixes wrote content into project-2 slices that could not hold it (mono-7 moving files import-1/import-8 create; mono-9c adding a queue import-6 creates). Project 2 shipped without them, so import-1, import-6 and import-8 own those files and that queue themselves.
- MIS and the runway lens have no slice and no deferral entry.
- `import-11` and `import-12` have no acceptance criteria.
- Project 15 plans `packages/core`, which already exists with code; check each mono slice against the tree.
