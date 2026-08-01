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

### Filed vs referenced (decided 2026-07)

Two ways a thing ends up "in" something else, and they must not be conflated — one is an act,
the other is a side effect of writing.

| | meaning | mechanism |
|---|---|---|
| **Filed in a space** | you deliberately put it there | `entity_space` |
| **Filed against a record** | a document belongs to this company/person/deal | `link(tagged_in)` |
| **Referenced** | the body happens to mention it | `link(mentions)`, diff-synced on save |

**Space membership goes through `entity_space` for every kind, not just companies** — notes,
documents, and people file the same way a company is tagged. `link` cannot express what that
table already carries: `source: manual|ai|inherited` and `confidence`, which is what lets AI
suggestions land in a review queue instead of being silently written. Routing notes through
`link(tagged_in)` instead would forfeit that and make "what is in this space" a two-table
question forever.

**There is no singular memo.** A space holds as many filed notes as the user wants; the memo
is simply the first one filed, and `note.kind = 'memo'` is presentation (serif, wide measure,
PDF export later), never structure. Spaces are how a user imposes hierarchy on their own
research — constraining that to one document per space is the tool telling the investor how
to think.

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

### Mandate — the fund's strategy, not another thesis (decided 2026-08)

A third thing shares the word "thesis" and must not merge with the other two. A thesis is
a falsifiable market claim that dies often. The **mandate** is the fund's *prescriptive*
strategy — deep-tech, pre-seed to seed, India, check size, portfolio construction — what
an LP reads in the deck. It evolves per vintage rather than being disproven. The mandate
cites theses; theses justify conviction; cramming one into the other list-ifies both.

```
mandate(id, status: active|archived, note_entity_id → note,
        stages text[], geos text[], check_min, check_max, currency)
```

- **The prose body is a real note** (`kind: memo`) — search, `[[mentions]]` of theses and
  spaces, and future AI-screening input all come free. No new entity kind.
- **Structured columns, deliberately few.** `stages` shares the company `funding_stage`
  option vocabulary; `geos` are free tags; check range. Typed columns, *not* the
  attribute engine — one row, a registry buys nothing.
- **Portfolio construction stays prose.** Nothing consumes "25 checks, 20% follow-on
  reserve" as data; promote only when a feature (reserve tracking, pacing) demands it.
- v1 structured fields mostly display. One real consumer: a soft **"outside mandate"
  hint** where `company.funding_stage ∉ mandate.stages` — a hint, never a block; edge
  cases are the job. Geo cannot power this while `location` is free text.
- One active mandate per workspace; `archived` covers vintages. No versioning machinery.
- **Nav: the Mandate page is the roof.** Structured facts + prose strategy up top, active
  theses beneath (claim, conviction, status), killed theses collapsed but present —
  death is information. The separate Theses tab goes away. Thesis object, thesis page,
  `thesis_space`, evidence model: all unchanged. Separation lives in the schema;
  coupling lives in the UI.

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

Two dimensions that must never share a field. **The litmus test is the rule, not a hint:**

- **Space — could I write a memo about it and track companies in it?** *Where* a company
  competes **and *how* it competes.** Hierarchical, researchable. **Spaces own this
  exclusively** — industry/sector never becomes an attribute. The companies table shows a
  graph-backed Spaces column, not a sectors field.
- **Attribute — is it a property of the business itself, true in any market?** B2B/B2C,
  hardware, capital intensity, GTM motion. Orthogonal facets. Flat, filterable, no research
  attached.

**Amended 2026-07:** the rule used to read *"markets are **where** a company operates"*,
which put competing approaches (Data centers → Cooling → Immersion) on the wrong side. You
would absolutely write a memo on immersion cooling and track companies in it, so it is a
space. The *where* framing also failed its own test — approaches cut across markets, since
immersion cooling is EV packs and mining rigs too.

**That cross-cutting is handled by tagging, not by the tree.** The hierarchy decides where a
memo *files*; it does not decide what a company *is*. `entity_space` is many-to-many, so a
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
- **Depth is earned.** Nobody creates *Immersion cooling* until they have companies and a
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

### Templates (decided 2026-08)

One mechanism, three kinds — standardized *capture*, never automation.

```
template(id, kind: note|space|record, object_kind,   -- object_kind only when kind=record
         name, body jsonb, suggest_on entity_kind[],
         created_by, archived, sort_order)
```

- **note** — a stored BlockNote document; instantiate = copy into a new note. Meeting
  note, call debrief, diligence checklist, IC memo skeleton.
- **space** — a scaffold manifest `{memo_body?, glossary_terms[], subspace_names[]}`,
  applied once at space creation. The investor builds their market-breakdown pattern
  once and stamps it per space.
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
  auto-creates. Contextual *defaults* (new deal auto-creates a checklist) were
  considered and rejected as the first step toward workflow-config sprawl.

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
- **`canWrite(entity, user)` from day one too (decided 2026-08).** v1 ships admin/member
  only, but every mutation routes through the choke point, so a read-only viewer role
  (LP, intern, advisor) later is a one-line change instead of a write-path audit.
  Retrofitting a role *column* is trivial; retrofitting *enforcement* is not.
- **Explicit workspace singleton (decided 2026-08).** One enforced row — name, logo,
  settings — anchoring the mandate, `credential(scope: workspace)`, and sidebar identity,
  which otherwise reference a ghost. Hard rule: **no other table ever grows a
  `workspace_id` FK.** The moment one appears, the no-multi-tenancy decision is being
  relitigated by accident.
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
  *remote* storage, which bundling does not provide.
- **Backup regresses.** Today: `tar czf blobs.tgz ./data` — plain files, restorable
  anywhere. Bundled store: an opaque data dir needing a compatible daemon. The product
  thesis is *you own your data*; this cuts against it.
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
  `x-amz-checksum-sha256` on the presigned PUT. **Unresearched:** whether R2, B2, and
  Garage all enforce it — research the day the driver is written, not before.
- **Workaround noted, with its caveat:** an operator can get S3 today by mounting it at
  `./data` with rclone/s3fs, since the local driver just writes to `dataDir()`. But
  `rename()` is not atomic on S3 and the local driver streams-then-renames, so that write
  pattern is not guaranteed safe. Fine for evaluation, not for a fund.

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
- PDF -> `unpdf`/pdfjs · DOCX -> `mammoth` · PPTX/XLSX -> `fflate` + OOXML XML directly
  (SheetJS was dropped — the shared unzip covers both, decks matter most). Macro/template
  variants (`.xlsm`/`.xltx`/`.docm`/`.pptm`) route to the same extractors.
- **Legacy Office (`.doc`/`.xls`) is unsupported** — binary OLE, no extractor. Common in
  Indian deal flow; known gap, lands `extraction_status: unsupported`.
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
- First-run web wizard: admin + workspace name -> optional AI key -> optional Gmail -> optional demo data.
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
  object URL whose type *we* choose, Office via the worker's already-extracted text (a
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
  phase 7 where space pages actually want *sources*; chunking + embeddings wait on BYOK; the
  S3 driver still throws.

**Theses (phase 7): done, 2026-07.** Claim/conviction/status, evidence on both sides,
claims on the space page. No migration needed — `thesis`, `thesis_space`, and the
`evidence_for`/`evidence_against` relations were already in the schema. Decisions:
- **Evidence is open to any entity kind, not just companies.** Disconfirmation is usually
  an article or a teardown note, so companies-only would have gutted the against column.
- **One entity, one side.** Attaching a company to the side it isn't already on moves it;
  the opposite row is deleted in the same transaction. Moving a company from *for* to
  *against* is the most informative edit there is and must not leave both rows behind.
- **Killing requires a reason, enforced server-side.** The status change is refused without
  one, and the reasoning gets the loudest block on the page. Reopening clears the closure;
  `activity` keeps the trail either way.
- **No attribute registry on theses.** Claim, conviction, status and evidence is the whole
  shape — list-ifying it is the failure mode.
- Claim is truncated into `entity.canonical_name` so search, mentions, and Cmd-K work; the
  full claim lives on the side table.

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
Shipped: the token/primitive layer (see *UI craft debt* below), **one shared record table
behind Companies/People/Deals** (three copies collapsed; the table is the hardest UI in
the project and now has one implementation to be good at), per-option badge colours
(auto-assigned, overridable in settings), and in-browser document preview (see the phase 6
notes — the download hardening survives it). Verified by driving the real app, which is
what caught a colour picker that didn't close on selection, a sticky-column hover seam,
and mouse-only column resizing. Remaining craft work is itemised in *UI craft debt*.

Remaining phases, in order:
10. **Auth completion** — workspace singleton row, invites, member management,
    `canWrite()` choke point, /setup one-time token, optional TOTP
11. **Ship polish** — backup script, install docs, GHCR multi-arch images, upgrade CI

Then the 2026-08 product decisions — **mandate page** (the roof over theses) and
**templates** — specs in the data model; then integrations (each independent):
Google Calendar first, Gmail (forward-only), Apollo enrichment (Exa alongside as a
second `Enricher`), BYOK AI features.

Standing debt:
- **Test-db harness.** The suite shares the *dev* database and mutates it; without a live
  Postgres on :5432, 8 of 52 tests fail with `ECONNREFUSED`. This is why CI cannot simply
  run `vitest` yet, and it blocks the upgrade-path CI phase 11 wants.
- **`./data` ownership landmine.** The Dockerfile `chown`s `/data` at build, but the
  compose bind mount overlays it with host ownership at runtime. Wrong UID on a Linux
  host → cannot write blobs or generate `secret.key`, and it **fails at first upload, not
  at boot**. macOS hides it. Docs need `chown -R 1000:1000 ./data`.
- **Rollback is unsafe and undocumented.** Migrations are forward-only and auto-apply, so
  pulling an older tag runs old code against a new schema. The upgrade doc must say *back
  up first*.
- **No published images yet.** Compose still says `build: .` — installing means building
  on the target box (583MB of node_modules for a 9.3MB `.output`; tight on 2GB RAM, fails
  on 1GB). Phase 11's GHCR multi-arch pipeline is the fix and the biggest adoption win.
- Note deletion, S3 storage driver, orphan-blob sweep (a finalize that never arrives
  leaves bytes with no row).

## UI craft debt (catalogued 2026-07 · token pass shipped 2026-08)

**The token-and-primitive layer landed** (`9bb23a8` and after): named type steps
(`text-micro` → `text-display` — if a size isn't on the list it doesn't go in the app),
one focus treatment (`focus-ring` / `focus-ring-inset` at full `--ring`; the two old
translucent rings both missed WCAG 2.2's 3:1 non-text floor), the muted ramp resolved to
≥4.5:1 with sub-100% opacities deleted, `.numeric` making the Tabular Rule structural
(tabular + right-aligned in one class), `--row-h` row rhythm, a global
`prefers-reduced-motion` kill switch, and the two-tier colour rule (vermilion primary +
twelve-hue badge tint palette). DESIGN.md §2–§3 now match the code; the reasoning also
lives in `src/styles.css` comments — read those before changing any colour.

**Still open, in order:**
- **~69 old focus rings** remain outside the table surfaces (record pages, spaces, theses,
  notes, settings) — **5 of them in the shell** (`app-sidebar.tsx`, `_app.tsx`), so they
  are on screen even on the polished routes. Mostly mechanical — swap to `focus-ring` and
  delete the adjacent `outline-none`, which would otherwise cancel it — but controls
  inside a scroll container need `focus-ring-inset`, so not a blind find-and-replace.
- **`/impeccable polish`** for the surfaces above (arbitrary type sizes ride along).
- **`/impeccable document`** to write DESIGN.md §5 — *after* the sweep, not before.
- **Dark theme** remains a feature, not started: the `dark` custom-variant exists but no
  dark token values do.

**Also carry into any design run:** the deferral list, or an Attio-shaped brief will
propose most of it back. Deferred by name: saved/shared views, bulk edit, calculations row,
CSV, virtualization + keyboard-grid, kanban, drawer-over-table, Overview/Highlight cards.

## Open questions

- ~~**Space page shape.**~~ **Answered, and shipped:** one scrollable page, memo at top — a
  space is something you *read*, not something you administer. Still unresolved is what
  happens as it goes from three sections (memo · companies · notes) to six — sources,
  contacts, and theses have no section yet, and phase 7 adds two of them.
- **Does a thesis need its own attributes**, or is claim + conviction + status enough?
  Resist list-ifying it; a thesis is prose with structure, not a row.
- ~~**Note vs memo vs document.**~~ **Answered 2026-07: one object.** A memo is a note with
  `kind = 'memo'` — same table, same editor, same links. The kind drives presentation and a
  later PDF export, nothing structural. See *Filed vs referenced*.
- **`values jsonb` indexing strategy** for kanban group-by, per the data model section.
