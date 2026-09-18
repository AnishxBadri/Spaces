# Map: the data model and the AI substrate

Status: orientation sketch (2026-09-11). Not a decision record — decisions live
in `CONTEXT.md`; the substrate design in `docs/spec-ai-substrate.md`. This page
is the one-screen picture of how entities, resolution, the entity-refs
registry, the assembler, the router, and the suggestion queue fit together.

## The diagram

```
                              WRITE SIDE

  form / deck / mention / clip / Apollo / email / import
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │  resolveEntity(kind, keys, name)             │  the one door
  │  exact identity key → attach                 │
  │  no match → create + trigram sweep           │──► duplicate_candidate
  │  fuzzy never merges                          │        │ human
  └──────────────────┬───────────────────────────┘        ▼
                     │                            mergeEntities(winner,
                     ▼                              loser) ── iterates ─┐
                                                                        │
 ═══════════════════════ DATA MODEL ═══════════════════════════════     │
                                                                        │
  ┌─ entity ───────────────────────────────────────────────┐            │
  │ id · kind · object_id · canonical_name · values jsonb  │            │
  │ merged_into_id                                         │            │
  └──┬──────────┬─────────┬────────┬──────────┬────────┬───┘            │
     │ pk=fk    │         │        │          │        │                │
  company    person    space     note     document   term   (org, deal, │
  (marker)  (marker)  path    body,tsv  text,tsv    def     custom:     │
                      ltree   visibility  ├─chunk           no side tbl)│
                                          │  embedding                  │
  satellites (fk → entity):                                             │
     entity_alias   identity keys, unique when is_identity              │
     attribute_event  per-attr history + refs                           │
     signal · enrichment_record · activity                              │
                                                                        │
  edges (entity ↔ entity):                                              │
     link(from, to, relation, attr_slug)   entity_space(entity, space)  │
                                                                        │
  non-entities that point at entities:                                  │
     task ─task_entity─┐   interaction ─interaction_entity─┐            │
     holding→round→investment/mark/distribution  round_co_investor      │
     mandate(note_entity_id)                                            │
                                                                        │
  config (no entity fk): attribute · object_def · view · template       │
                                                                        │
 ═══════════════════════════════════════════════════════════════════    │
                                                                        │
  ┌─ ENTITY_REFS registry ──────────────────────────────┐               │
  │ one entry per fk column → entity                    │◄──────────────┘
  │   merge:   repoint | repoint-or-drop | custom | none│
  │   context: {hop, kind, at, render} | null           │◄──────────────┐
  │ test: diff vs drizzle schema, fail on missing column│               │
  └─────────────────────────────────────────────────────┘               │
                                                                        │
                              READ SIDE                                 │
                                                                        │
  in-app feature ──┐                                                    │
  MCP client ──────┤  assemble(scope, task, {budget, user, asOf})       │
                   ▼                                                    │
  ┌──────────────────────────────────────────────────────┐              │
  │  ASSEMBLER  (pure, no model, no key)                 │── iterates ──┘
  │  1 scope → entity ids (follow merge redirect)        │
  │  2 walk graph: hop0 attrs/events/ledger              │
  │             hop1 notes docs interactions tasks refs  │
  │             hop2 space-ancestor memos                 │
  │  3 standing sources: mandate, glossary (reserved)    │
  │  4 canRead in SQL  (private note never enters)       │
  │  5 render → ContextItem{ref, kind, text, ids, at}    │
  │  6 rank: hop × prior × recency  ⊕ lexical  (RRF)     │
  │  7 trim to budget with floors                        │
  └──────────────────────────┬───────────────────────────┘
                             │ ContextItem[]  (snapshot-testable)
                             ▼
  ┌──────────────────────────────────────────────────────┐
  │  ROUTER   lane × sensitivity → model                 │
  │  extract · classify · synthesize · embed · research  │
  │  sensitive → local (Ollama)      keys from vault     │
  └──────────────────────────┬───────────────────────────┘
                             │ prompt: [ref] text … + task
                             ▼
                        ┌──────────┐
                        │  MODEL   │  no memory of its own
                        └────┬─────┘
                             │ output constrained by
                             ▼
  ┌──────────────────────────────────────────────────────┐
  │  OUTPUT SCHEMA  compiled from attribute registry     │
  │  option ids only · refs on every claim               │
  └──────────────────────────┬───────────────────────────┘
                             ▼
  ┌──────────────────────────────────────────────────────┐
  │  SUGGESTION QUEUE   propose, never write             │
  │  human accepts ──► setValues ──► attribute_event     │
  │                                  (refs = receipts)   │──► back into
  └──────────────────────────────────────────────────────┘    DATA MODEL
```

The loop closes at the bottom: an accepted suggestion becomes an
`attribute_event` carrying refs, and the next `assemble` reads it at hop 0.

## The pieces, one paragraph each

**Entity.** One row per real-world thing in a single `entity` table: company,
person, organization, deal, custom record, space, note, document, term. The
shared id space is what gives one mention system, one backlink query, one
search index, one merge executor, one `canRead` choke point. Kind-specific
structure lives in a side table whose primary key is the entity id
(class-table inheritance; not Postgres `INHERITS`). Attribute values live in
`entity.values` jsonb, shaped by the attribute registry. Identity keys live
only in `entity_alias`.

**Not entities.** Tasks, interactions, portfolio events, aliases, history
rows, and config. The test is "does anyone mention, link to, search for, or
merge this?" A task is a verb about nouns; it joins to entities through
`task_entity` and is deliberately not a kind.

**Entity resolution.** `resolveEntity` is the one door every creator walks
through. Exact identity-key match attaches; no match creates and files
trigram near-misses as `duplicate_candidate`; fuzzy never merges. It keeps
"one row per thing" true so everything downstream can assume it. Merge is
the repair when a nameless duplicate slips through.

**Entity-refs registry.** (Designed 2026-09-09, not yet built.) One code-level
list of every foreign-key column that points at an entity, keyed per column
(`activity.subject`, `link.from`). Each entry declares how merge repoints it
and how the assembler reads it (`context: null` is an explicit choice). A
test diffs the list against the drizzle schema so a new edge table cannot
ship without joining both consumers. This closes the class of bug where merge
or "everything about this record" silently misses a table.

**Assembler.** `assemble(scope, task, {budget, user, asOf}) → ContextItem[]`.
Pure code, no model, no key. Walks the graph via the registry to two hops,
adds standing sources (mandate, glossary) in a reserved budget slice, filters
through `canRead` in SQL, renders each row to plain text with a stable ref,
ranks by hop × kind prior × recency (plus a lexical lane fused by RRF when
the task carries text), trims to budget with floors. Deterministic on data +
`asOf` + user, so it is snapshot-testable and doubles as a non-AI
"everything about this record" view.

**RRF.** Reciprocal rank fusion, `Σ 1/(60 + rank)` per source. Already how
search fuses trigram names, note `tsv`, and document `tsv`. Honest only
because every source ranks the same entity id space. The assembler reuses it
to fuse its structural score with lexical (and later embedding) lanes.

**Router.** Features name a lane (extract, classify, synthesize, embed,
research), never a model. A settings table maps lane × sensitivity to a
provider; sensitive records route to local Ollama regardless of task. Keys
come from the BYOK vault.

**Output schema and suggestion queue.** Model output is constrained by a JSON
schema compiled from the attribute registry, so a select can only be an
option id and every claim carries refs. Results land as suggestions; a human
accepts; `setValues` writes the value and an `attribute_event` with those refs
as receipts. AI never writes directly.

**MCP.** The same three gates exposed as tools (`search_records`,
`get_record`, `get_context`, `list_registry`, `propose_suggestion`). An
external agent is a second client of the same contracts, with the same
`canRead` and the same propose-only boundary, and no privileged path.

## Open items surfaced while drawing this

- `list` / `list_entry` have no readers or writers; views replaced them. Drop
  before the registry lands, or carry them as `context: null`.
- `organization` is a dormant kind: resolvable and mergeable but with no
  object row, attributes, or record page. Decide its shape before the
  co-investor graph phase.
- `ContextItem.kind` in the spec lacks `interaction` and `task`; both are
  citation targets.
- Refs must resolve through `merged_into_id`; chunk refs should be
  `doc:<id>#<idx>` rather than chunk uuids so re-chunking keeps citations.
- View filters are evaluated client-side today; assembling over a view as a
  scope needs a server-side evaluator.
