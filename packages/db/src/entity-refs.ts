import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import {
  activity,
  aiRun,
  attributeEvent,
  chunk,
  duplicateCandidate,
  enrichmentRecord,
  entity,
  entityAlias,
  entitySpace,
  holding,
  importRow,
  interaction,
  interactionEntity,
  investment,
  jobRun,
  link,
  mandate,
  mergeEvent,
  round,
  roundCoInvestor,
  signal,
  suggestion,
  taskEntity,
  term,
} from './schema'

/**
 * The one list of columns that point at an entity (CONTEXT.md "One registry
 * of entity-referencing tables", 2026-09-07).
 *
 * The graph is one `link` table in the story but a dozen edge columns in the
 * schema. Three consumers must iterate every one of them: the merge executor
 * (repoint loser → winner), the context assembler ("everything about this
 * record"), and the delete executor (`apps/web/src/lib/entities/delete.ts`,
 * SPA-77). All three have the same failure mode — a new column ships and one
 * of them silently misses it. So all three read this array, and
 * `entity-refs.test.ts` diffs it against drizzle's foreign-key metadata: a
 * column that references `entity.id` (or a side table's entity_id) without an
 * entry here fails CI.
 *
 * Membership rule: every FK column whose target is `entity.id` or a side
 * table's primary key, except a side table's own single-column PK (that row
 * *is* the entity, not a reference to one). Composite-PK edge columns such
 * as entity_space.entity_id are references and belong here.
 *
 * Each entry answers all three consumers explicitly. `context: null` is a
 * decision, not an omission — it means "this column is never AI-visible" —
 * and `del` is the same kind of declaration for deletion.
 */

// ---------- merge ----------

export type MergeStrategy =
  /** Plain `update set col = winner where col = loser`. */
  | { kind: 'repoint' }
  /**
   * Same, but the row collides with a unique index on (col, ...uniqueWith)
   * when the winner already has the pair — drop the loser's row then.
   */
  | { kind: 'repoint-or-drop'; uniqueWith: ReadonlyArray<PgColumn> }
  /** Hand-written section in merge.ts; named so the two stay findable. */
  | { kind: 'custom'; handler: string }
  /** Never repointed; `why` is the invariant that makes that safe. */
  | { kind: 'none'; why: string }

// ---------- delete ----------

/**
 * What the delete executor (`apps/web/src/lib/entities/delete.ts`) does with
 * the rows on this column when the entity they point at is deleted. Four
 * answers, and every entry gives one: a column with no `del` is a row the
 * executor would walk past and leave dangling — or trip over as a foreign-key
 * violation, which is how `deleteDocument` and `deleteTerm` used to fail.
 *
 * `block` is not a fallback for "undecided": its `reason` is what the caller
 * is told, so it reads as a sentence about the data, not about the code.
 */
export type DeleteStrategy =
  /** Delete the dependent row — it is only about the entity. */
  | { kind: 'cascade' }
  /** Refuse the whole delete; `reason` is shown to the caller. */
  | { kind: 'block'; reason: string }
  /** Null the column and keep the row, which means something without it. */
  | { kind: 'orphan'; why: string }
  /**
   * Nothing to do: no row can point here when the entity dies, and `why` is
   * the invariant that makes that true. No entry claims this today — it is
   * declared so a column that is genuinely unreachable can say so instead of
   * pretending to cascade.
   */
  | { kind: 'none'; why: string }

// ---------- context ----------

/**
 * The two halves of the context contract that ENTITY_REFS itself speaks
 * (docs/spec-ai-substrate.md §1). They are declared here, and re-exported by
 * `apps/web/src/lib/context/types.ts` which keeps the rest — `ContextEdge`,
 * `ContextItem` — because the `context` field of every entry below is typed
 * against them and packages/db imports nothing internal (SPA-142). Both
 * halves land in core together at mono-9a; until then this is where the
 * vocabulary is written down.
 */

/**
 * ContextItem kinds. The spec's seven plus `interaction` and `task`: both
 * are citation targets and neither is an entity (decided 2026-09-09).
 *
 * No kind for the note and attribute chunk sources `chunk` gained in SPA-102
 * (decided there). A chunk is the *retrieval* grain, not the citation grain:
 * a note chunk renders as `note` (ref `note:<id>`), a close_reason chunk as
 * `attribute` (the attribute's ref), because the semantic lane only ranks
 * which note or value surfaces. Neither renders as `doc_chunk` — that kind
 * means a `doc:<id>#<idx>` ref, and the ranker's per-document cap
 * (`rank.ts`, `docOfRef`) reads it so.
 */
export type ContextKind =
  | 'attribute'
  | 'note'
  | 'memo'
  | 'doc_chunk'
  | 'event'
  | 'interaction'
  | 'task'
  | 'mandate'
  | 'glossary'

/** Hop distance from the seed record; `standing` = curated source, unranked. */
export type ContextHop = 0 | 1 | 2 | 'standing'

export type ContextRole =
  /** Rows on this column become ContextItems of `kind`. */
  | { role: 'item'; kind: ContextKind; hop: ContextHop }
  /** Rows on this column are edges the walk follows to other entities. */
  | { role: 'traverse'; hop: 1 }

export type EntityRef = {
  /** Snapshot label + human key: `<table>.<role>`. Matches merge_event.snapshot. */
  key: string
  table: PgTable
  column: PgColumn
  /**
   * Set when the column has no declared FK (entity.merged_into_id). The diff
   * test cannot discover it from metadata, so it is asserted by hand.
   */
  noFk?: true
  merge: MergeStrategy
  del: DeleteStrategy
  context: ContextRole | null
}

// `entity.sensitive` (SPA-61) has no entry and needs none: it is a boolean
// on the entity row itself and references nothing, so there is nothing to
// repoint on merge and no edge for the context assembler to walk.
export const ENTITY_REFS: ReadonlyArray<EntityRef> = [
  // --- identity ----------------------------------------------------------
  {
    key: 'entity_alias.entity',
    table: entityAlias,
    column: entityAlias.entityId,
    merge: { kind: 'custom', handler: 'aliases' }, // move; drop exact dupes
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'attribute', hop: 0 },
  },
  {
    key: 'entity.merged_into',
    table: entity,
    column: entity.mergedIntoId,
    noFk: true,
    merge: { kind: 'custom', handler: 'redirect' }, // set + flatten chains
    del: {
      kind: 'block',
      reason:
        'losers would redirect at nothing; deleting an entity with losers is a deliberate later action (owner, 2026-09-19)',
    },
    context: null, // resolved before the walk starts
  },

  // --- edges -------------------------------------------------------------
  {
    key: 'link.from',
    table: link,
    column: link.fromEntityId,
    merge: { kind: 'custom', handler: 'links' }, // both ends + values rewrite
    del: { kind: 'cascade' },
    context: { role: 'traverse', hop: 1 },
  },
  {
    key: 'link.to',
    table: link,
    column: link.toEntityId,
    merge: { kind: 'custom', handler: 'links' },
    del: { kind: 'cascade' },
    context: { role: 'traverse', hop: 1 },
  },
  {
    key: 'entity_space.entity',
    table: entitySpace,
    column: entitySpace.entityId,
    merge: { kind: 'repoint-or-drop', uniqueWith: [entitySpace.spaceId] },
    del: { kind: 'cascade' },
    context: { role: 'traverse', hop: 1 }, // → space → ancestor memos (hop 2)
  },
  {
    key: 'entity_space.space',
    table: entitySpace,
    column: entitySpace.spaceId,
    merge: { kind: 'none', why: 'space kind is not mergeable' },
    del: { kind: 'cascade' },
    context: { role: 'traverse', hop: 1 }, // space scope → members
  },

  // --- history + sourced facts -------------------------------------------
  {
    key: 'attribute_event.entity',
    table: attributeEvent,
    column: attributeEvent.entityId,
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'event', hop: 0 },
  },
  {
    key: 'suggestion.entity',
    table: suggestion,
    column: suggestion.entityId,
    // Open ones follow the record so the queue keeps them; decided ones
    // follow too, beside the attribute_events that cite them.
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' }, // a proposal about a deleted record is moot
    // A suggestion is not yet true, and never enters a prompt (spec §3):
    // once accepted, the attribute_event it wrote is what the walk sees.
    context: null,
  },
  {
    key: 'signal.entity',
    table: signal,
    column: signal.entityId,
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'event', hop: 0 },
  },
  {
    key: 'enrichment_record.entity',
    table: enrichmentRecord,
    column: enrichmentRecord.entityId,
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'event', hop: 0 },
  },
  {
    key: 'activity.subject',
    table: activity,
    column: activity.subjectEntityId,
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' },
    context: null, // attribute_event is the finer-grained record
  },
  {
    key: 'activity.object',
    table: activity,
    column: activity.objectEntityId,
    merge: { kind: 'repoint' },
    del: { kind: 'cascade' },
    context: null,
  },

  // --- non-entities that point at records --------------------------------
  {
    key: 'interaction_entity.entity',
    table: interactionEntity,
    column: interactionEntity.entityId,
    merge: {
      kind: 'repoint-or-drop',
      uniqueWith: [interactionEntity.interactionId],
    },
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'interaction', hop: 1 },
  },
  {
    key: 'interaction.note',
    table: interaction,
    column: interaction.noteId,
    merge: { kind: 'none', why: 'note kind is not mergeable' },
    del: {
      kind: 'orphan',
      why: 'the meeting outlives its write-up: kind, occurred_at and the attendee edges are the event, and the note is prose someone may delete without unhappening the call (SPA-123)',
    },
    // The write-up is already reached through its own `tagged_in` edges to
    // every attendee, which is how it lands under "Filed here"; an item entry
    // here would walk the same note a second time and double-count it.
    context: null,
  },
  {
    key: 'task_entity.entity',
    table: taskEntity,
    column: taskEntity.entityId,
    merge: { kind: 'repoint-or-drop', uniqueWith: [taskEntity.taskId] },
    del: { kind: 'cascade' },
    context: { role: 'item', kind: 'task', hop: 1 },
  },

  // --- portfolio ledger --------------------------------------------------
  {
    key: 'holding.company',
    table: holding,
    column: holding.companyId,
    merge: { kind: 'custom', handler: 'holdings' }, // one per company: collapse
    del: {
      kind: 'block',
      reason:
        'the holding anchors investments, marks and distributions the registry cannot see, and portfolio history is append-only (D12)',
    },
    context: { role: 'item', kind: 'event', hop: 0 },
  },
  {
    key: 'round.company',
    table: round,
    column: round.companyId,
    merge: { kind: 'repoint' },
    del: {
      kind: 'block',
      reason:
        'a round anchors co-investor and investment rows the registry cannot see',
    },
    context: { role: 'item', kind: 'event', hop: 0 },
  },
  {
    key: 'round_co_investor.investor',
    table: roundCoInvestor,
    column: roundCoInvestor.investorEntityId,
    merge: { kind: 'repoint-or-drop', uniqueWith: [roundCoInvestor.roundId] },
    del: { kind: 'cascade' },
    context: { role: 'traverse', hop: 1 }, // investor ↔ round ↔ company
  },
  {
    key: 'investment.deal',
    table: investment,
    column: investment.dealId,
    merge: { kind: 'repoint' }, // deals are not mergeable today; still correct
    del: {
      kind: 'orphan',
      why: 'deal_id is nullable and the check is ledger history: the investment outlives the deal it came from (D12)',
    },
    context: { role: 'item', kind: 'event', hop: 0 },
  },

  // --- research kinds (one step removed via a side-table PK) -------------
  {
    // Was `document_chunk.document` (merge `none`) until SPA-102 widened the
    // table: a chunk now points at a document, a note, or the record whose
    // attribute was chunked (a deal's `close_reason`). Notes and documents
    // are not mergeable but records are, so the rows must follow the record.
    // `custom` since SPA-132 started writing attribute chunks: the unique
    // index is on (entity_id, source_kind, source_key, idx), so a winner
    // already holding chunks of the same source would collide with a plain
    // repoint. The section in merge.ts takes the values rule — the winner
    // keeps its value, the loser only fills a gap — per source: a source the
    // winner already has chunks for drops the loser's; any other source's
    // chunks move, matching the value the merge filled in with them.
    key: 'chunk.entity',
    table: chunk,
    column: chunk.entityId,
    merge: { kind: 'custom', handler: 'chunks' },
    del: { kind: 'cascade' },
    // One kind per column: a document's chunks are `doc_chunk` items one hop
    // out (record → filed document → chunk), the only source written today.
    // Note and attribute chunks render as their source's own kind (`note`,
    // `attribute`) — see ContextKind above.
    context: { role: 'item', kind: 'doc_chunk', hop: 1 },
  },
  {
    key: 'mandate.note',
    table: mandate,
    column: mandate.noteEntityId,
    merge: { kind: 'none', why: 'note kind is not mergeable' },
    del: {
      kind: 'block',
      reason:
        'mandate.note is the fund’s standing strategy prose; the mandate would point at nothing (owner, 2026-09-19)',
    },
    context: { role: 'item', kind: 'mandate', hop: 'standing' },
  },
  {
    key: 'term.space',
    table: term,
    column: term.spaceId,
    merge: { kind: 'none', why: 'space kind is not mergeable' },
    del: {
      kind: 'block',
      reason:
        'a scoped term nulled to global would assert its definition in every other space — the collision the scoping exists to prevent',
    },
    context: { role: 'item', kind: 'glossary', hop: 'standing' },
  },

  // --- resolution bookkeeping --------------------------------------------
  {
    key: 'duplicate_candidate.a',
    table: duplicateCandidate,
    column: duplicateCandidate.entityA,
    merge: { kind: 'custom', handler: 'candidates' }, // drop + re-pair
    del: { kind: 'cascade' },
    context: null,
  },
  {
    key: 'duplicate_candidate.b',
    table: duplicateCandidate,
    column: duplicateCandidate.entityB,
    merge: { kind: 'custom', handler: 'candidates' },
    del: { kind: 'cascade' },
    context: null,
  },
  {
    key: 'merge_event.winner',
    table: mergeEvent,
    column: mergeEvent.winnerId,
    merge: { kind: 'none', why: 'audit log; ids are historical by design' },
    del: {
      kind: 'block',
      reason:
        'named in merge history; history is information (same principle as the ledger, D12)',
    },
    context: null,
  },
  {
    key: 'merge_event.loser',
    table: mergeEvent,
    column: mergeEvent.loserId,
    merge: { kind: 'none', why: 'audit log; ids are historical by design' },
    del: {
      kind: 'block',
      reason:
        'named in merge history; history is information (same principle as the ledger, D12)',
    },
    context: null,
  },

  // --- the attempt ledger -------------------------------------------------
  {
    key: 'job_run.entity',
    table: jobRun,
    column: jobRun.entityId,
    merge: { kind: 'repoint' }, // the runs were about the record, not the row
    context: null, // an attempt ledger is operator-facing, never AI-visible
    del: { kind: 'cascade' }, // a run about a deleted entity goes with it
  },

  // --- the AI run log -----------------------------------------------------
  {
    key: 'ai_run.entity',
    table: aiRun,
    column: aiRun.entityId,
    merge: { kind: 'repoint' }, // the run was about the record: follow the survivor
    del: {
      kind: 'orphan',
      why: 'a run is spend and provenance history: its ai_usage rows cite it and the tokens were paid whether or not the record survives',
    },
    context: null, // the run log is operator-facing, never AI-visible
  },

  // --- staged import -------------------------------------------------------
  {
    key: 'import_row.entity',
    table: importRow,
    column: importRow.entityId,
    merge: { kind: 'repoint' }, // the row wrote or matched the record: follow the survivor
    del: {
      kind: 'orphan',
      why: 'a staging row is the record of what an import did; it outlives the record it wrote, as the batch it belongs to does',
    },
    context: null, // a staging row is bookkeeping and never enters a prompt
  },
]
