# Architecture — the fund-management system, end to end

_Written 2026-08. This is the synthesis view: what the system is, model by model, and
what remains to build. The deep decision record (with dated reasoning and reversals)
stays in `CONTEXT.md`; the domain vocabulary is `docs/private-capital-glossary.md`;
the visual system is `DESIGN.md`. Product name: **Angle** (rename lands at ship-polish
start; code says DealOS until then)._

## 1. What this is

An open-source, **self-hosted deal-management OS for angel investors and small funds**
(design target: one investor; growth path: 1–15 users on one deployment). Two halves on
one graph:

- **Research half** (PKM-shaped): spaces, notes/memos, sources, glossary — slow,
  exploratory, no pipeline.
- **Deal half** (CRM-shaped): companies, people, deals, activity — fast, structured.

**The seam is the product**: a company entering the pipeline already carries months of
research — filed memos, glossary context, contacts, saved documents. On top of both, a
**financial layer** (rounds, checks, ownership, marks, performance) turns the CRM into
fund management. Everything is BYOK — LLMs, enrichment, storage — and nothing phones
home.

## 2. System shape & stack

```
Browser (React SPA) ── typed server functions ──┐
                                                ├── Postgres 17 (data + jobs + search + vectors)
Worker (pg-boss consumer: extraction, digests) ─┘
                                                └── Blob store: local disk (default) | any S3 endpoint
```

Two Node processes, one database, one blob location. Production = **two containers**
(app + Postgres); TLS via an optional Caddy overlay; ephemeral-disk platforms (Fly/
Railway/Render) supported via `STORAGE_DRIVER=s3` + R2/B2.

| Layer      | Choice                              | Why (one line)                                                                                                                                |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | TanStack Start + React 19           | one data-fetching model (server fns + Query) for a client-heavy authed app; typed URL state for saved views                                   |
| DB         | Postgres 17 + Drizzle               | one stateful service carries relational data, jobs (pg-boss), lexical+fuzzy search (tsvector, pg_trgm), hierarchy (ltree), vectors (pgvector) |
| Auth       | Better Auth                         | self-hosted sessions; no SaaS identity dependency                                                                                             |
| Editor     | BlockNote (ProseMirror)             | Notion-grade blocks; JSON authoritative, markdown derived                                                                                     |
| Table      | TanStack Table                      | headless spreadsheet-grade grid — the hardest UI, owned not rented                                                                            |
| Storage    | local FS / `@aws-sdk/client-s3`     | content-addressed sha256 blobs; checksum-signed presigned PUTs; worker re-verifies digests                                                    |
| Extraction | unpdf · mammoth · fflate+OOXML      | in-process on the worker; no OCR container (BYOK vision later)                                                                                |
| Motion/UI  | Tailwind 4 + Radix + tw-animate-css | pure-CSS motion (Freiberg timing), one focus ring, OKLCH token system ("Pine")                                                                |
| Validation | Zod at write-path choke points      | hand-written; schema-derivation can't carry business rules                                                                                    |

Doctrines that shape everything: **append-only where history is information** ·
**AI writes are suggestions, never silent** · **structure fixed, content free** ·
**required env frozen at {DATABASE_URL, APP_URL}** · **no workspace_id FK, ever**.

## 3. Workspace model _(shipped)_

One deployment = one workspace = one shared dataset. **No multi-tenancy** — two funds
run two containers.

- **Singleton row** (`workspace`, CHECK id=1): name, logo, settings. Anchors the
  mandate, workspace-scoped credentials, sidebar identity. The no-`workspace_id` rule
  keeps tenancy from creeping in by accident.
- **Auth**: first-run signup open only while `count(user)==0`, gated by a one-time
  setup token printed to server logs; thereafter **invites only** (hash-stored,
  single-use, 7-day, role baked in, copyable link — SMTP never required).
- **Roles**: `admin` (settings, keys, members, structural edits) and `member`
  (everything else — a two-person fund has no ceremony). Every mutation routes through
  `canWrite()` so a future read-only `viewer` (LP, analyst) is a one-line change.
- **Visibility**: rows that can be personal carry `author_id`/`visibility`.
  Default **shared** (private-by-default is the trap that keeps partner #2 in Apple
  Notes); `private` is per-note opt-in, author-controlled, enforced in SQL everywhere a
  title or body could leak (lists, search CTEs, autocomplete, space pages).

## 4. Entity graph _(shipped — the substrate everything sits on)_

Everything linkable is an `entity(id, kind, canonical_name, …)`; kinds are **fixed in
code**: company · person · organization · deal · space · note · document · term. One
edge table:

```
link(from_entity, to_entity, relation: mentions | tagged_in | contact_at
     | derived_from | supersedes | references, source, attr_slug?)
```

Typing `[[Orbital Composites]]` in a note materializes a link row — backlinks are one
query. Record-reference attributes materialize `references` links in the same
transaction, so rails, backlinks, and merge all live on one graph.

**Entity resolution** (`resolveEntity()`, the single choke point every creator calls):
deterministic keys auto-attach (domain, email, LinkedIn, CIN — normalized: eTLD+1,
free-mail domains never make companies); fuzzy names only _suggest_ into a dedupe
inbox. **Merge** repoints at write with a full snapshot (unmerge-able), never resolves
at read.

## 5. Object model — the attribute engine _(shipped; expansion path decided)_

**Companies, People, Deals** are objects with a registry; notes/spaces/terms are
deliberately _not_ object-modeled (they're the research layer that links in).

- All values — system and custom — live in `entity.values` jsonb keyed by slug. One
  write path (`setValues`, row-locked), one Zod-per-type validator, one renderer; the
  registry generates table columns, create-modal fields (type-driven two-column grid),
  and record rails.
- **Type menu is fixed** (users define attributes, never types): text, number,
  currency, date, checkbox, select, multi-select, status (grouped options), domain,
  email, url, phone, rating, record-reference, actor-reference.
- Hard exclusions: identity (domains/emails) and kind/name live outside attributes.
- `attribute_event` logs every change in-transaction → stage history and
  time-in-stage fall out free; timelines condense at read.
- **Expansion path**: attribute _descriptions_ → timestamp → structured location →
  (deliberately last) formula. Headline: **AI-autofill attributes** (classify /
  summarize / prompt-completion) with the BYOK phase — fed by the research graph,
  provenance-tracked, suggestion-only. Custom _objects_ stay out; a universal fourth
  object ships as a system release.

## 6. Research model _(shipped)_

- **Spaces** — the investor's own market taxonomy (ltree paths, arbitrary depth,
  many-to-many tagging via `entity_space` with source/confidence). Hierarchy decides
  where memos _file_; tagging handles cross-cutting. Tiny seed, never an ontology.
- **Notes/memos** — BlockNote JSON authoritative, markdown derived per save (feeds
  search); mentions diff-sync link rows; a "memo" is presentation, not structure.
- **Glossary** — per-space terms, inherited down the tree, auto-linked in the editor
  as ProseMirror decorations (never written into content).
- **Documents** — first-class entities: browser-hashed → checksum-signed presigned
  PUT → filed via `link(tagged_in)`; worker extracts text (PDF/DOCX/PPTX/XLSX) and
  verifies digests; preview renders opaque bytes client-side (stored-XSS hardening
  survives both storage drivers).
- **Search** — one Cmd-K over names (trigram, typo-tolerant), note bodies, and
  extracted deck text, fused by reciprocal-rank fusion in a single Postgres query;
  pgvector joins as a fourth CTE when embeddings land.

## 7. Mandate model _(shipped)_

The fund's **prescriptive strategy** — what an LP reads in the deck — distinct from
market claims (which live as prose in spaces). One active row per workspace
(`archived` = prior vintages): prose body is a real memo note (searchable,
mentionable, future AI-screening input) plus a few typed facts — stages (sharing the
company funding-stage vocabulary), geos, check range. Nav-first surface; the one live
consumer is the **outside-mandate hint** on deal records (company stage ∉ mandate
stages → quiet flag, never a block). Portfolio construction stays prose until a
feature consumes it.

## 8. Deal model _(shipped)_

**One deal = one opportunity (round/instrument) in one company**; many deals per
company over time is the institutional memory. Three-state doctrine:

1. **Watching** — no deal exists; company tagged into spaces ("tracking, not
   evaluating").
2. **Pre-lead** — a deal is born when something arrives; high-volume triage.
3. **Funnel** → terminal: **Invested · Passed (our no) · Lost (their no)** — distinct
   post-mortem lessons; terminal deals close, never delete. A Parked group ("early —
   revisit") protects warm relationships from stage abuse.

Stages are a status attribute with editable options and stable ids; stage analytics
derive from `attribute_event`.

## 9. Template model _(shipped)_

One table, three kinds, **all creation by-example** ("Save as template" on a note,
record, or space — no builder UI):

- **note** — stored BlockNote body; mentions stripped to text at capture (a template
  must not spray ghost backlinks); instantiate = copy.
- **record** — attribute defaults (references/actors excluded) that **pre-fill the
  create modal visibly** — nothing writes silently.
- **space** — a nested scaffold captured from a real space (subtree names + glossary,
  never memo content), stamped skip-existing: build your market-breakdown pattern
  once, stamp it onto the next market.

Application is manual plus a `suggest_on` context hint. Config, not entities.

## 10. The financial engine _(phase 15 — the next build)_

The layer that turns the CRM into fund management. Design rule #1, confirmed
independently by ILPA's reporting canon: **everything is an append-only dated event;
every aggregate is derived, never stored.** Point-in-time ("as on 2 May 2026") views
are then just filters.

### Event tables

```
round(company, date, kind, raised, pre_money, post_money,
      price_per_share, shares_outstanding /* fully diluted */, co-investor links)

investment(company/deal ref, round ref, date, amount, currency,
           instrument: priced | safe_post_money | safe_pre_money | ccd,
           shares?, cap?, discount?, vehicle? /* label, not tenancy */)

mark(holding, date, fair_value, basis: round_price | manual | 409a)
     -- append-only; IPEV-aligned: PORI decays, staleness stays visible

distribution(holding, date, amount, currency, kind: exit | secondary
             | dividend | writeoff, shares_sold?, price_per_share?)
```

**A deal reaching Invested births a holding** — the pipeline→portfolio seam (the same
philosophy as research→pipeline; Edda converged on it independently).

### Semantics that make it honest

- **Instrument-aware ownership**: post-money SAFEs lock ownership at signing
  (amount ÷ cap — displayed as _implied %_); pre-money SAFEs and CCDs show cost basis
  only until conversion — a % is never faked.
- **Ownership ledger**: our shares ÷ fully-diluted outstanding, recomputed per round —
  an ownership _history_ (entry % → current %, dilution per event), deliberately not
  cap-table management (that's Carta; we integrate someday, we don't compete).
- **Multi-currency from the first migration**: per-event currency, base-currency
  roll-up, manual rates first.
- **Write-offs are one honest click** — power-law thinking: most go to zero; the
  record should make that easy to say, and make the winner's history deep.

### Derived metrics (computed live — dozens of holdings need no warehouse)

Per holding and portfolio roll-up: **cost basis · net cost · unrealized (latest
marks) · realized (distributions) · MOIC · TVPI · RVPI · DPI · gross XIRR**
(Newton-Raphson + bisection fallback) — all as-of-date capable. _Net_ IRR (fees,
carry, waterfalls) is deliberately fenced: that's the LPA-bespoke accounting engine
(Fundwave's tier) a solo GP doesn't need.

### The Portfolio surface

The existing record-table engine pointed at holdings: invested / current value /
implied-or-actual ownership / MOIC / XIRR / **last-mark date** (staleness visible, per
IPEV instincts), plus a holding detail view (rounds, checks, marks, distributions —
the tear sheet falls out of it).

## 11. Metric parity vs TagHash-class tools — what it takes

| Their feature                                                    | Status on our engine                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IRR, MOIC, TVPI, DPI, RVPI                                       | **falls out of phase 15** (gross; live-computed)                                                                                                                |
| NAV (holdings value)                                             | **falls out** (Σ latest marks); fund cash accounting fenced                                                                                                     |
| Valuation history / marks workflow                               | **phase 15** (`mark` with basis + date, append-only)                                                                                                            |
| Round & ownership tracking, dilution after follow-ons            | **phase 15** (ownership ledger)                                                                                                                                 |
| Divestment math (shares sold, proceeds, ownership delta)         | **phase 15** (`distribution` with shares)                                                                                                                       |
| "As on <date>" point-in-time dashboards                          | **free** — consequence of the event rule                                                                                                                        |
| Latest-round / latest-transaction cards, cost & value breakdowns | rendering over the same events                                                                                                                                  |
| Tear sheets                                                      | **banked** — the holding detail view, exportable later                                                                                                          |
| KPI / MIS collection from founders                               | **banked** — Visible-style: standard six metrics, tokenized founder links, runway lens                                                                          |
| Deal scorecards (weighted partner votes)                         | **banked** — post-portfolio, maps onto rating attributes                                                                                                        |
| Total commitments, capital calls/notices, capital accounts       | **fenced** — lightweight single-vehicle ledger only if fund-I customers ask (India note: SEBI bakes per-deal pro-rata into regulation — that defines its shape) |
| Multi-fund / SPV / FoF look-through, LP portal & reports         | **fenced** — fund-admin tier; wrong customer                                                                                                                    |
| Net IRR / waterfalls / fees / carry                              | **fenced** — the LPA-bespoke engine                                                                                                                             |

What we have that none of them do: the **research half on the same graph**
(spaces/memos/glossary/backlinks feeding deals), self-hosting in two containers, and
BYOK down to local Ollama for confidential decks.

## 12. Roadmap (current sequence)

Shipped through phase 14: object model & tables · interactions · documents · search ·
glossary/seeds · auth+onboarding · mandate · templates · S3 driver · design-debt pass.

- **15 — Portfolio layer** (§10; the financial engine)
- **16 — Ship polish** _(deferred; scope TBD — rename to Angle, test-db harness, CI,
  GHCR images, install docs — decided when a release is in sight)_
- **Post-v1 backlog**: dark theme · MIS + runway lens · scorecards · meeting-prep
  briefs, pass-letter drafting, deck-reader autofill (BYOK AI) · MCP server (last) ·
  integrations: Calendar → Gmail (forward-only) → Apollo/Exa enrichment
- **Hostability contracts** (locked, implemented at ship): root-entrypoint `/data`
  ownership repair · either-process-dies-container-dies · TLS always via proxy ·
  DB-checking healthcheck · both-or-neither backup · frozen required-env set

## 13. The shape of the whole thing

An angel or two-partner fund gets, in one self-hosted box: their market map and
research compounding (spaces/notes/glossary), a spreadsheet-grade CRM that already
speaks investing (deals born from decks, mandate screening, pass-vs-lost memory),
and — after phase 15 — the honest financial core (what did I invest, what do I own,
what is it worth, what has it returned) computed from an event ledger an auditor
would recognize the shape of, without the fund-admin apparatus none of them need.
The fenced tier is the moat _against_ scope creep: TagHash-class fund administration
is a different product for a different buyer, and every locked decision above keeps
this one two containers small.
