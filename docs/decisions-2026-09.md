# Decision ledger — the 2026-09 architecture week

_Forty-eight decisions surfaced by the reconciliation pass of 2026-09-15 and closed on 2026-09-16/18. Every one is carried by a slice that is `hitl` precisely because of it; the answer belongs in that slice's body before it is picked up. Options, consequences and reversal costs for each are in `research/roadmap-reconciled-2026-09-15.json` under `.decisions`._

**All forty-eight are closed.** Ten were the owner's and were answered directly. Thirty-eight were engineering calls ratified as recommended, on the standing rule that the recommendation was in every case the reversible option and the carrying slice is `hitl`, so the judgement is met again in the code rather than lost.

|       | decision                                                                                                                                                        | answer                                                                                                                                                 | carried by            | blocks |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------ |
| P1    | **D13-published-identity** — What name do the published packages, images and domain carry, given `@spaces` on npm is probably taken?                            | Option 1. ship-1 records that the workspace names are internal and unpublished, and the public-name decision is explicitly deferred to the slice [...] | `ship-1`              | 3      |
| P1    | **D14-rename-depth** — How deep into the running box does the DealOS → Spaces rename cut — the Postgres role and database, the [...]                            | Option 1.                                                                                                                                              | `ship-1`              | 4      |
| P1    | **D17-supported-container-runtimes** — Is a non-root container start an officially supported, tested deployment target, and does that include [...]             | Option 1, stated explicitly in ship-2's acceptance criteria and in the install docs.                                                                   | `ship-2`              | 1      |
| P3    | **D1-source-ref-referent** — When a row says "an integration wrote this", does `source_ref` point at the installed integration row or [...]                     | Option 1. `source_ref` always references `integration.id`, FK enforced, null unless class = 'integration'. Correct `spec-storage-sources.md` [...]     | `clean-3`             | 12     |
| P3    | **D3-credential-kind** — Does `credential.kind` stay a closed enum and widen to cover OAuth apps, webhook secrets and embedding [...]                           | Option 1, landed as a new `clean-2c` in project 2 so it rides the migration lane with clean-2a rather than arriving from the backfill area [...]       | `clean-2c`            | 8      |
| P4    | **D18-documentation-canon** — When two documents describe the same rule, which one is edited — and does apps/site fork the install [...]                        | Option 1, recorded in design-2 for the design pair and in ship-10 for the docs pair.                                                                   | `design-2`            | 2      |
| P4    | **D19-icon-set** — Is lucide the sanctioned icon set with a written rule, or a v1 holdover on the deprecation path?                                             | Option 1, carried by design-2 as a section of the design contract.                                                                                     | `design-2`            | 8      |
| P4    | **D21-dark-theme-shape** — Is the deferred dark theme a token swap, or a real re-port — and should design-9 keep paying for [...]                               | Option 1, carried by design-9 as a one-paragraph scope correction.                                                                                     | `design-9`            | 0      |
| P4    | **D22-visual-regression-coverage** — Does the design area get machine coverage — a snapshot suite over forty surfaces — or does visual review [...]             | Option 1.                                                                                                                                              | `design-2`            | 0      |
| P5    | **D25-first-sweep-flood** — How much accumulated history may the nightly duplicate sweep surface on its very first run, and does it [...]                       | Option 1.                                                                                                                                              | `objects-4`           | 0      |
| P7    | **D48-space-crumb-line** — How many terms does the space page's crumb count line carry?                                                                         | Option 1.                                                                                                                                              | `backfill-10`         | 0      |
| P8    | **D9-provenance-cardinality** — When the same bytes or the same email arrive twice through different channels, does the row keep one [...]                      | Option 3, in both places: storage-6a1 owns `stampProvenance` for documents, arrival-1 owns the same shape for interactions. Record [...]               | `storage-6a1`         | 8      |
| P9    | **D2-view-surface-discriminator** — How does a saved view address a surface like /documents that has no object row and no `entity.values` — [...]               | Option 1, and with it: docsurf-5 ships the /portfolio prefs pattern only (no ViewBar), and docsurf-12a explicitly migrates that page's [...]           | `views-1`             | 7      |
| P9    | **D5-filter-evaluator-owner** — Who owns the one server-side view-filter evaluator, now that an area for views exists?                                          | Option 1. views-2 owns the evaluator and its expression-index minting; docsurf-12b ships a column registry only; ai-18 is re-blocked on views-2 [...]  | `views-2`             | 4      |
| P9    | **D6-client-and-server-evaluators** — When filtering moves into SQL, does the pure client-side matcher survive, and if it does, how are the [...]               | Option 1. views-2 ships the shared case table and both tests read it.                                                                                  | `views-2`             | 3      |
| P9    | **D35-list-query-state** — Do ad-hoc filter conditions belong in the URL, and does the global text box on a paged table survive as [...]                        | Option 1.                                                                                                                                              | `views-2`             | 2      |
| P9    | **D36-filterable-sortable-flags** — What happens when someone sorts or filters by an attribute that is not flagged, and which system [...]                      | Option 1.                                                                                                                                              | `views-1`             | 3      |
| P9    | **D37-deals-board-pagination** — Is the deals board permanently exempt from pagination, and what do the stage chip counts mean if it is not?                    | Option 1.                                                                                                                                              | `views-3`             | 0      |
| P10   | **D4-citation-ref-grammar** — Is the shipped ref grammar the one and only citation format, who resolves a ref into a destination [...]                          | Option 1, carried by ai-5 because the suggestion table is the second persisted writer of refs and the first one a user reads. ai-12a applies the [...] | `ai-5`                | 11     |
| P10   | **D20-routing-grid-pattern** — Is ai-4b's lane × sensitivity routing table drawn as a new matrix pattern, or expressed as a ledger with [...]                   | Option 1. ai-4b stays hitl (the copy and the provider cells still want a human eye) but ships no new pattern.                                          | `ai-4b`               | 1      |
| P10   | **D44-suggestion-chips** — May a suggestion chip on the record rail carry inline accept and reject, or is it a read-only pointer [...]                          | Option 1, carried by backfill-5.                                                                                                                       | `backfill-5`          | 1      |
| P10   | **D46-caps-and-usage-accounting** — What unit does the AI cap count, is there a second ceiling per integration, and does a cache hit appear [...]               | Option 1, carried by backfill-4 for the ceilings and ai-25a for the run-log half.                                                                      | `backfill-4`          | 4      |
| P11   | **D11-sensitive-embeddings** — Do records flagged sensitive simply get no vectors in v1, so semantic search cannot reach them?                                  | Option 1, and pin the signature now: `embed(input, { sensitivity })` and `aiRoute('embed', sensitivity)` ship in ai-9a even though only one [...]      | `ai-9a`               | 5      |
| P11   | **D23-semantic-lane-trigger** — How does the semantic lane fire in Cmd-K, given the palette has no submit — it debounces per keystroke [...]                    | Option 1 — and regardless of which wins, write ai-11's server half (the fourth CTE, the k=60 pin guard, the cache) so it stands alone, because [...]   | `ai-11`               | 1      |
| P12   | **D10-mcp-and-sensitivity** — Does the MCP read surface refuse a sensitive record the way `complete()` does, or does a flagged deal [...]                       | Option 1, carried by ai-23a. It makes the guard list three boundaries rather than two, which should be written into [...]                              | `ai-23a`              | 3      |
| P12   | **D24-what-kind-other-means** — Does `kind: 'other'` mean "unknown" — so the classify lane proposes on it — or can it mean "a human [...]                       | Option 1, carried by ai-14.                                                                                                                            | `ai-14`               | 1      |
| P12   | **D29-public-door-safety** — What stops abuse of a token-authenticated endpoint on a box that may sit on the open internet — and is a [...]                     | Option 1, carried by the PAT slice (ai-23a today).                                                                                                     | `ai-23a`              | 3      |
| P12   | **D45-space-tag-classify-vocabulary** — When the model proposes space tags, what is the candidate vocabulary — the whole space tree, or a [...]                 | Option 1, carried by backfill-6.                                                                                                                       | `backfill-6`          | 0      |
| P13   | **D8-api-substrate** — Does the external API ride the `@orpc/experimental-effect` bridge, or on `effect/unstable/httpapi`, [...]                                | Option 1. Rewrite api-1 from "oRPC spike" to "HttpApi door — one definition, OpenAPI out", and record the amendment in CONTEXT with the reason [...]   | `api-1`               | 6      |
| P13   | **D27-api-versioning** — One `/api/v1` namespace for everything external, or per-surface versions like `/api/capture/v1`?                                       | Option 1.                                                                                                                                              | `api-1`               | 3      |
| P13   | **D30-mail-body-and-privacy** — Where does a forwarded or synced email body live, and who can see it before the thread is attached to a deal?                   | Option 1, carried by arrival-1, with the workspace default expressed as a single setting (bodies private-until-attached) rather than a per- [...]      | `arrival-1`           | 3      |
| P13   | **D31-forwarding-transport** — How do forwarded emails actually reach the box — IMAP poll of an operator-owned mailbox, an inbound SMTP [...]                   | Option 1.                                                                                                                                              | `arrival-1`           | 2      |
| P13   | **D34-participants-and-interactions** — Which email participants become people, and does an all-internal calendar meeting become an interaction [...]           | Option 1, carried by arrival-2, with the domain list landing as a tested data file in the same slice.                                                  | `arrival-2`           | 2      |
| P14   | **D40-safe-instrument-default** — Should an unmapped "SAFE" in an imported sheet be refused, or default to post-money?                                          | Option 1.                                                                                                                                              | `import-8`            | 1      |
| P16   | **D15-tags-registries-and-the-upgrade-window** — Does `latest` move, do we publish to Docker Hub as well as GHCR, and how far back does upgrade CI test?        | Option 1, and correct CONTEXT in ship-11's PR: "every prior release" becomes the stated window, with the reason.                                       | `ship-8`              | 2      |
| P16   | **D16-signing-scheme** — Do images and plugin tarballs share one signing scheme, or two deliberately different ones?                                            | Option 1, recorded in CONTEXT with the reason stated as the verifier's identity: the image verifier is a human with cosign, the plugin verifier [...]  | `ship-8`              | 2      |
| P16   | **D26-worker-bundler** — Which bundler produces the source-free worker image — tsup, which is not installed, or `vite build [...]                               | Option 1, with whichever wins recorded in CONTEXT and the reason stated.                                                                               | `mono-13b`            | 0      |
| P17   | **D39-importer-parse-signature** — Does a plugin importer's `parse(file)` return a grid for the mapping wizard, or Claims?                                      | Option 1, carried by sdk-4a since that is where the kind interfaces freeze; import-10 becomes a consumer.                                              | `sdk-4a`              | 1      |
| P19   | **D7-entity-refs-and-plugin-fks** — What merge strategy and context role do this plan's roughly ten new entity-referencing columns get, and [...]               | Option 1, carried by sdk-24a (which defines what a plugin schema may do) with the per-column entries landing in each column's own slice. Correct [...] | `sdk-24a`             | 8      |
| P21   | **D38-retention-of-derived-layers-and-payloads** — When `retain: text` throws the bytes away, what happens to the page-image cache, the extraction cache, [...] | Option 1, carried by storage-12 so the retain policy covers derived layers in the same sentence it covers bytes.                                       | `storage-12`          | 4      |
| P23   | **D33-feeds-core-or-plugin** — Is the RSS feed poller a plugin, or core?                                                                                        | Option 1, carried by arrival-8, with spec-plugin-sdk §5's poller example changed from RSS to something that actually needs the port.                   | `arrival-8`           | 1      |
| later | **D12-ledger-correction-policy** — How does anyone fix a wrong investment, mark or distribution, given the portfolio event tables are [...]                     | Option 1, as its own slice in the portfolio/import area landing before import-9's commit step. ai-22's accepted proposals write through the same door. | `SPA-150` (project 3) | 2      |
| later | **D28-outbound-delivery** — Does the box ever POST events out, or is polling the read API the whole answer for n8n and the digest?                              | Option 1. The cursor is the load-bearing half and it is nearly free today.                                                                             | `api`                 | 2      |
| later | **D32-headless-browser** — Does a headless browser ship in the default image so DocSend and Pitch links can be snapshotted to PDF?                              | Option 1, carried by the deck-links slice with arrival-4 written against the same port.                                                                | `the`                 | 1      |
| later | **D41-ai-mapping-write-doctrine** — When AI proposes a column mapping, is that a `suggestion` row or a pre-selected control the human confirms?                 | Option 1 — and land the doctrine sentence in CONTEXT before ai-17 and ai-18 ship, not when AI mapping is built.                                        | `the`                 | 2      |
| later | **D42-export** — Can a user get their data back out, and who owns that?                                                                                         | Option 1, as a new slice in the import area (which should be renamed "import and export").                                                             | `a`                   | 0      |
| later | **D43-import-entry-point** — Does the getting-started card gain an Import step, and does /today surface a staged-but-uncommitted batch?                         | Option 1.                                                                                                                                              | `the`                 | 0      |
| later | **D47-plugin-rollback-entry-point** — How does an operator roll back a bad plugin upgrade on a box that ships no CLI?                                           | Option 1, carried by the plugin-upgrade slice the audit adds (not by backfill-13 alone, since the version directory and the migration ledger are [...] | `the`                 | 0      |

\* `D22` was put to the owner and came back unanswered; ratified as recommended. It blocks nothing and can be reopened at the first design milestone demo.

---

## The ten the owner answered

### D13-published-identity

**What name do the published packages, images and domain carry, given `@spaces` on npm is probably taken?**

mono-1 and mono-2 bake `@spaces/*` into every package.json and mono-13a bakes the image name; ship-1 is hitl entirely because of this and it blocks the first slice of the monorepo area. CONTEXT says the rename must land before GHCR images bake the old name in. The repo's package name is still `dealos`.

**Answered:** Option 1. ship-1 records that the workspace names are internal and unpublished, and the public-name decision is explicitly deferred to the slice that first runs `npm publish`.

The decision is blocking mono-1 only because it was framed as a publishing decision; nothing in projects 1–10 publishes anything, so the honest answer is to stop treating an internal specifier as a public identifier and let mono-1 go.

_Carried by_ `ship-1` (project 1). _Blocks_ `mono-1`, `mono-2`, `mono-13a`.

### D14-rename-depth

**How deep into the running box does the DealOS → Spaces rename cut — the Postgres role and database, the compose project, the `dealos.*` localStorage keys?**

docker-compose.yml hardcodes role, password default and database as `dealos` and the volume as `dealos_pgdata`; the compose project name is `dealos`; saved table-column layouts live under `dealos.*` localStorage keys; mono-4 will name a test database. ship-1 pins "rename now, document the two-line ALTER" on the grounds there is one deployment and it never gets cheaper.

**Answered:** Option 1.

The infrastructure names are seen by an operator reading a compose file and are worth getting right while there is exactly one of them; the prefs keys are seen by nobody and their only observable behaviour is losing someone's work if the shim misfires. Asymmetric risk, asymmetric answer.

_Carried by_ `ship-1` (project 1). _Blocks_ `ship-2`, `ship-10`, `mono-4`, `mono-13a`.

### D21-dark-theme-shape

**Is the deferred dark theme a token swap, or a real re-port — and should design-9 keep paying for enforcement that assumes the former?**

The `dark` custom-variant exists, no dark token values do, next-themes is already a dependency, and CONTEXT schedules dark post-v1 without saying which kind of job it is. design-9 pays a token-only enforcement cost on every surface on the assumption it is a swap. DESIGN.md's own materials doctrine says bone is a chassis because it is lighter than paper — a relationship that does not survive inversion.

**Answered:** Option 1, carried by design-9 as a one-paragraph scope correction.

The tokens are worth keeping regardless, so nothing material changes — but the justification does, and an enforcement rule justified by a false promise is the kind of thing that gets dropped the first time it is inconvenient.

_Carried by_ `design-9` (project 4). Blocks nothing.

### D11-sensitive-embeddings

**Do records flagged sensitive simply get no vectors in v1, so semantic search cannot reach them?**

With one pinned embedding dimension (768) and one configured provider, `embed()` refuses on a sensitive subject when the lane routes to a cloud provider — so a flagged deal's chunks land with null embeddings. The roadmap audit already flags "the sensitive embedding slot" (a second, local provider at the same dimension) as having no slice. This is the one consequence of the whole sensitivity design a user actually feels.

**Answered:** Option 1, and pin the signature now: `embed(input, { sensitivity })` and `aiRoute('embed', sensitivity)` ship in ai-9a even though only one branch is reachable, so the local slot is additive rather than a signature change across every caller.

Refusing loudly is the correct behaviour under the doctrine, and the pinned dimension already bought the cheap reversal; what would make this expensive is shipping `embed()` without sensitivity in its signature and discovering it at ai-9b.

_Carried by_ `ai-9a` (project 11). _Blocks_ `ai-11`, `ai-12b`, `ai-13`, `ai-26`, `storage-18`.

### D8-api-substrate

**Does the external API ride the `@orpc/experimental-effect` bridge, or on `effect/unstable/httpapi`, which is already installed?**

`@orpc/*` appears nowhere in package.json; the bridge was chosen 2026-09-04 against Effect v3's service APIs and is @beta, while the repo now runs `effect@4.0.0-rc.112`. I verified that the installed effect ships `effect/unstable/httpapi` with HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity, HttpApiScalar, OpenApi and HttpApiTest, plus `effect/unstable/rpc` beside it. oRPC's internal half — typed TanStack Query hooks — is already served by `createServerFn` across twenty modules in src/lib/server, so nothing internal is waiting on it. This is the concrete form of the risk CONTEXT recorded as "the Effect bridge is @beta", and nothing else in the api area can be specified until it is answered.

**Answered:** Option 1. Rewrite api-1 from "oRPC spike" to "HttpApi door — one definition, OpenAPI out", and record the amendment in CONTEXT with the reason (the named fallback now ships inside the pinned package).

The bridge's entire advantage was one vocabulary across both audiences, and the internal audience already has a good answer that nobody is proposing to replace — so the bridge is being paid for with a beta dependency and a version-coupling risk in exchange for consistency the repo does not need.

_Carried by_ `api-1` (project 13). _Blocks_ `every other api slice`, `sdk-23`, `ai-23a`, `ai-23b`, `ai-24`, `the /api/capture slice`.

### D30-mail-body-and-privacy

**Where does a forwarded or synced email body live, and who can see it before the thread is attached to a deal?**

These two are entangled and must be answered together. CONTEXT's privacy block presumes bodies are stored and records the default as "decide deliberately"; notes-5 deliberately moved bodies out of `interaction` into notes via `note_id`; storing every forwarded mail as a note fills /notes with mail. The repo already has `visibility: shared | private` on note and a private-note carve-out enforced in SQL (see the `not exists … visibility = 'private'` clause in searchEntities).

**Answered:** Option 1, carried by arrival-1, with the workspace default expressed as a single setting (bodies private-until-attached) rather than a per-connection exclude list in v1.

The privacy question already has a shipped answer in this codebase — private notes — and mapping mail onto it means one visibility model instead of two, with the search carve-out already written. It also makes the escalation's two questions collapse into one setting.

_Carried by_ `arrival-1` (project 13). _Blocks_ `arrival-2`, `arrival-10`, `notes-5`.

### D31-forwarding-transport

**How do forwarded emails actually reach the box — IMAP poll of an operator-owned mailbox, an inbound SMTP listener, or a provider webhook?**

A forward IS the consent model, which is why this is the first arrival channel in CONTEXT's sequencing instinct. Nothing in CONTEXT or the specs picks a transport, and the required-env set is frozen at {DATABASE_URL, APP_URL} with every feature shipping a working default or being optional.

**Answered:** Option 1.

It is the only option that satisfies the frozen-env rule for the channel CONTEXT wants first, and because all three share the parser and the filing path, picking the cheapest now costs almost nothing if it later proves too slow.

_Carried by_ `arrival-1` (project 13). _Blocks_ `arrival-2`, `arrival-10`.

### D12-ledger-correction-policy

**How does anyone fix a wrong investment, mark or distribution, given the portfolio event tables are append-only with no edit or delete path — and an import can commit forty at once?**

CLAUDE.md names the correction policy an open decision and says not to add mutation paths casually. import-9 adds no mutation path, so a wrong imported position is permanent. ai-22 separately proposes ledger events from live-file revisions — an accepted proposal writes into the same doorless tables. This is the one place bulk writing meets append-only and it lands before an angel imports a real portfolio.

**Answered:** Option 1, as its own slice in the portfolio/import area landing before import-9's commit step. ai-22's accepted proposals write through the same door.

Reversal-by-append is the only correction that keeps history information rather than overwriting it, and bulk import is what turns "a rare wrong row" into "forty rows and no way back". It is also the smallest of the three answers, which is unusual and worth taking.

_Carried by_ `SPA-150` — published 2026-09-18 into project 3, milestone "Delete walks the registry", not the import area: the ledger already takes hand-entered marks, so the hole is live now. _Blocks_ `import-9`, `ai-22`.

### D28-outbound-delivery

**Does the box ever POST events out, or is polling the read API the whole answer for n8n and the digest?**

CONTEXT's integration map #11 pairs "generic webhooks/API" and nothing in the 153 slices owns outbound event delivery or the digest channel. Outbound is a new subsystem — retries, per-endpoint secrets, a delivery log — and one that would want the same job_run table clean-2b is creating.

**Answered:** Option 1. The cursor is the load-bearing half and it is nearly free today.

Outbound delivery is a subsystem justified by demand nobody has expressed, while the cursor is the cheap thing that makes its absence tolerable — and the one piece that becomes expensive if it is skipped.

_Carried by_ `api` (a later project). _Blocks_ `the digest channel work`, `arrival-8`.

### D32-headless-browser

**Does a headless browser ship in the default image so DocSend and Pitch links can be snapshotted to PDF?**

No playwright, puppeteer or chromium appears in package.json, CONTEXT.md or ARCHITECTURE.md. Bundled Chromium is roughly 400 MB on a product whose pitch is two containers and `docker compose up`. docsurf-10a's clip handles articles and PDF responses; a DocSend link is neither and will fail its guard. Deck-link ingestion is sequenced first alongside forwarding.

**Answered:** Option 1, carried by the deck-links slice with arrival-4 written against the same port.

The single largest violation of the hostability contract available in this plan, traded for a capability that is unreliable even when it works — and the two-implementation port means the capable version is one optional container away for whoever wants it.

_Carried by_ `the` (a later project). _Blocks_ `arrival-4`.

---

## What these answers add to the plan

Four of the ten are not just ratifications — they change what gets built:

- **D12** requires a slice that does not exist: reversal-by-compensating-event on the four portfolio event tables (`reverses_id` nullable self-reference, a void flow appending an exact negative citing the original, batch reversal for a whole import). It must land before the import commit step, and `ai-22`'s accepted ledger proposals write through the same door. This also closes the open decision `CLAUDE.md` names.

- **D28** puts a `?since=` cursor in the first version of the read API. A cursor added later is a breaking change, so it cannot wait for the demand that would justify it.

- **D11** pins `embed(input, { sensitivity })` and `aiRoute('embed', sensitivity)` in the first embedding slice even though only one branch is reachable, so the local slot is additive rather than a signature change across every caller.

- **D30 + D31** together define the forwarding lane: an IMAP poll of an operator-owned mailbox, bodies stored as notes via `interaction.note_id` born `private` to the connecting user and flipped to `shared` when the thread is attached. One visibility model, reusing the private-note carve-out already enforced in SQL.
