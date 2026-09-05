# Spec: the AI substrate (context, contracts, and the plugin boundary)

Status: design draft (2026-09-02, "future" branch deliberation — not yet
grilled). Builds on CONTEXT.md decisions: BYOK vault, Vercel AI SDK +
task→model mapping, Ollama first-class, the embeddings dimension trap, the
suggestion/provenance doctrine, canRead, and the two-tier object model
(`docs/spec-attribute-engine.md`). Competitive grounding:
`docs/survey-attio-attribute-model.md` (their AI sees attribute values only),
folk's assistants (interaction-fed, push-triggered — we take the context
idea, reject the push).

## 0. Stance — the CRM is the memory layer

No separate "AI memory" store (vector scratchpads, conversation memories,
agent notebooks). A second source of truth drifts from the first. The
substrate is a **read protocol over what is already true** — attributes,
notes, document text, attribute_events, mandate, glossary, spaces, portfolio
events — rendered to context at request time. The only derived artifact is
embeddings, and they are rebuildable cache (model pinned per deployment,
`embedding_model` stored per row, re-embed is a job — the recorded
dimension-trap rules), never load-bearing.

Everything below is four contracts and one server. Features — deck analyzer,
triage screener, pre-mortem, update parser, Monday brief, LP letter — must
reduce to compositions of these contracts with **zero new primitives**.
That's the acceptance test for the layer, and the bar every future AI
feature is held to.

## 1. Context contract — ContextItem + the assembler

One canonical, model-agnostic shape for everything AI-visible:

```
ContextItem {
  ref         stable citation id (entity/attr slug · note id · doc chunk id ·
              event id · mandate section · glossary term)
  kind        attribute | note | doc_chunk | event | mandate | glossary | memo
  text        plain-text rendering — text is the interchange, not embeddings,
              not provider message formats
  entity_ids  what it is about
  at          when it was true
}
```

The **assembler** is the only producer:

```
assemble(entity | task_scope, task, budget) → ContextItem[]   // ranked, trimmed
```

- Walks the graph: the record's attributes → linked notes → filed documents'
  chunks (retrieval-ranked) → space memos up the tree → mandate → glossary
  terms appearing in the task → recent attribute_events. Standing
  declarations (mandate, memos, glossary, attribute descriptions, templates)
  are **context sources**: curated, durable, owner-authored — the
  generalization of "mandate feeds the deck analyzer."
- **Every item passes canRead for the requesting user before leaving the
  layer.** A private note never leaks into a prompt whose output a teammate
  reads (the recorded hard rule).
- Deterministic given the same data — snapshot-testable with no model in the
  loop ("what would the analyzer see for this company" is a pure fixture).
- Output is citable: suggestions and drafts carry `ref`s; UI renders "from
  p.4 of the deck" / "from your immersion-cooling memo."

Judgment-memory retrieval is an assembler mode, not a feature: rank
close_reasons, pass/lost notes, and stage histories of _similar_ records
(embedding similarity over the user's own notes) into context. The mandate
says what you claim to want; close_reasons say what you actually do.

## 2. Schema contract — the registry is the output type system

Any AI output that touches records is a **patch proposal keyed by attribute
slugs**, compiled from the registry to JSON-schema structured output (all
target providers speak it; AI SDK carries the differences):

- classify → the select/status attribute's options are the enum
- extract → subset of the object's registry as properties, each with the
  type's write shape
- Custom objects extend the contract automatically — a user-defined "Fund"
  object is immediately extractable-into with zero new AI code.

Proposals validate through the same zod validators as human writes. AI
output is structurally incapable of being malformed or of inventing fields.

## 3. Action contract — propose, never write

The AI layer gets exactly one mutating verb:

```
propose(suggestion)   → suggestion table → review queue
```

Accepted suggestions write via setValues with the **accepter** as actor;
machine-side provenance rides the suggestion row (source, confidence,
context refs). Direct writes, deletes, merges, sends: not in the contract.
A new model, a misbehaving agent, or a prompt injection in a deck can at
worst propose noise into a queue. This is the trust boundary that makes
"plug in any model" a zero-risk statement, and it is the already-decided
suggestion doctrine — restated here as the _only_ door.

## 4. Provider contract — two functions, five lanes

The entire model-interop surface:

```
complete(lane, context: ContextItem[], output_schema?) → text | patch
embed(texts) → vectors
```

Adapters per provider (Anthropic / OpenAI / Google / Ollama / OpenRouter)
via the AI SDK, keys from the BYOK vault. Features never name a model — they
name a **lane**:

| Lane       | Shape                                         | Default tier                           |
| ---------- | --------------------------------------------- | -------------------------------------- |
| extract    | doc → structured patch                        | cheap, structured-output               |
| classify   | value from an options enum                    | cheap                                  |
| synthesize | memo/analysis/recap drafting                  | frontier                               |
| embed      | chunks → vectors                              | pinned per deployment (dimension trap) |
| research   | live web (enrichment lane, separate doctrine) | provider-specific                      |

**Routing = lane × sensitivity**, a settings table, not feature code. The
second axis is the family-office differentiator: a space, document, or
record flagged sensitive routes to the local lane (Ollama) regardless of
task. BYOK + self-host makes this honest; no hosted CRM can offer it.
Trigger doctrine: manual, pull-based (per cell, per column, per request) —
Attio independently converged here; folk's push assistants are the
anti-pattern.

## 5. The MCP server — AI integration as an actual plugin

The four contracts map one-to-one onto an MCP tool surface:

```
search_records(query, object?)        — hybrid retrieval (tsv + vectors + graph)
get_record(id)                        — attributes + links, registry-shaped
get_context(entity, task?, budget?)   — the assembler, verbatim
list_registry(object?)               — objects + attributes + options
propose_suggestion(entity, patch, rationale, refs)
```

Ship this and **the user's own assistant becomes the AI layer** — Claude,
ChatGPT desktop, an IDE agent, whatever wins next year — with the propose-
only boundary still enforced server-side, canRead still applied per the
authenticated user, and the server staying on their box. The in-app BYOK
features are just a second client of the same contracts. One layer, two
consumers; model interop is delegated to the protocol the ecosystem
standardized on instead of chased vendor by vendor.

## 6. Agentic extensibility — agents are clients, never privileged

What a future agentic architecture needs, and where it already lands:

| Agent need            | Substrate answer                                               |
| --------------------- | -------------------------------------------------------------- |
| Tools                 | the MCP surface (§5) — same tools, in-process or over the wire |
| Memory / world state  | the assembler (§1) — the CRM _is_ the memory                   |
| Typed outputs         | registry compilation (§2)                                      |
| Human approval gates  | the suggestion queue (§3) — HITL by construction               |
| Multi-step provenance | `run` log (below)                                              |
| Long-running work     | the existing worker; lanes route each step's model             |

One addition when agents land (design now, build then): a **run log** —
`run(id, task, steps jsonb: [{tool, input_refs, output_ref, at}],
credential_id, tokens, status)` — so a multi-step run is auditable and its
suggestions cite the run. Suggestions gain an optional `run_id`. The typed
actor from the attribute-engine spec (`integration`) is what a run writes
as, when accepted.

Design rule, stated once: **an agent is a client of the four contracts. It
gets no fifth contract, no privileged write path, no direct DB access.** If
an agent workflow seems to need more than the contracts offer, the contract
grows deliberately — the layer never gets bypassed.

## 7. Retrieval

Hybrid, in ranking order per query: graph proximity (links, spaces,
references) → lexical (`tsv`, exists) → semantic (pgvector chunks — extend
from document_chunk to notes and close_reasons). Embedding rules per
CONTEXT.md: one pinned model, model id stored per row, re-embed as a job,
never mix dimensions. The keyless-first-boot question (bundle bge-small vs
"no key = hidden") stays open there — this spec takes no new position.

## 8. Build order

1. **Assembler + ContextItem rendering** — pure code, no model, no key.
   Snapshot tests. Immediately useful for a non-AI "everything about this
   record" view.
2. **Registry → JSON-schema compiler** — pure code, tested against every
   attribute type incl. a custom object.
3. **Provider adapters + routing table + vault wiring** — first model call;
   first feature (triage screener or update parser — smallest lane
   compositions).
4. **MCP server** exposing §5 — after the contracts have one internal
   consumer proving them.
5. **Run log** — when the first multi-step feature (deck analyzer chaining
   extract → synthesize) wants provenance.

Non-goals: a separate AI memory store; push-triggered assistants; financial
modelling features; direct-write AI anywhere; per-feature model pickers;
chat UI as the primary surface (the record, the queue, and the user's own
assistant via MCP are the surfaces).
