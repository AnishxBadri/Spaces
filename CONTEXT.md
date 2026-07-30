# DealOS — context

Placeholder name. Rename before first public commit. Candidates: Angle, Tessera, Thesis, Dealbase.

## What this is

Open-source, **self-hosted** deal management OS for **angel and private capital investing**.
Think TagHash / Affinity, but you run it, you own the data, and every AI or data provider
is BYOK (bring your own key).

Not a horizontal CRM. Opinionated for investors. That constraint is the product.

## Who runs it

**Design target is one investor.** Must not preclude 1–15 users on one deployment later.
Two different funds run two containers. No multi-tenancy — one deployment, one shared dataset.

Practically: build single-user UI, but carry `author_id` / `owner_id` / `visibility` on every
row that could ever be personal, from the first migration. See *Single user first, team ready*.

## Non-goals

- No hosted SaaS. Author never touches user data.
- No multi-tenant isolation.
- No no-code object builder (custom *attributes* yes, custom *objects* no).
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

## Stack

One language, TypeScript, one codebase. Two processes (web, worker), two containers (app, db).

| Layer | Choice |
|---|---|
| Framework | **TanStack Start** (TanStack Router + Vite + Nitro), React 19 |
| DB | Postgres 17 + Drizzle |
| Extensions | `pgvector`, `pg_trgm`, `ltree`, `unaccent` |
| Data layer | TanStack Query + Start server functions — one model everywhere |
| Jobs | pg-boss, Postgres-backed, separate Node process |
| Auth | Better Auth (`tanstackStartCookies` plugin, Postgres adapter) |
| Editor | **BlockNote** (ProseMirror/TipTap-based), Notion-grade block UX; JSON authoritative, markdown derived |
| Grid | TanStack Table + TanStack Virtual, DOM-based |
| UI | shadcn/ui + Tailwind + Radix, `cmdk` for Cmd-K |
| LLM | Vercel AI SDK, BYOK |
| Blobs | local filesystem default, S3 opt-in |
| Validation | Zod + drizzle-zod |
| Tests | Vitest + Playwright |
| Tooling | pnpm, single app, no monorepo |

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
  serializable state. Saved views *are* serialized filter/sort/group-by/column state. Near-free
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

- **A Rust/Go backend service.** Wealthfolio has Rust because Tauri desktop apps *must* — the
  Axum server reuses crates written for the desktop shell. That's the consequence of a
  constraint we don't have. For 1–15 users the bottleneck is Postgres, Gmail, and LLM calls;
  Node is idle in all three. A second language halves the contributor pool, kills end-to-end
  types, splits migration ownership, and forces reimplementing unpdf/mammoth/sheetjs/TipTap.
  The real concern — CPU-bound extraction and embedding blocking the event loop — is solved by
  splitting the *process*, not the language. If one job ever truly needs native speed, sidecar
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
- **Separate vector DB, Elasticsearch, Redis, Trigger.dev, Turborepo** — Postgres and one app
  cover all of it at this scale.
- **MinIO in default compose** — see storage below.

### Notes on specific picks

- **Note storage (amended 2026-07 with the BlockNote switch).** `note.body_json` (BlockNote
  document) is authoritative — BlockNote's markdown export is lossy, so round-tripping through
  markdown would corrupt notes progressively. `note.body_md` is *derived* on every save and
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

- **Research half (PKM-shaped):** spaces, theses, notes, sources, glossary. Slow, exploratory,
  no pipeline, no stages.
- **Deal half (CRM-shaped):** companies, pipeline lists, entries, activity. Fast, structured.

Most tools do one well and fake the other. **The seam is the product:** a company landing in
pre-lead already carries six months of notes on its subspace, the saved sources, and the
contacts you met there.

### Polymorphic core

Everything linkable is an entity. One mention system, one backlink query, one search index,
one attach mechanism.

```
entity(id, kind: company|person|organization|space|thesis|note|document)

link(from_entity_id, to_entity_id, relation, source: manual|ai|extracted,
     created_by, created_at)
  relation: mentions | tagged_in | evidence_for | evidence_against
          | contact_at | derived_from | supersedes
```

Real FKs on both sides. Typing `[[Orbital Composites]]` in a note materializes a `link` row —
backlinks fall out for free.

Kinds are fixed in code. This is not a custom-object builder (see non-goals).

Rejected: nullable-FK-per-type (N columns and N joins per attach point), and untyped
`(src_type, src_id)` (no referential integrity, every query hand-checks).

**Note the reinterpretation:** `document.entity_id` is now the document's *own* identity, not
the company it belongs to. Attachment goes through `link`. Same for `note`.

### Per-kind side tables

```
company(entity_id, domain, cin, founded, sector[], stage, geo)
person(entity_id, emails[], linkedin)
space(entity_id, parent_id, slug, name, path, is_seeded)
thesis(entity_id, claim, conviction, status: forming|active|parked|killed,
       opened_at, closed_at, closed_reason, owner_id)
note(entity_id, title, body_md, kind: note|memo|scratch, author_id, visibility)
document(entity_id, blob_sha, filename, mime, url,
         kind: deck|memo|dd|cap_table|legal|article,
         origin: upload|gmail_attachment|url|clip,
         extracted_text, tsv, uploaded_by)
document_chunk(document_id, idx, text, embedding vector)
term(entity_id, name, aliases[], definition_md, space_id)
```

### Space vs thesis — do not merge these

**Space is taxonomy.** Aerospace → In-space manufacturing. Hierarchical, shared vocabulary,
stable for years, effectively never deleted.

**Thesis is a claim you hold.** "In-space manufacturing is investible once launch drops below
$1000/kg." Has conviction, status, an open date, and evidence on both sides. Theses die often,
and a dead thesis with its reasoning intact is worth more than a deleted one.

Kept separate because: theses die and taxonomy doesn't; one thesis spans several spaces
(defence × autonomy); and recording "wrong, killed Mar 2026" on a taxonomy node corrupts
the tree for everyone.

```
thesis_space(thesis_entity_id, space_entity_id)     -- many-to-many
```

Companies attach to a thesis via `link(relation: evidence_for | evidence_against)`.
Evidence-against is the differentiator — no generic CRM records disconfirmation.

### Space membership is orthogonal to pipeline membership

```
entity_space(entity_id, space_id, source: manual|ai|inherited, confidence, created_by)
```

A company is tagged Aerospace whether or not it sits in any pipeline. **Tags outlive pipelines** —
route them through `list_entry` and the tag dies when the deal dies. A company may sit in a
space and no pipeline at all: *tracking, not evaluating.* That is a first-class state.

AI-suggested tags land as `source: ai` in a review queue, never silently written. Same
provenance rule as enrichment.

### Spaces vs attributes — the classification boundary (decided 2026-07)

Two dimensions that must never share a field:

- **Markets — *where* a company operates** (Aerospace → In-space Manufacturing). Hierarchical,
  researchable. **Spaces own this exclusively** — industry/sector never becomes an attribute.
  The companies table shows a graph-backed Spaces column, not a sectors field.
- **Characterizations — *what kind of business* it is** (B2B/B2C, hardware, capital
  intensity, GTM motion). Orthogonal facets that cut across every market. **These are
  attributes** — flat, filterable, no research attached.

**The litmus test:** "Could I write a memo about it and track companies in it?" → space.
"Is it a property of the business itself, true in any market?" → attribute.

Seeded facet: one system multi-select on Company — `Business model`
(B2B · B2C · B2B2C · Marketplace · Hardware · Deep tech · Services), options editable.
No "sectors"/"categories" attribute ships, ever — that's the drift vector Attio's
Categories demonstrates.

**Extensibility doctrine: structure fixed, content free, defaults curated.** Object kinds,
the attribute type menu, identity rules, and the engine's shape are code. The space tree,
custom attributes, and every seeded attribute's options are the user's vocabulary. The
litmus test lives in docs and seed data as guidance — never enforced by validation.

### Seed taxonomy

Ship ~150–250 curated nodes, versioned. NAICS/SIC rejected — useless for deeptech and tech.
`is_seeded` flag so upgrades can add nodes without stomping user edits. Users fork and extend
freely; custom nodes sit alongside seeded ones with no second-class treatment.

### Glossary

Scoped to a space — "stage" means different things in aerospace and bio. Terms auto-link in any
note body (Aho-Corasick over the term set at render time), hover shows the definition. Cheap to
build, disproportionate payoff for someone learning a new space.

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
- Parked (`parked`): Early — revisit  *(nurture pool: "come back at seed"; not terminal,
  not active — without it people abuse Rejected and lose warm relationships)*
- Terminal (`closed`): Invested · Passed (our no) · Lost (their no / missed allocation —
  a different post-mortem lesson than Passed)

Terminal deals close, never delete — same death-is-information principle as theses.

Deal system attributes: stage (status), value (currency), company (record-reference),
people (record-reference), owner (actor-reference), close date. Custom attributes via the
attribute engine like every object.

### Attribute engine (decided 2026-07)

The object model: **Companies, People, Deals** are objects with an attribute registry —
system attributes we ship, custom attributes users add. Notes, spaces, theses, terms are
deliberately *not* object-modeled; they're the research layer that links in.

```
attribute(id, object_kind: company|person|deal, slug, name, type,
          options jsonb, is_system, archived, sort_order)
```

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
  Outbound · Event).
- Enrichment-fed fields (employee range, ARR, funding raised) deliberately absent — empty
  boxes without a provider; they arrive with the enrichment integration as
  provenance-tracked attributes.

### Attribute change history (decided 2026-07)

```
attribute_event(id, entity_id, attr_slug, from jsonb, to jsonb, actor_id, at)
```

One row per attribute change, same transaction as the value write. Restores what
`list_entry_event` provided: deal stage history is `attr_slug = 'stage'`; time-in-stage
analytics fall out free. `activity` carries macro verbs only (created, merged, tagged,
note-created) — no "updated" noise rows. **Condensing is read-time display:** group
events by actor + record within a ~10-minute burst → "changed 8 attributes", expandable
to the attr/value table. No write-side session tracking.

### Lists — deferred

The Attio list/entry primitive (`list`, `list_attribute`, `list_entry`, `list_entry_event`)
stays in the schema but is **not the deal mechanism** and is deferred from MVP. If
watchlists/portfolio views later need membership-with-context, lists are there; deals no
longer wait on a list engine, and kanban falls out of the Deal stage attribute.

### Interactions and enrichment

```
interaction(id, kind: email|meeting|call, message_id, thread_id, occurred_at)
interaction_entity(interaction_id, entity_id)       -- relationship graph edge table
signal(entity_id, source, payload jsonb, observed_at)
enrichment_record(entity_id, provider, raw jsonb, fetched_at, credits_used)
```

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
five tables at query time. `list_entry_event` stays alongside it as the typed attribute-change
log that feeds stage analytics.

### Entity resolution & merge

**Doctrine: deterministic auto, probabilistic suggest.** Identity comes only from
deterministic keys — domain, email, LinkedIn URL, CIN. Exact key match auto-attaches. Fuzzy
name match **suggests, never merges** — no threshold is safe ("Stripe" payments vs "Stripe"
design agency corrupts silently). Fuzzy feeds a dedupe inbox; a human clicks.

```
entity(id, kind, canonical_name, merged_into_id → entity, source, created_by, created_at)

entity_alias(id, entity_id, kind: name|domain|email|linkedin|cin,
             value, value_norm, is_identity bool, source: manual|gmail|apollo|import|merge)
  -- UNIQUE partial index on (kind, value_norm) WHERE is_identity
  -- name aliases: never identity, never unique

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
- Email → lowercase exact. Gmail-only dot/+tag stripping *for matching*; store original.
  Role prefixes (info@, hello@, team@, careers@) are never person-identity.
- Name → unaccent, lowercase, strip legal suffixes (Inc, Ltd, Pvt Ltd, LLC, GmbH, SAS…).
  Feeds `pg_trgm` only.

**One choke point.** `resolveEntity({kind, keys, name?, source})` — every creator goes
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

1. Loser's referencing rows (link, interaction_entity, entity_space, list_entry, …)
   repoint to winner; every moved row recorded in `merge_event.snapshot` as
   `{table, pk, old_value}`.
2. Loser's aliases move to winner (`source: merge`), identity flags intact.
3. Side-table fields: winner keeps its values, loser fills winner's nulls, conflicts stay
   with winner but land in snapshot. Same never-overwrite rule as enrichment.
4. `list_entry` collision (both in same list): keep winner's entry, snapshot loser's values
   and entry events. One entry per (list, entity).
5. Loser row survives with `merged_into_id = winner` — stale URLs redirect. Chains flatten
   at write: merging B into C updates every `merged_into_id` pointing at B.
6. Duplicate `link` rows (same from/to/relation) dedupe on repoint.

**Unmerge** = clear `merged_into_id`, replay snapshot backwards. Documented limit: data
created *after* the merge stays with winner — attribution is unknowable. Snapshot machinery
ships in v1 (cheap at merge time, impossible to retrofit); unmerge UI can land later.

Any member can merge — two-person fund, no ceremony. Every merge writes `activity` +
`merge_event`. Merge UI previews what moves before confirm.

**Fuzzy sweep:** `pg_trgm` similarity over name aliases, at-create check + nightly sweep
job. Exact normalized-name collision outranks trigram score. Both only feed the inbox.

### Sources are documents

No separate `source` table for URLs. A saved article is a `document` with `origin: url`, fetched
and readability-extracted into the same `extracted_text` / `tsv` / `document_chunk` pipeline.
One search box covers decks, emails, notes, and saved articles together. Two tables means two
search indexes, and you will ship one and forget the other.

### Investor-specific surfaces Attio does not have

- Space page: notes + sources + tracked companies + contacts + child spaces
- Thesis page: claim + conviction + evidence for/against + linked spaces
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
- **Spaces, theses, terms, taxonomy are global.** Never per-user. Shared vocabulary is the point;
  a per-user taxonomy is two people building two ontologies of the same market.
- Thesis has an `owner_id` but is visible to all. Someone holds the claim; everyone can see it.

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
- Optional TOTP 2FA. This DB holds deal terms and cap tables.

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

### Enrichment

```ts
interface Enricher {
  id: 'apollo' | 'pdl' | 'crunchbase' | 'hunter'
  enrichCompany(input: {domain?, name?}): Promise<EnrichResult>
  enrichPerson(input: {email?, linkedin?, name?, domain?}): Promise<EnrichResult>
  estimateCost(n: number): {credits: number}
}
```

Ship Apollo first; the interface makes PDL/Crunchbase/Harmonic community PRs.

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

```ts
interface Storage {
  put(key, stream, meta): Promise<void>
  getDownloadUrl(key, ttl): Promise<string>   // presigned (s3) | signed app route (local)
  getUploadUrl(key, ttl): Promise<string>
  delete(key): Promise<void>
}
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
- PDF -> `unpdf`/pdfjs · DOCX -> `mammoth` · PPTX -> unzip + slide XML (do this one properly,
  decks matter most) · XLSX -> `sheetjs` (cap tables, MIS)
- Scanned/image PDF -> **BYOK vision model**. No Tesseract container. Key absent -> "text not extractable".

Documents hang off entities, not folders. Folders are the thing being replaced.

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

- **Views over data:** table + kanban (group by any select attribute), saved and shared, per list.
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
  there, *then* organize. Demo-data seed for anyone who skips Gmail.

---

# Hosting

Target: `docker compose up` works first try.

```yaml
services:
  app:   # Nitro node-server (web) + pg-boss worker, two processes, one image
  db:    # pgvector/pgvector:pg17
```

Two processes in one image, selected by entrypoint. Web must never run CPU-bound extraction or
embedding inline — those block the event loop and are the worker's job.

Rules that decide adoption:
- Migrations auto-run on boot. No `docker exec` step.
- Every env var optional except `DATABASE_URL` and `APP_URL`. `MASTER_KEY` auto-generated if absent.
- **No build-time env vars.** Vite bakes `VITE_*` at build time, so nothing client-visible may
  come from one — the browser gets runtime config from an endpoint or the root loader. Same trap
  as Next's `NEXT_PUBLIC_*`; a prebuilt image cannot be reconfigured at `docker run` otherwise.
- Prebuilt multi-arch image (arm64 matters) on GHCR + Docker Hub.
  Non-root UID 1000. Docs tell people to pin tags, not `latest`.
- First-run web wizard: admin -> optional AI key -> optional Gmail -> optional demo data.
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

Backup — three artifacts, one cron line, ship as `scripts/backup.sh`:
```bash
docker compose exec db pg_dump -U dealos dealos > dump.sql
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

---

# Hard parts, in order

1. **Entity resolution + merge semantics.** ~~Design this before the first migration~~ —
   **done, spec'd 2026-07, see *Entity resolution & merge* in the data model.** Doctrine:
   deterministic auto, probabilistic suggest. Repoint-at-write merge with snapshot. Still
   hard to *build well* (merge preview UI, dedupe inbox), but no longer blocks the schema.
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
7. Theses: claim, conviction, status, evidence for/against
8. Glossary with in-note auto-linking
9. Entity resolution: `resolveEntity()` choke point, aliases, dedupe inbox, merge + snapshot
10. BYOK AI: deal summary from attached material, memo draft, space tag suggestions

Then: **Gmail sync (forward-only)**, Apollo enrichment, signals, co-investor graph,
portfolio marks, Outlook.

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

Remaining phases, in order:
6. **Documents** — upload on records, storage layer wired to UI, extraction worker job
7. **Theses** — claim/conviction/status, evidence for & against, thesis section on spaces
8. **Search** — real Cmd-K over all entities + notes (tsvector), jump-to-record
9. **Glossary + seeds** — terms w/ in-note auto-linking, starter taxonomy, demo seed
10. **Auth completion** — invites, member management, /setup one-time token, optional TOTP
11. **Ship polish** — backup script, install docs, GHCR multi-arch images, upgrade CI

Then integrations (each independent): Google Calendar first, Gmail (forward-only),
Apollo enrichment, BYOK AI features.

Standing debt: dark theme, placeholder contrast (DESIGN.md floor), test-db harness,
note deletion.

## Open questions

- **Space page shape.** A space accumulates notes, sources, companies, contacts, child spaces,
  and theses. Is it one long page, or tabs like the record page? Leaning: one scrollable page
  with a memo at top — a space is something you *read*, not something you administer.
- **Does a thesis need its own attributes**, or is claim + conviction + status enough?
  Resist list-ifying it; a thesis is prose with structure, not a row.
- **Note vs memo vs document.** A memo is a long note that ends up as a PDF. Is that one object
  with an export, or two? Leaning one.
- **`values jsonb` indexing strategy** for kanban group-by, per the data model section.
