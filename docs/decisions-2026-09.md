# Decision ledger — the 2026-09 architecture week

_Forty-eight decisions surfaced by the reconciliation pass of 2026-09-15 and closed on 2026-09-16/18. Every one is carried by a slice that is `hitl` precisely because of it; the answer belongs in that slice's body before it is picked up. Options, consequences and reversal costs are in §3 of `docs/roadmap-2026-09.md` for the decisions whose carrying slice has not shipped; the rest are in that file's git history (trimmed 2026-09-27)._

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

---

## Addenda — 2026-09-25

_Three changes after the week closed, all the owner's. They are recorded here rather than by editing the closed entries above, so the ledger still reads as it was ratified._

### D32-headless-browser — superseded

**Owner, 2026-09-23:** no headless browser, no renderer port, no optional snapshot container. A DocSend or Pitch link in a forwarded mail stays a link on the interaction; nothing renders it. The two-implementation port D32 traded for is not built. `arrival-4` (SPA-138) is cancelled and leaves project 13; `docsurf-10a`'s link-kind dispatch table stays as it is, with no renderer registered against it.

### D49-deal-threads-derived

**How does an email thread reach a deal, and when is a forwarded body shared?**

Threads are edged on arrival to the people whose address matches an alias and the companies whose domain matches one, in `interaction_entity`. Nothing about a deal is known at arrival, a company can carry several deals, and D30 made sharing a body the consequence of attaching its thread — which left the common case (every thread on the company belongs on the deal) needing a manual act per thread, and a reply next week needing it again.

**Answered:** Option 1, the Attio shape with one explicit edge kept.

- **A deal's threads are derived** — every thread edged to the deal's company or to one of its contacts, past and future, no write at the deal. One explicit `interaction_entity` edge to a deal — pin in, or exclude — is the only manual act, for the two-open-deals case. _Reversal cost:_ Additive; the edge already exists as a table.
- **Forwarded bodies are born `shared`.** Forwarding is the consent (D31), so D30's private-until-attached default applies to the synced mailbox (arrival-10) only, where a connected inbox carries mail nobody chose to share. _Reversal cost:_ Copy plus a visibility backfill.
- **A message on a thread that already carries edges inherits them** at write time, so a reply is on the same records without re-matching.
- **A true forward is parsed for its Forwarded-message block**, and the original sender, recipients and date are what get matched — a BCC carries its headers, a forward carries them only in the body.

_Carried by_ `arrival-1` (SPA-56) · `arrival-2` (SPA-86). _Blocks_ `arrival-10`.

### D50-local-embedding-seam — open

**When the local embedding model lives inside the worker, how does the web process get a query vector while the user types?**

Query-time embedding runs in web (`apps/web/src/lib/search/query-embedding.ts`), a transformers.js model is memory inside the process that loaded it, and the worker-only rule forbids web from loading it. Ollama has no such problem — it is an HTTP server both processes call — which is why SPA-83 was resequenced on 2026-09-25 to Ollama-plus-sensitive-slot first, with the in-process model split into `ai-9c`.

- **Worker opens an internal HTTP listener, one `/embed` route, web calls `WORKER_URL`** (compose default `http://worker:3001`) — cleanest latency; one optional env; a new surface inside the compose network. _Reversal cost:_ Low.
- **Request/reply over Postgres `LISTEN`/`NOTIFY`**, reply written to a row and its id notified — no port, no env; tens of ms plus inference; the 8 KB payload cap rules out the vector itself in the notification. _Reversal cost:_ Low.
- **Web loads the model lazily when the pin is local** — simplest; kills the worker-only rule; +300 MB resident on web and inference on its loop. _Reversal cost:_ Moderate.

**Not answered.** Carried by `ai-9c`, `hitl`, which records the answer in CONTEXT.md §Embeddings before building the seam. pg-boss round trips are seconds and are not an option.

---

## Addenda — 2026-09-30 (project 17's publish)

_Eight decisions taken by the owner while publishing project 17 (the plugin SDK), one at a time, each against the code as it stood after project 15. D51 and D52 reshape the SDK contract; the rest pin what sdk-21a, sdk-4b, sdk-6b, sdk-7a and SPA-182 build. The contract they change is `docs/spec-plugin-sdk.md` §3–§5 and §9; CONTEXT.md's "Plugin architecture" block carries the summary._

### D51-plugin-triggers-not-kinds

**Does a plugin have a kind, and what grants its ports?** Answered: **no kinds.** Each job declares a `trigger` (`action` · `schedule` · `event` · `webhook` · `file`), which fixes its input and output, and the ports it `uses`, which the admin sees at install and the per-(integration, job) Layer grants exactly. `storage-source` stays a provider interface core calls into (`provides: 'storage-source'`). Rejected: one kind per plugin (Gmail ships as two installs), a kind per job (keeps a frozen port table that is not a security boundary — v1 loads only first-party signed plugins), and a set of kinds with the union of their ports (every job gets every port). Reason: a kind bundled trigger, shape and privilege; Zapier/n8n/Twenty split triggers from scopes, and the doctrine that matters lives inside the ports whatever the job declares. Carried by `sdk-3` (manifest) and `sdk-4a` (trigger shapes).

_Amended 2026-10-01 (checkpoint review):_ a `webhook` job carries no plugin `verify` — it is a plain `(input: WebhookInput) => Effect<void, JobError, R>` like the others. Plugin code runs only in the worker, after web has already returned 200, so a plugin check could gate nothing, and running it in web breaks "web never executes plugin code". Signature checking stays manifest-declared (`ingress.signature`) and done by core in web (sdk-23). A plugin-side check, if a provider ever needs one, would be an optional field — a minor; removing a shipped one would be a major.

### D52-ports-not-returned-claims

**Does a job return claims for a core router, or call ports?** Answered: **it calls ports.** Each write port calls its lane at once and returns what the lane decided (`Identity.resolve` → the entity id; `Facts.fill` → the refused conflicts). "Claims" are the typed arguments of the write-port methods — the semver-frozen vocabulary, carrying no source/actor/integration field. No router, no batch, no handle grammar; the testing kit's recording Layers mint deterministic fake ids; a DryRun Layer over `previewResolve` is the later answer to an importer preview. Rejected: declarative claims (a handle grammar, a router and dependency ordering re-deriving rules the lanes already hold, and a job that cannot react to a refused fill) and both at once. D39 survives: an importer still speaks claims, never a grid. Carried by `sdk-4a` and `sdk-5`.

### D53-cost-hook

**What does `estimateCost` become?** Answered: an optional `cost` hook on an `action` job, a pure function of the input returning `{ credits: number }` in the provider's own unit. The host drops entities with a fresh receipt first, refuses before any API call when the estimate does not fit the integration's remaining daily cap, and counts spend only from `Receipts.store(…, credits_used)`. Carried by `sdk-4a` (shape); used by `sdk-16` (project 18).

### D54-plugin-signing-mechanics

**How is D16's plugin half built?** Answered: a detached raw ed25519 signature made and checked with `node:crypto` (no dependency, no network); the public key is a file baked into the image, named by key id so a rotation can trust two; never read from `registry.json`; the private key is a GitHub Actions secret used only by the plugin release workflow. The unsigned development escape is a marker file `./data/plugins/.allow-unsigned`, off by default, with a boot warning and an "unsigned" badge; the required-env set stays `{DATABASE_URL, APP_URL}`. Rejected: the minisign format via a library, the key in the registry or in env, an env-var escape, and no escape. Carried by `sdk-21a`.

### D55-sdk-third-party-dependencies

**May `@spaces/sdk` depend on `tldts`?** Answered: **yes.** The rule is "nothing internal", not "nothing third-party"; `normalizeDomain` needs the public suffix list and one normalizer on both sides of the port is the point of sdk-4b. A test pins the SDK's dependency list to `effect`, `zod`, `tldts`. Rejected: splitting the normalizer (plugin and choke point disagree on a domain) and vendoring the suffix list. Carried by `sdk-4b`.

### D56-read-search-v1

**What does `Read.search` cover in v1?** Answered: **lexical and fuzzy only.** sdk-6b moves the fused lexical statement and `canReadNoteSql` into core; the vector lane — pinned to web's embedding stack by `query-embedding.ts` — arrives later as an injected query-vector function, additively. Rejected: all three lanes now (drags the AI provider stack across the worker fence before any plugin needs it) and no `search` in v1. Carried by `sdk-6b`.

### D57-signal-and-receipt-provenance

**How do `signal` and `enrichment_record` say which integration wrote them?** Answered: **real columns, one migration, carried by sdk-7a** — `signal.source_class` + `source_ref` with the same check invariant as `entity`/`interaction`/`document`, and `enrichment_record.integration_id → integration(id)` beside the kept `provider` text. One migration keeps sdk-7b off the serial migration lane. Neither column references an entity, so no `ENTITY_REFS` entry. Rejected: the integration id as free text, and two migrations.

### D58-assembler-similar-lane

**What seam lets the context assembler into core (SPA-182)?** Answered: a narrow `SimilarLane` `Context.Service` in `packages/core/src/context/` — similar candidates for a scope plus the pin read `record.ts` needs. `assemble.ts`, `names.ts` and `record.ts` move to core; `similar.ts` stays in apps/web as the live Layer; tests get a stub Layer; `canRead` comes from `@spaces/core/read-policy`. Blocked by `sdk-5` (the house pattern) and `sdk-6b` (which owns moving `canReadNoteSql`). Rejected: a wide `ContextAssembler` service, and moving the embedding-pin substrate into core. It is also the shape the spec's later `Read.context(id)` takes. Carried by `SPA-182`, which joins project 17.

---

## Addenda — 2026-10-02

### D59-supersedes-writers

**Who writes a `supersedes` link, and what does the user see?** Today the relation exists, the context assembler follows it and the note-delete dialog labels it, but nothing writes one. Answered: **the user never picks a relation; a verb does, and the machine only suggests.**

- **Nothing is deleted.** `supersedes` is a link between two rows. Both files, rows and chunks stay; the older one is still readable and searchable, ranked lower.
- **The verb is "Newer version of…"**, never a bare "Replaces", which reads as delete. The older item shows "Replaced by → …", dimmed.
- **Three writers, newer → older:**
  1. **Manual.** "Newer version of…" in a document's menu; "Save as new version" on a note makes a new note that supersedes the old one.
  2. **At upload.** Uploading a document to a record that already holds one of the same `document_kind` offers the pick. Optional.
  3. **Suggested at intake.** A document of the same kind filed against the same record proposes the link in the suggestions inbox; accept writes it, a dismissal persists. Needs a new `suggestion_kind` value, so this writer carries a migration.
- **Never written automatically.** A wrong `supersedes` hides true facts from the AI, which is worse than a missing one — the same deterministic-acts, probabilistic-suggests rule as entity resolution.
- **The ranker demotes the superseded item.** Today `supersedes` is only a traversal edge (`DEFAULT_WEIGHTS.edge`, 0.5), while `halfLifeDays.doc_chunk: null` already assumes "a deck is true until superseded".

_Rejected:_ a relation picker (exposes internal vocabulary); auto-writing at intake; replacing the file in place (loses history — corrections are appends, as in the ledger).

_Build order:_ demotion + manual action → upload picker → intake suggestion. _Carried by_ no slice yet; add to the backlog when the documents area is next open.

### D60-person-companies-attribute

**Is "this person is at that company" a link or an attribute?** Today it is `link(contact_at)`, written by hand in `lib/server/people.ts` (create, and the link/unlink server fn) and read by the people list and the company page. It predates the attribute engine and was never folded into it. Answered: **an attribute.** People get a system attribute `companies` — `record_reference`, `targetKind: 'company'`, `multi: true` — and `contact_at` is retired.

- **One write path.** The value goes through `setValues`, which writes `link(references, attr_slug: 'companies')`, the same mechanism as `deals.company` and `deals.people`. Backlinks, the context walk and merge keep working with no new rule.
- **What it buys:** history in `attribute_event` ("moved from Kalpana to Vayu"), value-level provenance, a column/filter/sort in views, CSV import through the attribute path, and an end to the people list showing one company when a person has several.
- **Multi from the start.** Angels, advisors and co-investors sit at several companies, and flipping `multi` later rewrites every stored value from a uuid to an array.
- **Backfill.** A migration turns each `contact_at` link into a `companies` value through `setValues`, then nothing writes `contact_at`. Whether the enum value is dropped is the slice's call.
- **`founders` stays.** It is a role, not "works at"; the two may later be checked against each other, not merged.
- **Ranking moves.** `references` weighs 1 against `contact_at`'s 0.5 in `DEFAULT_WEIGHTS.edge`, so a person's company counts more in AI context. Check it in the slice.

_Rejected:_ keeping `contact_at` as a link (no history, no views, no provenance, and a second way to say a fact `founders` also says); a single `company` attribute (shape migration the first time someone has two).

_Carried by_ `graph-1` (`docs/roadmap-backlog.md`, Unplaced), a `migration` slice, so it runs alone on the migration lane.

### D61-review-not-inbox

**What is the review queue called?** `/inbox` holds two lanes, AI suggestions and duplicate candidates (`InboxLane`), and no email. "Inbox" reads as mail, and once Gmail and the forwarding lane land beside it the name will be wrong in the most confusing way. Answered: **"Review", at `/review`.**

- **What the user sees changes:** the nav item, the page heading, Today's "Review inbox" tile, and every toast, title and hint that says "inbox" ("proposed · review in the inbox", "waiting in the inbox").
- **The route moves:** `/review` is the page; `/inbox` and `/dedupe` both answer a permanent 301 to it, the pattern `/dedupe` already set. `review` joins `RESERVED` in the object registry beside `inbox` and `dedupe`, which stay reserved.
- **Internal names stay:** `lib/inbox/`, `components/inbox/`, `InboxLane` and test names are not renamed here. Renaming them is a separate chore with nothing a user sees.

_Rejected:_ keeping "Inbox" (reads as email); "Suggestions" (leaves out duplicates, which are not suggestions from the AI); "Queue" (says how it works, not what you do there).

_Carried by_ `review-1` (`docs/roadmap-backlog.md`, Unplaced). Wait for in-flight `apps/web` route work to land first: the route tree is regenerated.

---

## Addenda — 2026-10-02 (project 18's publish)

_Four decisions taken by the owner while publishing project 18 (plugins run unattended, Apollo enriches), against the code project 17 shipped. They settle the four slices that were `hitl`; all four are now `afk`._

### D62-drop-exit-75

**Does the worker get an exit-75 "reload, not crash" escape hatch?** Answered: **no.** In-process reload over `NOTIFY plugin_changed` (`sdk-14a`) plus an ordinary restart is the answer; hostability contract 2 (a worker death kills the container) stays exactly as written, and spec §7's exit-75 fallback is struck. Rejected: a supervise loop in `ROLE=worker` and an exception in the `ROLE=all` watchdog — a change to a locked contract for a case v1's first-party signed plugins do not need. Carried by `sdk-14b`, dropped.

### D63-manifest-action-placement

**Where does a plugin's manifest action appear, and what happens when the plugin is unhealthy?** Answered: in the **record head's action area**, beside the record's own actions, for every action whose `on` matches the record's kind; **absent** when the plugin is degraded, disabled or breaker-tripped, with Review and the Today line saying why. Rejected: a separate plugin panel (a second place to look), and a present-but-disabled control explaining itself (a broken control on every record). Carried by `sdk-17`.

### D64-web-listen-client

**May web hold a long-lived pg connection to stream job status?** Answered: **yes, one.** A single shared LISTEN client in web fans `job_status` notifications out over SSE to record pages; `runJob`'s ledger emits them, so no trigger and no migration. Pending and failed reuse the existing ledger cell states. State on reopen or reconnect comes from `job_run`, never from a missed notification. Rejected: polling (the latency the spec promised away), and a client per subscriber. Carried by `sdk-18`.

### D65-domain-event-emitter

**Where is `entity.created` emitted?** Answered: from **`resolveEntity`** (company and person births) **and `createDeal`** (deal births), after the birth commits, never on an attach; **skipped for `seed` and `import` births**. The dispatcher enqueues through each process's `Enqueue` service. `autoEnrich` is a per-integration toggle, **off by default**. Rejected: a `domain_event` outbox (new schema for one trigger), pg NOTIFY (neither durable nor transactional), and an emitter only in web's write paths (misses worker-born entities). Carried by `sdk-19`.

## Addenda — 2026-10-03

### D66-linked-storage-behaviour

**How do linked storage files and folders behave on a record?** Settled against Attio's Files tab, keeping `docs/spec-storage-sources.md`'s copy-in model underneath. Answered:

- **No folders the user creates.** §3.4 holds: kind, filed-against and space do what a folder would, and one file sits in several places. A linked folder shows **its own Drive tree, read-only**, grouped under the folder name, from each document's source path.
- **Native Google files open in Google.** Clicking a Doc, Sheet or Slides file opens it in Google; every other format opens in the in-app preview. "Open in Drive" is in every linked file's menu.
- **Native files default to `retain: text`.** Google is the source of truth, so we keep the text, chunks and pointer, refreshed by the change poll, and no exported bytes. PDFs, decks, images and office files keep `full`.
- **App delete never touches the provider.** The action is "Remove from record". Deleting in Drive is not offered.
- **Unlink deletes the copies that came only through the binding**, after a confirmation that gives the counts: row, blob when no other row shares the sha, chunks and embeddings. A file also filed elsewhere stays and loses only this filing. Drive is untouched, so re-linking restores. A file deleted _in Drive_ still keeps ours as `external_status: gone`; only an unlink the user chose removes copies.
- **One connection per Google product.** `account_connection` is keyed by `(user, provider, product, external_email)`: Drive, Calendar and Gmail each have their own consent, token, status and Disconnect, so disconnecting one never revokes another. One OAuth client per fund is shared. Incremental scopes grow only within a product.
- **Least-privilege scopes, named:** Drive asks `drive.file` (files picked in Google's picker) and adds `drive.readonly` only when a whole folder is bound; never full `drive`. Calendar asks `calendar.events.readonly`; never edit. Gmail asks `gmail.readonly` plus `gmail.send` (D67); never `mail.google.com` (it includes permanent delete), `gmail.compose` or `gmail.modify`. A product's consent screen never lists another product's scopes.
- **Menus:** local file — Rename · Download · Change kind · Remove. Linked folder — Rename · Upload file (writes to Drive) · Unlink. File in a linked folder — Rename (renames in Drive) · Download · Open in Drive · Remove from record.

_Rejected:_ user-created folders (a second organising scheme that cannot hold a file in two places); reference-only linking (no text for search or AI, dies with the token); deleting in Drive from the app (a founder's data room or a partner's folder is not ours to delete); one shared Google grant (disconnecting Gmail would revoke Drive).

_Carried by_ the storage slices when project 20 is reconciled: `storage-2b` and `storage-3b` (per-product connections), `storage-7` and `storage-8a`/`8b` (tree display, unlink), `storage-12` (native default), and spec §3.3, §6, §7, §12. _Follow-ups noted, not decided:_ a per-document chunk cap (a 250 MB text-heavy file embeds every chunk today), and a "source deleted" state for citations whose document is gone (refs are strings, so a delete leaves them dangling).

### D67-email

**How is email viewed, shared, tracked and composed?** Settled against Attio's email surfaces; it answers what `arrival-10` left open. Answered:

- **Store the email, not only its text.** `interaction` gains `headers` jsonb (from, to, cc, date); the raw MIME is kept as a content-addressed blob; the viewer renders its HTML sanitized in a sandboxed iframe, so scripts and tracking pixels never run. The body note stays the searchable, AI-readable text.
- **Attachments are documents** linked to their email by a join table (`interaction.document_id` stays one-to-one for transcripts), opened in the Files preview dialog. The list filters on "has attachments".
- **List rows** show subject, participants, a one-line summary, attachment count, category labels, "via <mailbox owner>" and date. The Interactions section filters by kind. `?modal=email&id=` deep-links an email.
- **Summary and labels are derived display text**, cached per email by the summarize and classify lanes under the sensitivity gate, rebuildable like embeddings. Never a proposal, never an attribute value.
- **Privacy, three layers.** Synced mail's bodies and attachments are private to the mailbox owner by default; forwarded mail stays shared (D49). A per-record override ("my emails with Flent are visible to the workspace") and per-email grants to named users widen it. Subject, participants, date and mailbox owner are always visible. `canRead` enforces it as an extension of note visibility.
- **Interaction stats.** A derived table per entity holds first, last and next interaction for email, calendar and any, each with its interaction id. The interaction writer updates it in the same transaction. Views sort and filter on it as read-only columns; it is not an attribute and not in `entity.values`. "Next" fills once calendar sync lands; connection strength builds on it later.
- **Team** on a company is a computed panel over D60's `companies` references. Editing it writes the person's value.
- **Drafts** are an `email_draft` row: author-private, local only (never synced to Gmail drafts), autosaved. Modes are new, reply, reply-all and forward, with `In-Reply-To`/`References` set. Trash deletes; Send sends.
- **Sending** goes through the Gmail plugin with `gmail.send`, so replies thread and land in the user's Sent folder. A sent email is written as an outgoing interaction at once; when sync later sees it, Message-ID dedupes.
- **Recipients** are searched over people and their email aliases; the chip picks which alias. A new address goes through the participants module at send (D34).
- **Variables** become paths, one grammar shared with AI prompts: `{{name.first}}`, `{{company.name}}`, `{{last_interaction.when}}`. Review resolves them per recipient and flags blanks before sending.
- **Templates** gain a fourth kind, `email`: `{subject, body, attachments}`, favouritable.
- **Attribute shapes.** A person's name has first and last parts, and `canonical_name` is their join, kept in sync. `phone` validates as E.164 and takes `multi` as config. Location stays text. Email addresses are the identity aliases shown as one multi-value field.
- **Deferred:** outbox and scheduled sends, mass sending, sequences, signatures.

_Rejected:_ SMTP with an app password (weaker threading; Google is retiring app passwords); syncing drafts to Gmail (needs `gmail.compose` and two-way reconciliation); parsing first names from `canonical_name`; HTML in the note body (a second rendering of the one text body); summaries as proposals (buries Review); new relationship, interaction or location attribute types (the menu of fifteen holds).

_Carried by_ `arrival-10` and slices to be written when Gmail is reconciled. D66's Gmail scope line is amended to add `gmail.send`.

### D68-meetings

**How do calendar meetings and call recorders fit the graph?** A meeting is an interaction (`kind: meeting`), an activity on the records it touches, with no page of its own. Answered:

- **Events change; the row follows.** `interaction` gains a per-kind `meta` jsonb (D67's email `headers` becomes its email shape). For a meeting: `ends_at`, `status` (scheduled, cancelled), conference link, organizer, recurring instance id, each participant's RSVP. Calendar sync updates the row in place, keyed by iCalUID. A cancelled meeting is marked, never deleted, so notes on it survive.
- **RSVP is shown, never edited.** Calendar stays `calendar.events.readonly` (D66); "Open in Google" changes it.
- **Linked records** are `interaction_entity` edges: participants by the participants module, plus manual edges (D49's pin). A link never invites anyone.
- **Notes.** The write-up stays one canonical body (`interaction.note_id`, D30). A prep note is an ordinary note filed against the meeting's records.
- **Today gains a Meetings section** with day navigation, external meetings only (internal ones are not stored). The meeting dialog shows time and link, participants with RSVP, linked records, the write-up, artifacts, pending suggestions and **Prep**: the assembler over the linked records through the synthesize lane, shown on demand and ephemeral, with "Save as note". Not a Review proposal.
- **Recorders are plugins, one per provider.** Spaces never records, transcribes, joins calls or asks for consent.
  - Each plugin declares a `webhook` or `schedule` job and calls ports. It passes match keys to `Content.logInteraction` (calendar event id or iCalUID, else start time plus participant emails); **the interaction writer decides**: attach to the calendar meeting, or create a `call` only when nothing matches. One meeting, one row.
  - Speakers go through the participants module.
  - A transcript is a document: copied, chunked, embedded.
  - A recording is kept as a link, never copied (large, no text layer, the provider is the archive).
  - A provider summary is a note suggestion; accepting makes it the write-up (`arrival-7`).
  - User-authored notes (a per-integration "these notes are mine" switch, e.g. Granola) fill the write-up only when it is empty; otherwise they are a suggestion. AI summaries never take this path.
  - Action items are task suggestions, which needs a new `suggestion_kind` (a migration).
  - The raw payload goes to `Receipts`.
  - Google Meet's recordings and Gemini notes arrive through the Drive plugin and match the same way.
- **One meeting, many artifacts.** D67's email–document join table carries a `role`: attachment, transcript, recording link. It replaces `interaction.document_id` before `arrival-6` builds on it.
- **Privacy follows D67:** a recorder's transcript and notes are private to the person whose tool made them; that a recording exists, and its length, are visible. The sensitivity gate applies to every AI call over them.

_Rejected:_ a meeting entity or page (an activity, not a thing); editing RSVPs or events from Spaces (calendar write scope); copying recordings; a second interaction per recorder (the calendar meeting the user sees is the one row); auto-moving deal stages on a first meeting (later, and only as a suggestion).

_Carried by_ `arrival-5` (calendar), `arrival-6`/`arrival-7` (recorder, rewritten as one contract for every provider) and a Today slice, when that area is reconciled.

### D69-custom-objects-and-relationships

**How do relationships, attribute editing and custom objects behave?** Settled against Attio's object settings. Answered:

- **Relationships have four cardinalities** (1:1, 1:N, N:1, N:N), set in one Relationship dialog that names both sides. A relationship is a **pair of `record_reference` attribute rows**, one per object, joined by `options.inverseOf`. Both are real attributes: rail, list column, filter, sort, template variable, AI context. Not a sixteenth type.
- **The value is stored once, on the owning side;** the other side is derived.
  - Owner: the "many" side for N:1 and 1:N, holding a single reference; the side it was created from for N:N and 1:1.
  - The inverse reads the `references` links `setValues` already writes (`link_to_idx`); one resolver serves rail, views, variables and the assembler.
  - A write from either side becomes `setValues` on the owning side: one event, one history.
  - Cardinality is enforced in `setValues`: single vs multi on the owner, plus inverse uniqueness for 1:1.
  - Merge, delete, import and the context walk follow from the links they already handle.
- **Views learn inverse attributes:** `lib/views/sql.ts` compiles link-join and count expressions for filter and sort, with an index plan like `attr_idx_*`. This is the one new piece of work.
- **Existing references become pairs:** D60's person `companies` (N:N, owned by the person) pairs with company **Team**; deal `company` (N:1) pairs with company **Associated deals**; deal `people` (N:N) pairs with person **Deals**.
- **Edits widen only.** Single → multi and `select` → `multi_select` are allowed as a reshape that wraps stored values, logged as **one** event on the attribute, not one per record. Narrowing is refused. This replaces "decide `multi` up front".
- **System attributes are never archivable**, only user-created ones. "Structure fixed, content free" is unchanged: options, colours, currency code and defaults stay editable. Clutter is a display concern: the rail shows filled and pinned attributes, empty ones collapse under "Show all". Amends `spec-attribute-engine.md` §3.
- **Custom objects:** files and Drive bindings work as on core objects; every record keeps a `canonical_name`, so none is a bare id; archive, never delete; record templates as built. **Email on custom records is deferred**; when wanted, it derives through references as deals do (D49), plus a manual pin.
- **Deferred:** per-object permissions (until a second partner), teams, requirements, rules, notifications.

_Rejected:_ storing both sides of a relationship (every write, merge, delete and import keeps two rows agreeing — the drift `ENTITY_REFS` exists to prevent); a relationship attribute type; narrowing edits; archiving system attributes; deleting objects.

_Carried by_ no slice yet: the relationship pair and inverse resolver, the views inverse compilation, and the widening reshape, written when the attribute engine is next open. `graph-1` (D60) becomes the first pair.
