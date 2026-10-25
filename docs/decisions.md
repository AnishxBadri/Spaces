# Decision ledger

_Forty-eight decisions surfaced by the reconciliation pass of 2026-09-15 and closed on 2026-09-16/18. Every one is carried by a slice that is `hitl` precisely because of it; the answer belongs in that slice's body before it is picked up. Options, consequences and reversal costs are in §3 of `docs/roadmap.md` for the decisions whose carrying slice has not shipped; the rest are in that file's git history (trimmed 2026-09-27)._

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
| P17   | **D39-importer-parse-signature** — Does a plugin importer's `parse(file)` return a grid for the mapping wizard, or Claims?                                      | Option 1, carried by sdk-4a; **amended 2026-10-06**: a grid through the `Import` port is pre-mapping input (see the addendum).                         | `sdk-4a`              | 1      |
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

### D50-local-embedding-seam — withdrawn

_Withdrawn 2026-10-06 by the owner: **local embeddings are Ollama only**, and there is no in-process model. A transformers.js model adds the ONNX runtime (~44 MB plus `sharp`) to every worker image, a web↔worker seam and an idle model lifecycle. All of that buys only the step of running Ollama, which is one optional compose service for an operator already on Docker. `ai-9c` (SPA-161) was built on the LISTEN/NOTIFY answer, merged, then reverted. Its `embed_request` table stays in the journal (0061) and is dropped by 0062. The question below is moot._

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

_Amended 2026-10-06 (D39, amended):_ a dialect importer hands core a grid through the `Import` port — pre-mapping input that core walks through the same mapping, preview and commit as a hand-mapped CSV. The job still calls a port; it still never maps, commits or writes a record.

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

_Carried by_ `graph-1` (shipped), a `migration` slice, so it runs alone on the migration lane.

### D61-review-not-inbox

**What is the review queue called?** `/inbox` holds two lanes, AI suggestions and duplicate candidates (`InboxLane`), and no email. "Inbox" reads as mail, and once Gmail and the forwarding lane land beside it the name will be wrong in the most confusing way. Answered: **"Review", at `/review`.**

- **What the user sees changes:** the nav item, the page heading, Today's "Review inbox" tile, and every toast, title and hint that says "inbox" ("proposed · review in the inbox", "waiting in the inbox").
- **The route moves:** `/review` is the page; `/inbox` and `/dedupe` both answer a permanent 301 to it, the pattern `/dedupe` already set. `review` joins `RESERVED` in the object registry beside `inbox` and `dedupe`, which stay reserved.
- **Internal names stay:** `lib/inbox/`, `components/inbox/`, `InboxLane` and test names are not renamed here. Renaming them is a separate chore with nothing a user sees.

_Rejected:_ keeping "Inbox" (reads as email); "Suggestions" (leaves out duplicates, which are not suggestions from the AI); "Queue" (says how it works, not what you do there).

_Carried by_ `review-1` (shipped). Wait for in-flight `apps/web` route work to land first: the route tree is regenerated.

---

## Addenda — 2026-10-02 (project 18's publish)

_Four decisions taken by the owner while publishing project 18 (plugins run unattended, Apollo enriches), against the code project 17 shipped. They settle the four slices that were `hitl`; all four are now `afk`._

### D62-drop-exit-75

**Does the worker get an exit-75 "reload, not crash" escape hatch?** Answered: **no.** In-process reload over `NOTIFY plugin_changed` (`sdk-14a`) plus an ordinary restart is the answer; hostability contract 2 (a worker death kills the container) stays exactly as written, and spec §7's exit-75 fallback is struck. Rejected: a supervise loop in `ROLE=worker` and an exception in the `ROLE=all` watchdog — a change to a locked contract for a case v1's first-party signed plugins do not need. Carried by `sdk-14b`, dropped.

### D63-manifest-action-placement

**Where does a plugin's manifest action appear, and what happens when the plugin is unhealthy?** Answered: in the **record head's action area**, beside the record's own actions, for every action whose `on` matches the record's kind; **absent** when the plugin is degraded, disabled or breaker-tripped, with Review and the Today line saying why. Rejected: a separate plugin panel (a second place to look), and a present-but-disabled control explaining itself (a broken control on every record). Carried by `sdk-17`.

_Amended 2026-10-25 (the canvas port):_ a plugin's verbs leave the record head for the record's `···`. They sit there as their own group, headed by the plugin's name in mono caps (`EXA`), after the record's own items, and the group is absent while the plugin is degraded, disabled or breaker-tripped — Review and the Today line still say why. The outcome of a run is a toast (`Exa found 5 · brief in Review`, with an underlined `Review`), never a figure in the head. The host's own **Enrich** is not a plugin action and stays a head verb, reading `Enriching…` while a run is in flight. Why: a record head is `[verb] [verb] [···]` on every kind (contract A4), and a head that grew a button per installed plugin broke it. Carried by project 30's record-head slice.

### D64-web-listen-client

**May web hold a long-lived pg connection to stream job status?** Answered: **yes, one.** A single shared LISTEN client in web fans `job_status` notifications out over SSE to record pages; `runJob`'s ledger emits them, so no trigger and no migration. Pending and failed reuse the existing ledger cell states. State on reopen or reconnect comes from `job_run`, never from a missed notification. Rejected: polling (the latency the spec promised away), and a client per subscriber. Carried by `sdk-18`.

_Amended 2026-10-25 (the canvas port, with D63):_ the stream's consumer on a record page is the completion toast, not a figure in the record head: plugin actions live in the `···` (D63 amended), so there is no head lane to update. The one LISTEN client, the `job_run` read on reopen and the reuse of the ledger's pending and failed states stand.

### D65-domain-event-emitter

**Where is `entity.created` emitted?** Answered: from **`resolveEntity`** (company and person births) **and `createDeal`** (deal births), after the birth commits, never on an attach; **skipped for `seed` and `import` births**. The dispatcher enqueues through each process's `Enqueue` service. `autoEnrich` is a per-integration toggle, **off by default**. Rejected: a `domain_event` outbox (new schema for one trigger), pg NOTIFY (neither durable nor transactional), and an emitter only in web's write paths (misses worker-born entities). Carried by `sdk-19`.

## Addenda — 2026-10-03

### D66-linked-storage-behaviour

**How do linked storage files and folders behave on a record?** Settled against Attio's Files tab, keeping `spec-storage-sources.md` (removed)'s copy-in model underneath. Answered:

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

### D66-linked-storage-behaviour — amended (the Files tab, 2026-10-11)

**What does a record's Files tab look like?** The owner confirmed the printed Files sheets (Files — printed, 00–04) on 2026-10-11. Answered: **one add row, our files grouped by kind, a bound folder as its own band, every row ending on a state word.**

- **The add row** opens the tab: `+ Drop files, or paste a Drive link…`, then **Attach from Drive**, **Upload** and a `···` holding **Link a Drive folder**. The whole tab is the drop target: a dashed pine wash reading `Drop n files on <record>` with the one hint that costs something, `kind guessed from each name · up to 250 MB each`. The Drive button says what it will do by readiness: **Connect Drive** (no connection for you), **Attach from Drive…** (Google's picker), `Picker not set up` disabled (an admin adds the picker key).
- **Our own files are grouped by kind** under caps labels (`DECK · 2`, `CAP TABLE`, `DILIGENCE`, `LEGAL`, `ARTICLE`, `OTHER`); an empty kind does not show; we make no folders (D66 holds).
- **A row** is a 28px 1px-ink glyph by file _type_ (pdf, docx, xlsx/csv, pptx/key, png/jpg, txt/md, zip, eml; a Google Doc, Sheet or Slides file wears its product mark), the name, a mono end lane `4.1 MB · 09-02`, a **state word in lowercase mono** — `uploading. 42%` with a dithered bar and `×`, `fetching.`, `reading text.`, `following`, `replaced → v3` (the row drawn lighter), `■ gone` (our copy kept), `no text`, `google ↗` — and a `···`. A blank lane means nothing is happening. The extracted-text snippet, the per-row icon strip and the always-open dropzone of the shipped section go.
- **A bound Drive folder is its own band** under our files: the Drive-folder glyph, its name, `n · synced 4m ago`, `read-only`, `···`; its tree is Drive's, subfolders fold, a native file reads `edited MM-DD · google ↗`, a deleted one `■ gone`.
- **Adding:** an upload lands in its kind at once; a pasted Drive link becomes a `JUST ADDED` row that reads `fetching.` then the file (`from My Drive / Data room · deck · 6.8 MB`); a pasted _folder_ link is refused in place (`That's a folder. Link a Drive folder instead to keep it in sync.` with **Link folder…**); with no connection the link row offers **Connect Drive**.
- **Linking a folder** is a window titled with the Drive path in mono: `FILES LAND ON <record>`, `INSIDE n files · n folders · 61 MB`, ☑ **Map subfolders** (its hint: folder names set the kind, a folder named like a deal files on it), **Keep** Full copies | Text only (hint: `61 MB on this server · previews work offline`), ☐ **Sensitive** (`Ask reads these files with a local model only.`), foot **Cancel · Link folder**. The three hints survive the invariant-line test: cost, privacy, consequence.
- **The row `···`:** Open · Download · Change kind › (the kinds, the current ticked) · Newer version of… · Remove… — a dithered popover. This supersedes the "local file" menu above; a file in a bound folder keeps **Open in Drive** as its `google ↗` lane and **Remove from record**. **Remove** confirms as a crimson-square window: `Remove <name>?`, one sentence saying whether it leaves the server, the ledger `Leaves the server  3.8 MB · 41 chunks`, **Keep · Remove**.
- **The viewer** is a window over the record (solid shadow): title bar with the glyph, name and `deck · 4.1 MB · 14 pages`, page nav `‹ 5 / 14 ›`, `- fit +`, **Download**; a thumbnail rail left; a sidebar with **KIND** (a Select), **FILED ON · n** with `+ File on…`, **VERSIONS · n** (`v3 · this one`, each with its date and who), **TEXT** (`14 pages read, 3,812 words.` and **Ask about this file**), **MENTIONED IN · n**, **SOURCE** (`uploaded by Anish · 2025-09-02`, `sha 3f9c…a21e · stays on this server`); foot **Delete file…** (crimson) and **Re-read text**. The sheet's `×` in the title bar is superseded by the close-mark rule (2026-10-06, built 2026-10-10): the window closes from its foot.
- **The `/files` shelf is unchanged** by this amendment (no sheet draws it); it stays the shelf of `docs/design-contract.md` §3.

_Rejected:_ a rows-of-icons action strip (the `···` holds it); showing the extracted text under the name (it is a search result, not a file fact); a dropzone always open at the foot (the whole tab is the target).

_Carried by_ `sweep-8` (SPA-341) for the tab, viewer, link window and menus on the shipped section; `storage-8a/8b` (SPA-255/264) for the bound band's sync; `email-2` (SPA-276) for attachments; `doc-1/2` (SPA-245/253) for Newer version of…; Files — printed, sheets 00–04.

### D67-email

**How is email viewed, shared, tracked and composed?** Settled against Attio's email surfaces; it answers what `arrival-10` left open. Answered:

- **Store the email, not only its text.** `interaction` gains `headers` jsonb (from, to, cc, date); the raw MIME is kept as a content-addressed blob; the viewer renders its HTML sanitized in a sandboxed iframe, so scripts and tracking pixels never run. The body note stays the searchable, AI-readable text.
- **Attachments are documents** linked to their email by a join table (`interaction.document_id` stays one-to-one for transcripts), opened in the Files preview dialog. The list filters on "has attachments".
- **List rows** show subject, participants, a one-line summary, attachment count, category labels, "via <mailbox owner>" and date. The Interactions section filters by kind. `?modal=email&id=` deep-links an email.
- **Summary and labels are derived display text**, cached per email by the summarize and classify lanes under the sensitivity gate, rebuildable like embeddings. Never a proposal, never an attribute value.
- **Privacy, three layers.** Synced mail's bodies and attachments are private to the mailbox owner by default; forwarded mail stays shared (D49). A per-record override ("my emails with Flent are visible to the workspace") and per-email grants to named users widen it. Subject, participants, date and mailbox owner are always visible. `canRead` enforces it as an extension of note visibility.
  - _Amended 2026-10-16 (owner):_ **filing a private attachment onto a record does not widen it.** An attachment carries `visibility` and `author_id` like a note (migration 0085, SPA-359): a synced one is born `private` to its mailbox owner, and where it is filed changes nothing about who reads it. Only the layers above widen it — a forward or a shared arrival onto the same bytes, the mailbox's share toggle, and (once SPA-277 lands) the per-record override and per-email grants. The old per-query predicate let filing share by accident; that loophole is closed, not restored.
- **Interaction stats.** A derived table per entity holds first, last and next interaction for email, calendar and any, each with its interaction id. The interaction writer updates it in the same transaction. Views sort and filter on it as read-only columns; it is not an attribute and not in `entity.values`. "Next" fills once calendar sync lands; connection strength builds on it later.
- **Team** on a company is a computed panel over D60's `companies` references. Editing it writes the person's value.
- **Drafts** are an `email_draft` row: author-private, local only (never synced to Gmail drafts), autosaved. Modes are new, reply, reply-all and forward, with `In-Reply-To`/`References` set. Trash deletes; Send sends.
- **Sending** goes through the Gmail plugin with `gmail.send`, so replies thread and land in the user's Sent folder. A sent email is written as an outgoing interaction at once; when sync later sees it, Message-ID dedupes.
- **Recipients** are searched over people and their email aliases; the chip picks which alias. A new address goes through the participants module at send (D34).
- **Variables** become paths, one grammar shared with AI prompts: `{{name.first}}`, `{{company.name}}`, `{{last_interaction.when}}`. Review resolves them per recipient and flags blanks before sending.
- **Templates** gain a fourth kind, `email`: `{subject, body, attachments}`, favouritable.
- **Attribute shapes.** A person's name has first and last parts, and `canonical_name` is their join, kept in sync. `phone` validates as E.164 and takes `multi` as config. Location stays text. Email addresses are the identity aliases shown as one multi-value field.
- **Bcc** (amended 2026-10-08): a draft carries To, Cc and Bcc. Cc and Bcc open from the address block and stay closed when empty; a Bcc chip reads as hidden. Bcc recipients are not linked to records the way To and Cc are, so a Bcc stays hidden everywhere.
- **Inline images** (amended 2026-10-08): images carried inside the stored MIME (`cid:` parts) render in the viewer, since showing them loads nothing. Remote images still never load; the viewer counts them and keeps each at its size.
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

### D70-find-and-ask

**What does Cmd-K do, and where does a question about your own data get answered?** Answered: **Cmd-K finds and goes; Ask answers.** Split by the question, not the technique.

- **Cmd-K is the finder.** Instant, deterministic, keyboard-first.
  - Groups in order: **Jump to** (objects, saved views, settings pages) · **Actions** (verbs with their printed keys, contextual — on a record its own verbs first: Log interaction, Write email, Move stage) · **Records** (lexical + fuzzy only, so typing a name always puts that record first) · **Passages**.
  - **Passages** is the existing semantic lane (SPA-129, second wave after typing pauses), kept only as a finder: places to go (a deck page, a note paragraph), never answers, never mixed into record ranking.
  - Highlighting a result opens a preview pane: a record's readout strip and key fields; an object's views and counts. Nothing highlighted, the list runs full width.
  - Foot: navigate · actions on this result · open · **Tab hands the typed query to Ask**.
  - Amended 2026-10-08:
    - **Nothing typed** shows only the page's own actions; no recent items.
    - **A highlighted passage previews** its page and the matched text; ↵ opens the file viewer at that page.
    - **An action that needs one more answer** (File in a space…) asks it in the same palette; the input's mode label names the action, and ⌫ on an empty input returns to Find.
    - **Ask shows Stop** while it is answering.
- **Ask is the agent.** The same palette after Tab (or ⌘J), plus a full thread view.
  - It is a **second, in-process client of the MCP tool surface** — `search_records`, `get_record`, `get_context`, propose — so external agents and the in-app chat share one set of tools, permissions and rules (spec-ai-substrate §5–6).
  - **New tools:** `query_records(object, conditions, sort, limit)` over the views compiler and D67's interaction stats, so filters and counts are computed, never generated; portfolio tools over the pure portfolio libraries, so money is computed too.
  - **Answers cite** every claim (`doc:…#n`, `note:…`). "Save as note" promotes an answer, as Prep does (D68).
  - **Action cards:** the agent proposes (create task, move stage, file into a space); applying one writes as the user. AI still only proposes.
  - **Scoping:** `@space` or `@record` in the prompt narrows retrieval and context; a space's memos and filed companies are what make "what do we believe about this market" answerable.
  - **Threads** are private to their author and are not entities: no mentions, no search hits.
  - Inherited: `canRead` as the user, the sensitivity gate per call from what was retrieved (local model or refused), an `ai_run` per turn under the daily cap.
- **Build order:** `query_records` first — it makes the MCP server useful for real questions before any chat UI exists — then threads, the Ask surface, action cards, scoping.

_Rejected:_ semantic ranking inside Records (a name typed must win); Cmd-K answering questions (it finds); a separate tool set for the in-app chat (two rule sets); the agent writing directly; chat threads as entities.

_Carried by_ no slice yet; `query_records` is the first, when the AI area is next open.

### D71-space-structure-in-context

**Does the AI see the shape of the market map, or only its memos?** Today the assembler climbs from a record's filed spaces up their ltree ancestors and pulls the memos filed there (hop 1 direct, hop 2 ancestors, `space` edge 0.8), plus space-scoped glossary terms. It never sees where the record sits, what sits beside it, or the tree itself. Answered: **give it position, peers and shape.**

- **Position.** One context item per filed space naming its full path (`Filed in: Spacetech › Launch › Small-lift`), so answers can place a record without inferring it from memo prose.
- **Peers.** A capped peer set: other companies filed in the same leaf space, ranked by stage and recency, each with its key values. The competitive set, for comparative answers.
- **A space as the subject.** When the seed is a space (`@Hydrogen` in Ask, D70), the assembler returns its subspace tree with counts, its memos, its companies grouped by stage, and its terms — so a whole market can be summarised or its thin branches found.
- **Structured queries over the tree.** `query_records` (D70) takes a `space` condition that includes descendants, matching ancestor visibility (2026-09-21).
- Peers and tree are ranked and capped like every other candidate, so they compete for the context budget rather than flood it. `canRead` applies, and a sensitive space anywhere in a path keeps the call sensitive, as the resolver already does through ancestors.

_Rejected:_ memos only (the thesis without the map); the whole tree in every call (budget); peers across all spaces (noise — the leaf is the competitive set).

_Carried by_ no slice yet; it lands with the assembler and `query_records` work in D70.

## Addenda — 2026-10-06

### D72-space-watches

**How do research engines (Exa, Harmonic, later news and RSS) use a space, and how does a space use them?** A space is the unit a research plugin works on — a definition of what belongs (memo, criteria, terms, exemplar companies), a growing set of members, and monitoring over time — which is what an Exa webset is. So engines attach to spaces, not to records, and the space never knows which engine. Answered:

- **Four integration roles**, each a way of using the existing ports, never a plugin kind (D51): **enrich** (facts through `Facts.fill`, conflicts to Review — Apollo), **monitor** (`schedule` or `watch` → signals; a time series is signals, never values), **discover** (new companies → add-record cards), **research** (web signals plus a cited brief through `Judgment` — Exa).
- **A `watch` trigger**, sixth beside action, event, schedule and webhook. A watch job runs once per `space_watch` row with the space as its subject. The manifest declares a per-watch settings schema the same way it declares `settings`; the host renders the form. Exa's is criteria and a per-run cap; Harmonic's is structured filters.
- **`space_watch` is host state:** space, integration, settings, cadence (**nullable — a watch with no cadence runs only on "Run now"**, and the button is present on scheduled watches too), a plugin-owned `state` jsonb cursor (the webset id, a saved-search id, a history id), last run and a run log. A watch is a saved research lens on a space; the clock is optional.
- **`Spaces` port**, read-only, one call: the brief D71 already builds for the assembler — path, memo, criteria, terms, filed companies with key values, subspace tree with counts. Exa turns it into a webset query and criteria; Harmonic turns the exemplars into seeds. Same material, two engines.
- **`Discover` port**, the hand-back: name, domain, aliases, evidence refs, an optional subspace hint. The host runs `previewResolve`: known and filed here → dropped; known elsewhere → a "also file X here?" card (`suggestion_kind: file_record`); unknown → an "add X?" card (`suggestion_kind: add_record`). Accept runs `resolveEntity`, files, and fires `entity.created` so a targeted auto-enrich follows. **Dismissals are permanent per (space, domain)** and are applied before a card is made. Review groups the cards under a space head, labelled "via <plugin>".
- **Signals on members** go through the existing `Content` port and show in a "What's moving" lane on the space page; a Watching lane lists the watches with live status over D64's stream. Today counts the space's open cards.
- **Space gains a `criteria` text**, one to three sentences, "what belongs here". The memo stays the thesis; criteria is the membership rule websets need literally and the classify lane needs to place a candidate in a leaf.
- **Discovery fills the map; the pipeline is a separate act.** A card never creates a deal. Tracking, not evaluating.
- **Ask (D70) mounts a plugin's MCP server** when the manifest declares `mcp: { url, auth }`, keyed from the vault, proxied through the Http throttle and the D53 credit cap, and unmounted for a turn whose context holds a sensitive space. Hits are web results, filed records are records; action cards are the only crossing, and "Save as watch" writes a `space_watch` from the turn, as "Save as note" promotes an answer. Enabling Exa lights the watch, the record action and the Ask tools from one integration row.
- **Apollo gaps noted from the same thread:** a cleared value counts as user-held (fill-blanks refills a cleared field today — `setValuesInTx`, `lastWriters`, `ownedBy`); `Content` joins Apollo's `uses` for funding and hiring signals; relationships fill only when empty, else a card; a targeted auto-enrich scope (deal, space, meeting) replaces the on/off `autoEnrich`; credits are visible in the project 19 ledger.
- **Rules.** No workflow builder. When wanted, a rule is one trigger → one action over domain events, which needs `stage.changed`, `filed` and `meeting.ended` beside `entity.created` (D65).
- **Ordering.** Not first ship: it needs the Ai port's live layer (`backfill-11`), new schema, two ports and a trigger. First ship carries Exa as the record-level Research action (`backfill-12`) only; watches land in the ship after, once D73 has made spaces malleable, and Harmonic rides in then as one plugin with no host work.

_Rejected:_ research as a record-level feature only (a webset is a set, and the set is the space); engines knowing the space table (one coupling, the watch row); a row-less one-shot "Research" action on a space beside the watch (two near-identical paths and two homes for Exa's settings); a feed poller in core (D33 closes: feeds are a watch plugin); cards creating deals; a separate tool set for Exa in Ask (D70's one-client rule).

_Carried by_ no slice yet; written when project 23's research area is reconciled.

### D73-spaces-are-malleable

**Is the space tree a one-time taxonomy, or can it be reorganised?** Today only `createSpace` exists: no rename on the space head, no move, no archive, and the merge executor excludes spaces on purpose. The thesis since 2026-09-21 is that structure emerges from encounter and depth is earned, which is false for a tree that cannot be corrected, and D72's watches multiply spaces, so more of them will be wrong. Answered: **malleable, and before any watch ships.**

- **Why it is cheap:** the ltree path is the only derived structure and every consumer computes from it at read time — ancestor visibility, sensitivity inheritance, the assembler's climb, glossary scope, watches and dismissals all join by id and then read the path. Filings in `entity_space` point at the space id, never the path.
- **Rename:** `renameRecordProgram` wired to the space head. Slug and path are unchanged; the path is never shown.
- **Move (reparent):** one UPDATE rewriting the subtree's paths and `parent_id`; one event; refused under its own descendant. Visibility, sensitivity and context follow at once.
- **Archive:** hidden from the picker and the tree, filings kept, watches paused, cards stop. Never delete.
- **Split** is not a primitive: create a child, then multi-select "move here" on the parent's companies, over tag and untag. Depth earned by hand.
- **Merge two spaces: deferred** until two collide. It needs its own executor (reparent children into the winner, dedupe filings, repoint memos, terms, watches and dismissals through `ENTITY_REFS`, snapshot for unmerge). Archive the loser and refile by hand in the interim.
- **Two invariants:** filings never change on their own — move and merge rewrite structure, and only split and merge touch filings, each on an explicit choice; watches and dismissals follow the space by id, so a rename or move mid-watch changes nothing and a merge unions them.
- **Later:** a watch may propose a subspace as a Review card when candidates cluster; move and split are what make accepting it safe.

_Rejected:_ a fixed taxonomy (rejected again); deleting spaces; merge now (no pain yet, medium cost); filings following a move anywhere but with their space.

_Carried by_ no slice yet; precedes D72's watches.

### D74-record-body-is-tabbed

**Does a record's body stack its sections, or tab them?** The 2026-09-30 declutter split the body into Notes, Interactions, History, Files and Context as stacked sections collapsed to bone heads, with empty sections hidden. Since then Interactions (D67, D68) and Files (D66) have each become whole views — a ledger with kind filters, a Drive tree — and stacking makes them fight for one scroll. Answered: **tabbed.**

- **Body = a details column left, the tabbed view right.** The details column, 320px on bone, holds the property grid as single label–value rows and then the relationship sections (Waiting, Team, Associated deals, Spaces, Tasks): one place for what the record is. The view right takes every remaining pixel: a 44px bone tab head — Notes · Interactions · Files · History, each with its mono count — over one view: one place for what happened to it. The readout strip stays full width above both. (Amended twice the same day: the first draft kept the rail right of the tabs, which left the ledger 618px wide and two structures competing; the second had a fifth Context tab, cut because it showed how Ask reads the record rather than the record — owner, 2026-10-06.)
- **Default is Notes**; the last tab used on that object is remembered per user, like table prefs.
- **Each tab owns its room.** Interactions keeps its kind filters (All · Email · Meeting · Call) as a second row inside the tab; Files holds the local list and the bound Drive tree; History is the attribute and stage ledger.
- **Context is not a tab.** What Ask assembled for a record is shown where it is doubted: the answer card's `Sources n · pinned ›` footer expands to the ranked ledger (kind, source, why, pinned or excluded). Pin and exclude live on the note and file rows' `···` menus, stored on the record, and read back as provenance in the footer. Token counts and rank reasons beyond two words stay out of the product.
- **Empty tabs stay visible and grey, count 0.** The empty-section rule becomes "grey what is empty", so the tab head remains the record's index.
- **Deep links:** `?tab=files`; `?modal=email&id=` opens over the Interactions tab; `?modal=meeting&id=` likewise.

_Rejected:_ stacked collapsed sections (the 09-30 answer, superseded now that two sections are products); a rail right of the tabs (two structures side by side, the view starved of width); an "Overview" tab that re-summarises (the readout strip and the details column already do); hiding empty tabs (loses the index); a Context tab (introspection of the assembler, routinely empty on a fresh record, and every use it had — see the sources, pin, exclude — has a home on the answer card or a row menu).

_Carried by_ the record port slice beside SPA-214 for shipped routes, and the anatomy sheets O1–O4 on the canvas; E1 and S1 are the Interactions and Files tabs of the same record.

_Amended 2026-10-25 (the canvas port):_

- **Overview is the first tab and the default**, and it opens every time: the per-user memory of the last tab goes. The tabs read Overview · Notes · Interactions · Files · History. Overview holds the readouts that have a value (never a `—` or a 0), the open tasks with their composer, the latest three threads and the latest files, each group ending on a link to its tab. **The readout strip under the title goes**; its figures live in Overview. This reverses the rejection of an Overview tab above: what it would have re-summarised was the readout strip, which is gone.
- **Empty tabs show in graphite with no count.** A tab that holds something carries its count; an empty one stays visible, so the tab bar is still the record's index, but prints no 0. This supersedes "grey, count 0".
- **The details column is the rail:** the attribute grid and the relations (Team, Associated deals, Spaces, Waiting), each empty relation one `Name +` row. Tasks leave it for Overview.
- **Interactions' kind filter is a bounded Segmented** (All · Email · Meetings · Calls, with counts) in the tab's toolbar, and the tab has no composer: the head's Log interaction is the control. This supersedes "a second row inside the tab".
- **Notes loses its filter row.** Filed notes come first; the meeting notes D78 files sit under a `FROM MEETINGS` band in the same list instead of behind a filter.

_Carried by_ project 30's record slices (the head, Overview and the rail, the tab bodies).

### D39-importer-parse-signature — amended

**Does a dialect importer hand core claims or a grid?** Amended by the owner while carrying SPA-172: **a grid is pre-mapping input; the plugin never maps or commits.** A `file` job that reads a dialect (an Airtable CSV export first) calls a new `Import` port, `Import.stage({ columns, rows })`, each row carrying its ordinal. The plugin does the dialect's work — splits comma-joined multi-selects into lists, keeps linked-record display names as names, reduces attachments to their URLs — and stops there. Core lands the grid in `import_batch`/`import_row`, and from there it walks the mapping, preview, commit and batch void a hand-mapped CSV walks. The plugin never maps, previews or commits, and never writes a record.

- **D52 holds:** the job calls a port, it does not return a grid. **D12 holds:** the batch is an ordinary staged batch, so batch reversal and the idempotent re-run apply unchanged.
- **Per-row errors stay per-row.** A unit of output that does not decode fails its own row: placed rows land with no cells and plan as `no-land`, unplaceable ones are returned to the job as refused, and the rest of the batch commits.
- **`Import` is additive:** SDK 1.0.0 → **1.1.0**, a minor. So is the optional `accepts: { filename }` on a `file` job, which is how web routes a dropped file to an enabled plugin without running plugin code.

_Rejected:_ `Identity.resolve` and `Facts.fill` row by row (no SDK change, but no preview, no `import_batch`, no batch void and no idempotent re-run).

_Carried by_ SPA-172 (`plugins/airtable`).

### D75-identity-is-a-unique-attribute

**Is identity (a person's emails, a company's domains) an attribute or something outside the attribute engine?** Until now it lived only in `entity_alias`: never in `entity.values`, never in views, imports or the API's `values`. Each record page drew it with its own hand-built rows, and SPA-300 moved LinkedIn there too. The owner compared Attio's people object, where `email_addresses` is an ordinary multi-value attribute marked **unique** and LinkedIn is plain text. Answered (owner, 2026-10-06): **identity is a unique attribute, and `entity_alias` is its index.**

- **Person `emails` and company `domains` are system attributes**, multi-valued, carrying `options.identityKey`. They live in `entity.values` like every other value, so the record page, views, filters, import mapping, history and the API all see them with no special path.
- **`entity_alias` stays, as the enforcer.** `setValues` mirrors every identity-key value into an `is_identity` alias in the same transaction. This is the machinery custom objects' identity keys already use (SPA-95): `claimIdentityAlias` in a savepoint, a concurrent `23505` becomes a `duplicate_candidate`, and a removed value retires its alias. The partial unique index on `(kind, value_norm) WHERE is_identity` is still what makes "one owner per key" true under concurrency, and `resolveEntity` still matches on it. Postgres cannot index uniqueness inside a jsonb array; Attio gets it from storing one row per value, and the alias table is that row for the keys that need it.
- **LinkedIn is a plain `url` attribute on people and companies**: optional, not unique, not matched on, as in Attio. This reverses SPA-300's move of LinkedIn into `entity_alias`. A recaptured founder is matched by email when there is one, and otherwise reaches Review as a fuzzy-name duplicate candidate.
- **CIN is not a core identity key (amended the same day, owner).** It is India's company registration number, and Spaces stays country-agnostic. It is removed completely: no default field, no matching, no import target, no normalizer, no SDK `Identity` key or `Read` field, and no `alias_kind` value. Nothing is released, so there is no deprecation period and no SDK major. A user who tracks it adds their own text attribute.
- **Name aliases are unchanged.** They are history, never identity, and stay alias-only.
- **A role address on a person is a non-identity value (amended 2026-10-07, owner).** `info@`, `team@`, `founders@` and the rest of `ROLE_PREFIXES` in a person's `emails` are stored like any other value but never mirrored into `entity_alias`, so `resolveEntity` never matches on one, enrichment never births a person from one, and any number of people may carry the same address. The record shows it marked "shared inbox". The list is the one the mailbox arrival uses to decide a shared inbox makes a company, not a person.
- **Supersedes** the rule in CONTEXT.md "Hard exclusions, never attributes … all identity" and the seeded-attributes note that emails and LinkedIn are aliases, not attributes.

_Rejected:_ identity only in `entity_alias` (the shape until now: invisible to views, imports and the API, and drawn by hand on each page); identity as plain attributes with no index (uniqueness becomes check-then-write in application code, and two concurrent imports both pass); LinkedIn as a unique identity key (Attio does not; the owner chose the simpler field); CIN as a seeded identity field (India-only; the product is country-agnostic).

_Carried by_ the Corrections slice that follows SPA-300. SPA-302 is cancelled, because the API's `values` now carry identity, and SPA-303 is rewritten so the deck reader fills the LinkedIn attribute again.

## Addenda — 2026-10-08

### D76-enrichment-is-a-host-capability

**How do enrichment plugins (Apollo first; Clearbit, People Data Labs after) fit a self-hosted product?** Attio fills its own "Enriched" attributes from data it owns, so its Apollo app competes for the same fields and falls back to a parallel set of `Apollo …` fields. Spaces owns no data: every enriched value comes from a source the owner points it at. Answered (owner, 2026-10-08): **enrichment is a host capability; providers are interchangeable sources.** Builds on D72's `enrich` role.

- **The host owns the experience:** the triggers, the rules (fill blanks only, a cleared value stays cleared, a disagreement with a person goes to Review), the where-from popover on a filled value, credits (an estimate before bulk, D53's cap per source, a cached result for N days) and what may leave the box.
- **A source answers one question:** given a domain, an email or a LinkedIn URL, what it knows and what that cost. It answers in a **host-owned enrichment vocabulary** (`company.headcount`, `company.founded_year`, `person.seniority`…), not in attribute slugs.
- **The link lives on the attribute.** An attribute carries "fill from enrichment: <key>". The system attributes are linked by default; an owner links their own attributes (e.g. "Employees" ← `company.headcount`). One link serves every source. **No `Apollo …` fields.**
- **Several sources run in the owner's order.** For each field, the first source with an answer wins. A disagreement between two sources is kept in the where-from history and never becomes a card; Review is only for a source against a person.
- **Free sources run first.** A built-in website source (the domain fetched by the server, read by the owner's own Extract lane) fills the description, links and logo with no key and no credit. Documents and email signatures already fill fields. A paid source is called only for the linked fields still empty.
- **What leaves the box:** a sensitive record never reaches an outside source (only local sources run); auto-enrich covers only the scopes the owner chose; each source's page says plainly what it sends ("domain only", "email and LinkedIn URL").

**Auto-enrich is the Enrich button pressed for the owner:**

- **Triggers:** record created, filed into a space, joins a deal, appears in a synced meeting, gains an identity (a domain or email added after birth). Seed and import births emit nothing (D65); those are enriched in bulk from a list, behind an estimate.
- **The host checks, in order:** in scope; not sensitive (else local sources only); not enriched within N days; has a key to look up (else it waits for the gains-an-identity event); not already queued (one job per record); credits left today.
- **Defaults:** the website source is on for every new record from install; a paid source starts with the deal scope only.
- **At the daily cap**, records are parked and run after the reset. Today shows one line ("Auto-enrich paused · Apollo cap reached · 14 waiting · resumes 00:00 UTC").
- **No periodic refresh** for now; a scheduled re-enrich of the portfolio is a later opt-in.
- **The writes are quiet:** one Review card per record listing every disagreeing field, a funding round logged as a dated event, and one timeline line ("Enriched · Website, Apollo · 6 fields · 1 credit"). No toast.

**What Apollo fills.**

- **Company (by domain):**
  - Built-in: description (`short_description`, else `seo_description`), founded, location, LinkedIn.
  - Identity: domains.
  - Funding stage: only when Apollo's wording matches one of the owner's options; it never adds an option.
  - Event: the latest round with its date, once per round.
  - Vocabulary keys for the owner to link: total raised, headcount, revenue, industry, keywords, tech stack, Twitter, Facebook, AngelList, Crunchbase, blog, company phone, HQ address, ticker.
  - Record picture: the logo, when empty.
- **Person (by email or LinkedIn):**
  - Built-in: job title, description (from the headline, only when blank), location, LinkedIn, Twitter.
  - Identity: the email, only when Apollo marks it verified and it is neither a role address nor locked.
  - Company link: an existing company, filled only when empty; an unknown company is proposed as an "Add X?" card. Enriching a person never creates a company.
  - Vocabulary keys: seniority, department, GitHub, Facebook.
  - Record picture: the photo, when empty.
  - Phone: opt-in, off by default, at extra credits.
  - Employment history: not stored. A changed title or company on a later enrichment is logged as a dated event ("Moved from Keyhold to Flent as COO").
- **Changing figures** (headcount, revenue, total raised) are values whose where-from carries the date. A newer figure replaces one no person set, and the old figure stays in the where-from history.
- **Not used:** departmental head count, Alexa ranking, retail location count, Apollo's internal tag ids. Apollo's own org and person ids stay in the raw response for an exact re-match and are never shown.
- **Records gain a picture** (logo or photo), filled only when empty. New, small.

_Rejected:_

- Each provider as its own app with its own fields, triggers and settings (Attio's shape, which exists because Attio owns the data).
- `Apollo …`-prefixed parallel fields: provenance per value makes them redundant.
- Mapping inside each plugin's settings: one link per attribute serves every source.
- Every source disagreement as a Review card.
- Dropping capped records.
- Periodic refresh by default.
- Changing figures as events only: heavier, and a figure the owner filters on must be a value.
- An enriched person silently creating its company.

_Carried by_ a rewrite of `enrich-1` (still with its four gaps); new slices for the vocabulary and the attribute link, the website source, bulk enrich, the gains-an-identity trigger and the record picture; and the Enrichment page in Integrations on the canvas.

### D77-exa-find-and-save-as-watch

**Where does Exa sit, given that it can enrich, research, and find companies from a description ("rental software startups in India")?** Apollo is a directory (lookup by identity); Exa is a search engine (lookup by description). Answered (owner, 2026-10-08): **Exa is the open web turned into four host jobs, and finding is the one that matters most.**

- **Four jobs, one integration.**
  - **Find:** who matches a description. Lives in Ask.
  - **Watch:** keep finding for a space (D72).
  - **Research:** web signals plus one cited brief on a record (`backfill-12`).
  - **Enrich:** a D76 source, after Apollo and off until enabled. It can come after first ship.
  - The host owns each job's surface; a plugin declares which jobs it does. Nothing is Exa-specific: the watch form comes from the plugin's settings schema, the Find table carries a "via" column, and enrichment is one ordered source list.
- **Find lives in Ask (D70), not on a search page.**
  - A **Find companies** button on the space head opens Ask docked with the space and the web in scope, the question prefilled from the space's criteria; ⌘J asks from anywhere.
  - Results arrive as a **table, not prose**: name, domain, one line, place, two or three source links.
  - Each row is checked against what is held: filed here → greyed; held elsewhere → **File here**; unknown → **Add** or **Add and file here**; dismissed for this space → hidden. Dismiss is permanent per (space, domain) (D72).
  - Adding runs `resolveEntity` and D76 enrichment follows. A result is a web result until it is added, and finding never creates a deal.
  - A turn whose scope holds a sensitive space never reaches Exa.
- **Fast search for a question, a webset for a watch.** Ask uses Exa's search (seconds, approximate). **Save as watch** creates a webset (slower, verified against the criteria, incremental from a stored cursor).
- **Save as watch:**
  - **Needs a space.** The scope's space is preselected. From a turn with none, a picker asks which space and offers to create one named from the question.
  - **A window prefilled from the turn:** engine, a name, "Look for" (the question, blank when it equals the space's criteria), how often (**Weekly** when saved from Ask; "Manual" stays first in the list and stays the default on the space page's Add watch), "At most" per run.
  - **The turn's results are carried, not repeated:** rows added are members, rows dismissed are dismissals, and **rows left untouched become `add_record` cards in Review** under the space.
  - The thread keeps a line linking to the watch ("Saved as a watch on Property ops"), which says so if the watch is later deleted.
  - The same space, engine and settings is refused as "Already watching this" (D72's unique index) and opens the existing watch.
- **Consolidation is by result, not by watch.** Differently worded questions are separate watches. **One open `add_record` or `file_record` card per (space, domain)**: a later find appends its evidence to the open card ("found by 2 watches") instead of proposing again. Every candidate passes the same three checks: member, dismissed, open card. No new table.
- **Ordering amends D72's.**
  - `ask-8` splits. **Find** (Exa in Ask, the results table, Add / File here / Dismiss) follows `watch-3`, since it needs only the two card kinds and `previewResolve`. **Save as watch** stays after `watch-4`.
  - Exa's order: Research (`backfill-12`), then Find, then the watch (`watch-5`), then the optional enrichment source.

_Rejected:_

- A separate search page for Find.
- A one-shot "Research" action on a space beside the watch (D72's rejection stands; Find in Ask is the one-shot).
- Dropping untouched results at save.
- Merging watches.
- One card per watch per company.
- Watches without a space.
- Shipping Find last, behind the Watching lane.

_Carried by_ the split of `ask-8` (backlog and Linear), the per-(space, domain) open-card rule in `watch-3`, the save flow in `watch-4`, and the Find table and save window on the canvas.

### D78-recorder-notes-by-folder

**How does a note-taking recorder (Granola first) reach a meeting, and who sees what it sends?** Granola has a read-only REST API, launched February 2026, on Business and Enterprise plans only. Each member makes their own key. It has no webhooks. A note carries:

- `private_notes` (what the person typed, visible only to them)
- `summary` (the AI-enhanced notes)
- `transcript`, `attendees`
- `calendar_event.calendar_event_id`
- `folder_membership`, `web_url`, `deleted_at`

Notes still processing are not returned.

In Attio, Granola pushes: the person shares a note (Share → Attio) or a whole folder, and nothing else reaches the CRM. A self-hosted Spaces cannot receive that push, so it pulls, and copies the intent. D68 also contradicted itself: notes the person wrote "fill the write-up when empty", yet a recorder's notes are "private to the person". The write-up is shared, so filling it would expose them.

Answered (owner, 2026-10-08): **the folder is the share decision.**

- **The meeting model is D68's, unchanged.** One `interaction` row per meeting, keyed to the calendar event, with no meeting page. A recorder note matches by `calendar_event_id`, else by start time plus attendee emails, else it births a `call`.
- **A recorder is a personal connection.**
  - Each member pastes their own key under You → Meeting notes (D81). This is the first key-based personal connection beside the OAuth ones.
  - The plugin is installed once by an admin and runs a `schedule` job (about every 15 minutes), since Granola sends no events.
  - Whether one member's key reads team-shared notes is not assumed.
- **A ticked folder means shared.**
  - The connection lists the member's Granola folders and they tick which to sync. A note in a ticked folder was deliberately sent, like forwarded mail (D67), and is shared with the workspace.
  - **A note outside the ticked folders is never fetched.** It does not exist in Spaces, privately or otherwise.
  - Moving a note out of a ticked folder, or deleting it in Granola (`deleted_at`), removes Spaces' copy.
- **What a synced note becomes:**
  - The enhanced note becomes **the meeting's write-up** when it has none. Otherwise it is added as a second shared note on the meeting ("Granola notes · <member>"). It is never a Review suggestion.
  - Action items are extracted by the Extract lane into **`task` suggestions** (`interaction-1`). Granola sends them only inside the summary.
  - The raw typed notes and the transcript are **opt-in per connection and private to the member**. The transcript is a document under the sensitivity gate. A recording, when a provider has one, stays a link (D68).
  - `web_url` becomes "Open in Granola". The meeting's linked records follow the attendees, plus the matched company's open deal (D49).
- **Typeface.** A note a person filed from their tool is set in **serif with a "via <tool>" mark**: the person reviewed it and chose to file it. An unchosen AI text stays sans: Exa's brief, an Ask answer, a summary nobody filed.
- **Meeting notes also appear on the record's Notes tab** under a "From meetings" filter (D74). Their home is still the meeting in Interactions.
- **One contract for every recorder.** Fathom, tl;dv and Google Meet's Gemini notes (through Drive) use the same folder-or-equivalent share choice and the same landing rules. They differ only in transport: webhook or schedule.
- **Amends D68:**
  - A provider summary is no longer a note suggestion.
  - The `notesAreMine` switch becomes the folder choice.
  - "Recorder notes are private to the person" now applies only to the opt-in raw notes and the transcript.

_Rejected:_

- Syncing every note privately and sharing per meeting inside Spaces (it fetches what the person never chose to send).
- A provider summary as a Review card for every meeting (noise).
- Auto-filling the shared write-up with private notes (D68's contradiction).
- A workspace-level Granola connection (keys are per member).
- Waiting for a push integration Granola has not built for self-hosted targets.

_Carried by_ `arrival-6`/`arrival-7` rewritten as the recorder contract with a `schedule` transport and the folder list, the key-based personal connection in Connections, and the "From meetings" filter on the Notes tab.

### D68-meetings — amended

**Where does someone see next week's meetings, or the ones nobody wrote up?** D68 gave meetings no page: Today's section (one day at a time) and a record's Interactions tab. Answered (owner, 2026-10-09): **a Meetings list page, in a collapsible Library group.** A meeting is still an activity, never a record.

- **Sidebar:** Today, Tasks and Spaces stay top-level.
- **Library ▾ is a collapsible group** like Objects and Capital. It holds Notes (G N), Meetings (G E) and Files (G L, kept from Documents), each its own page, and collapses to "Library ▸ 3". `G M` (Mandate) and `G F` (Portfolio) are taken, so the keys first drawn were changed (2026-10-09).
- **Documents is renamed Files** to match the record tab (D74).
- **Email stays on records** and gets no sidebar row.
- This amends sidebar A: rows are grouped, and none is removed.

- **Upcoming:** this week and next, grouped by day. A row shows the time, the title, the people with their RSVP mark, the linked records, and **Prep**.
- **Past:** newest first, with the write-up state on each row. Meetings with **no write-up** sort first and carry a **Write** button. A cancelled meeting stays, struck out.
- **Filter row:** All · Upcoming · Past · No write-up · Mine.
- A row opens the same meeting window.
- No count on the sidebar row: counts appear only on Tasks.
- No schema; the page is a read over `interaction` rows of kind `meeting`.
- **Today's section** stays one day with ‹ › and gains an "all meetings ›" link.

_Rejected:_

- Separate top-level rows for Notes, Meetings and Documents (six rows in the Work group).
- One merged Library page with tabs (the owner kept separate pages).
- A week strip inside Today (no home for "no write-up").
- A calendar grid (Spaces does not edit events; the list answers both questions).
- A meeting record page (D68 stands).

_Carried by_ the Today slice for meetings, extended with the list route, on the canvas as Meetings + Granola sheet 02.

### D79-today-is-the-one-attention-surface

**Where does "something needs you" live, now that tasks, deals, marks, Review cards (Exa, enrichment conflicts, Ask, recorder tasks), meetings with no write-up and broken connections all produce it?** Answered (owner, 2026-10-09): **Today is the one place that gathers them.** Each source keeps its own page; Today ranks them.

- **Head:** a plain "Today" title with the date (`Thu 10-09 · W41`). The proposed serif headline sentence (T2, Q7) is **not** adopted.
- **Day strip (T2, Q8, adopted):** a thin band of today's hours under the head. The past is dithered, meetings are ink blocks with their names, and now is a pine dot.
- **Readouts:** derived figures only, never section counts (Overdue, Deals past stage median, Oldest mark, Unfiled files).
- **Notices:** one band above the list, for things that stop the machine rather than the person: an enrichment limit reached (D76), a connection that needs reconnecting, a degraded plugin. One line each, with a link to fix it.
- **Needs you (T2, Q9, adopted and widened):**
  - One ledger sorted by urgency, with a kind lane: task, meeting, review, deal, mark.
  - Review rows are grouped by source and space ("Proptech / Property ops · via Exa · 3 to add · 1 to file").
  - A meeting with no write-up is a row with **Write** (D68 amended).
  - Tabs in the head filter by kind; the list folds at eight with "show all ›" and ends in "Add a task…".
- **Meetings:** today only, with ‹ today › and a now-rule, Prep on upcoming meetings, and "all meetings ›" to the Meetings page.
- **Right column:**
  - **Portfolio** (invested, value, MOIC, unpriced holdings).
  - **What's moving:** dated events on your companies from the last 7 days (watches, Exa, enrichment, D72/D76/D77).
  - The team's 24-hour activity ledger moves behind "team activity ›".

_Rejected:_

- The serif headline step.
- Separate sections per kind.
- Review apart from the list.
- Portfolio with the 24h ledger in the rail.

_Carried by_ the Today slice (`today.tsx`), rewritten from T2 and Today sheet 00 on the canvas.

_Amended 2026-10-25 (the canvas port):_

- **The head is the title and the day** (`Thu 15 Oct · W42`, the app's date forms), with no verbs. `T` and `L` stay bound.
- **The day strip shows only with a connected calendar**, and follows the day the Meetings section is on.
- **The order is Notices, Needs you, Meetings**; the rail is unchanged.
- **The readout strip shows non-zero figures only**, and is absent when all are zero. Each figure filters Needs you to its rows; a second click clears it. Unfiled files stays a link to the Files shelf.
- **Proposals are decided in place.** A single suggestion is its own row with its accept and dismiss; a group (a watch, a column run, an Ask thread) folds with `Open in Review ›`, and a column run keeps `Accept all N` beside it.
- **Duplicates appear on Today**, as Needs-you rows.
- **The filter is a Segmented** (All · Tasks · Review · Meetings · Deals · Marks, with counts, a kind at 0 absent), and the title carries no count. This replaces "tabs in the head".
- **Undo holds the write.** Accept, dismiss and an Ask card's apply or skip hide the row and hold the write for 5s behind a toast whose `Undo` is sans and underlined; the write commits when the hold ends, so an undone decision never reaches the server.

_Carried by_ project 30's Today slices and its undo slice.

### D80-first-run-without-a-checklist

**How does a self-hosted workspace learn to work, when most of the value sits behind keys the owner must bring (AI model, Google, Granola, Apollo, Exa)?** Answered (owner, 2026-10-09): **no setup checklist.** A missing piece shows only where it would be used, and the whole picture lives in one passive list.

- **After the admin account**, demo data is offered with **Start empty** as the primary button. It can be removed later in one step.
- **Today's empty state is the onboarding.** In an empty workspace Today offers three ways in: **Import a file** (CSV or Airtable export), **Drop a deck**, **Add a company**. It disappears once data exists. There is nothing to tick or dismiss.
- **Each feature names what it needs, in place:**
  - Ask with no model: "Ask needs a model to answer" with **Add a model ›** (a key, or Ollama on this machine).
  - **Find companies** with no Exa: a popover with **Add an Exa key ›**.
  - Today's Meetings with no calendar: **Connect Google ›**.
  - Enrich works with the free Website source and shows **More sources ›**.
  - A member sees who to ask instead of a setup link.
- **Settings → General → What's set up:** one passive list (AI model, Team, Enrichment, Email forwarding, Google, Granola, Exa). Each item shows whether it is set up, the one line it unlocks, and a link. It is never shown unprompted.
- **What works with zero keys:** records, spaces, deals, tasks, notes, portfolio, CSV and Airtable import, file upload and word search. The Website source reads a site's own description, logo and links without AI. Deck reading, Ask, Prep and meaning search need a model, and a local Ollama counts.
- **Amended 2026-10-11 (owner, reconciling with D76):** the Website source has two halves. The **markup half runs with no model** — the page title, the meta description, the favicon or `og:image` as the logo, the social links in the markup — so a fresh install's Enrich always answers something and the head never reads "needs a model". The **model half** (what they do, location, team size, founded, the longer description, read from the home and about page text) runs only when a route to the Extract lane exists, local or cloud under the sensitivity gate. SPA-309 built the model half alone; `sweep-12` (SPA-345) adds the markup half and the copy. D76's "read by the owner's own Extract lane" is amended to say the same.

_Rejected:_

- A setup checklist on Today (it nags and front-loads setup before need).
- A welcome page.
- Setup only in Settings, with no in-place cue.
- Demo data as the default.

_Carried by_ a first-run slice (Today's empty state, the in-place prompts, the What's set up list), on the canvas as Today sheet 01.

### D81-settings-by-whose-it-is

**How is Settings organised, and how do its pages behave, now that it holds personal connections, workspace policy, AI routing and plugins side by side?** Answered (owner, 2026-10-08 for the map, 2026-10-09 for the behaviours): **Settings is grouped by whose it is, and every page behaves the same way.**

- **The map (adopted as drawn):** Settings takes over the sidebar, with ‹ and esc to go back.
  - **You:** Email & calendar, Files, Meeting notes, API tokens. Accounts are grouped by the job they do, not by provider (amended 2026-10-09).
  - **Workspace:** General (with base currency, the workspace logo and What's set up, D80), Members, Objects, Templates, Currency & FX.
  - **AI:** Models (providers and routing), Search (embeddings), Usage & limits (usage and caps).
  - **Integrations:** Plugins, Enrichment (D76), Email forwarding (was Arrival), Connection apps (the OAuth clients, formerly part of Connections).
- **Saving:** toggles and selects apply at once, with a toast. Typed fields (names, hosts, keys) collect into one Save bar at the foot of the page, shown only while something has changed. No per-section Save buttons.
- **Default sensitivity:** `sensitivity_default` gets a control at the top of AI → Models ("Treat every record as: Normal / Sensitive"). It is a floor: it can only raise a record's sensitivity, never lower it. Set to Sensitive, every call routes to the local lanes.
- **Search reuses the Models key:** when Models holds a key for the chosen embedding provider, Search uses it and says so, with "Use a different key" to override. A provider with no embeddings (Anthropic) still asks.
- **Your accounts are grouped by job:**
  - **Email & calendar:** connected Google and Microsoft accounts. Each has a Default mark (the one Spaces sends from), its sync state and **Options ›** (which calendars, which labels to skip). The workspace's Bcc forwarding address sits below, read-only, linking to Email forwarding.
  - **Files:** storage accounts, several allowed (Google Drive, Box, Dropbox, OneDrive). Which folder belongs to which space stays on the space.
  - **Meeting notes:** recorders such as Granola, with their folders and private extras (D78).
  - Underneath, connections stay **one per provider product** (D66); a page groups them by account. Connecting Drive from Files after Gmail asks Google only for the extra scope, so the same Google account appears on both pages. Disconnect stops that product only; Google's revoke is called when the account's last product is disconnected.
  - Providers mix freely: Box for files beside Google for mail and calendar.
  - A provider whose plugin is not installed shows **Install ›** to an admin and "Ask an admin" to a member.
- **Every plugin and every account has its own page.**
  - A plugin page (Integrations → Plugins → <name>) follows one template: status and version, the workspace key, what it sends, its manifest settings, what it switches on (linking to the page that owns each capability, never repeating its settings), recent runs and errors, Disable / Uninstall.
  - An account page (Options ›) holds the per-person choices, last sync and Disconnect.
- **The Plugins page is a catalogue:** Installed as a ledger, then Available from the registry, grouped by job: Enrichment, Research, Email & calendar, Files, Meeting notes, Import, Feeds. It stays named "Plugins", the word the SDK uses.
- **Confirms** on four actions that break something outside the page: revoking an API token, suspending a member, archiving an object and unticking an identity key. Each names the consequence. Reversible toggles stay instant.
- **Members see admin pages read-only:** the same page with the controls disabled, keys redacted, and "Only admins can change this · ask <admin>". This replaces the five "Admins only" pages.
- **No footer caption strips.** A line survives only where it concerns cost, privacy or irreversibility, and it sits next to its control (invariant-line test).
- **Search owns the embed lane:** the Models routing grid drops its Embed row and shows one line, "Embeddings · <model> · set in Search ›".

_Rejected:_

- Keeping the old flat list.
- One Save for everything, including toggles.
- Per-section saves.
- One Connections row per provider with a tick per product (it hid what each account is for).
- Renaming Plugins to Apps.
- An undo toast instead of confirms (a revoked token has already failed a call).
- Hiding admin pages from members.
- Keeping the Embed row in both places.

_Carried by_ the settings slices (nav and IA, then each page), on the canvas as Settings sheets 00–09 (05 and 07 redrawn for the accounts and the catalogue).

_Amended 2026-10-25 (the canvas port):_

- **The nav's group heads are ruled ink bands**: YOU · WORKSPACE · AI · INTEGRATIONS in mono caps in ink with a hairline under, the grammar the settings ledgers' heads use; no graphite whisper.
- **Integrations = Connections · Plugins · Enrichment · Email forwarding.** Connection apps folds into Connections. The owner's verdict of 2026-10-24: a connection is a provider whose admin-registered OAuth app serves a core job (Google, Box, Microsoft later), never installed; everything else, recorders included, is a plugin. A provider is a page with Set up and In use tabs: the first Set up row asks whether the accounts are on Google Workspace or personal Gmail, sync health per use lives on In use, there is no Gmail plugin page, and a reconnect is a Today line. Whether the bundled providers are plugin code shipped in the image or core is the owner's call, recorded against D51 by project 30's Connections slice.
- **The workspace head opens General · Members · Invite.**
- **Members gains `Send a reset link…`**: an admin issues a one-time reset link, since there is no self-serve reset.
- A settings page head carries one outline 32px action at most beside its `···`.

_Carried by_ project 30's shell, settings and Connections slices.

### D70-find-and-ask — amended (where Ask lives)

**Where does Ask answer, now that the palette both finds and answers?** Answered (owner, 2026-10-08): **⌘K only finds; Ask is a docked panel and a page.**

- **The palette's answer stage is removed.** ⌘K finds and goes. Tab, or ⌘J from anywhere, hands the typed query to Ask.
- **Ask is a docked third column** (408px) beside the page, and a full **`/ask`** page. Both read one thread store.
- **`/ask`** lists threads by day, each row with its scope and its outcome. A thread opened there offers **Open beside <record>** to continue it docked on that record.
- **Context:**
  - The page you are on is the default scope.
  - Scope chips gain **views** and **files**, beside page, record, space, person and web.
  - What a turn read is frozen with that turn; a later change of scope prints a line in the thread.
- **Turn states** add stopped, refused (no local model for a sensitive scope), no provider, connection lost and empty.
- **Action cards** left undecided wait in Review.
- **Lost access:** when the asker can no longer read a source an answer cited, the answer is hidden and a line says so.
- **Answers are set in sans.** Serif stays for what a person wrote or chose to file (D78).

_Rejected:_

- Answers inside the palette (two homes for one thread).
- A thread store per surface.
- Keeping an answer visible after its source was lost.

- **Layout (owner, 2026-10-09):**
  - **The docked panel closes and resizes.** ⌘J or its × closes it completely, leaving no rail; the sidebar's Ask row or ⌘J reopens it. The thread survives closing. Dragging its left edge sets the width between 360px and about 560px, and the width and open state are remembered per browser.
  - **`/ask` is wider.** The thread reads in a 760px column, and the thread list collapses from its head ("Threads" brings it back). Tables, such as Find results or a query's rows, break out to the full content width. In the docked panel they scroll sideways inside their card, with "Open in /ask ›".
  - **Your turn on the right, the answer on the left.** Your message is a bone block with a hairline, right-aligned, at most three quarters of the column, with its time under it. The answer has no box: it sits on paper at full measure, with a foot naming the model and the sources. A change of scope is a centred mono divider across the full width, not a message.

_Rejected (layout):_

- Chat bubbles on both sides (the answer is a printed reading, and tables and cards need the width).
- A thin collapsed rail for the panel (a closed panel takes no room).
- A fixed-width panel.

_Carried by_ `ask-5` and `ask-7` amended, on the canvas as Ask — printed, sheets 00–09 (07–09 the layout), and Shell — printed, sheet 01.

_Amended 2026-10-25 (the canvas port):_

- **Cmd-K is one fixed size**, `min(1060px, 100vw−2rem)` × `min(560px, 100dvh−4rem)`. Results scroll inside it, and every state — empty, typing, no results, loading — renders in the same box; it shrinks only with the screen.
- **The preview pane is always mounted.** With nothing previewable highlighted it is blank bone. This supersedes "Nothing highlighted, the list runs full width": a list that changes width under the cursor is the jump the fixed size exists to stop.
- **Ask's scope chips sit in the composer**, not in a head above the thread.
- **Ask moves to the sidebar foot** (`⌘J`), a row above the account row in both sidebar states, rather than a row under Search.

_Carried by_ project 30's Cmd-K, Ask and shell slices.

### D73-spaces-are-malleable and D74-record-body-is-tabbed — amended (the space page)

**What does a space's own page look like, now that a record's body is tabbed?** Answered (owner, 2026-10-08): **a space reads like a record.**

- **Head:** a `SPACE depth n` stamp, the serif name with its crumb, a **Not sensitive / Sensitive** toggle, **Note here** (`N`) as the one button, and `···` holding Rename, New subspace, Move to…, Save as template… and Archive.
- **Readouts:** three, because the tabs carry the counts. In pipeline (`3 of 14`), last filed, and the funding-stage mix as a bar, which is the page's one dither.
- **Details column:** Map (parent, subspaces with their counts, `+ Subspace`), Glossary, Tasks.
- **Tabs:** Companies · Notes · Files · People · Records, each with its count; empty tabs grey; **Notes is the default**, as on a record.
  - Referenced is no longer a section: it folds into Notes as a filter (Filed · Mentions).
  - Companies filters All · In pipeline · Watching, sorts by funding stage, and shows a row's select box on hover (for split) and `×` to untag.
- **Rename is in place** on the title. Links, filings and watches point at the space, so nothing else changes.
- **Move to…** is a window over the scrim listing the tree, with the space and its descendants greyed and the parent marked "now here".
- **Archive asks nothing**, because Restore undoes it. The archived head shows an outline stamp and a notice saying it is out of the tree and the picker, its filings stay, and its watches are paused.
- **Save as template…** sits in the menu; what a space template holds is not yet decided.

_Rejected:_

- The five stacked sections of 2026-09-16.
- Eight readouts that repeat the tab counts.
- A confirm before archive.
- A last-filed lane in the details column (skipped by the owner).

_Carried by_ `spaces-1` amended and `spaces-4`, on the canvas as Spaces — printed, sheets 00–04.

_Amended 2026-10-25 (the canvas port):_

- **The space head is `···` only.** Note here, the Sensitive toggle and Add watch leave it. The stamp reads `SPACE` and prints no depth.
- **Overview is the default tab**, first in Overview · Companies · Notes · Files · People · Records, and holds the three readouts, What's moving, open tasks and the latest companies. Notes is no longer the default, and the readouts leave the head.
- **The rail is Criteria, Watching and Map.** Glossary leaves it for `Glossary…` in the `···`; Tasks leave it for Overview; Watching's `+` replaces the Add watch button.
- **Sensitive moves to the `···`**, as a switch.
- The `···` reads Find companies · Rename · Move to… · Split into a subspace… (was New subspace) · Save as template… · Glossary… · Sensitive, then Archive below a rule.
- The Companies tab's filter is a bounded Segmented (All · In pipeline · Watching, with counts).

_Carried by_ project 30's record-head and space slices.
