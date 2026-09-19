/**
 * The context contract (docs/spec-ai-substrate.md §1). Pure types — no
 * drizzle, no server imports — so the ranker and the registry can both
 * depend on them.
 */

/**
 * ContextItem kinds. The spec's seven plus `interaction` and `task`: both
 * are citation targets and neither is an entity (decided 2026-09-09).
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

/** How an item at hop ≥ 1 was reached; modulates the hop weight. */
export type ContextEdge =
  | 'references'
  | 'tagged_in'
  | 'mentions'
  | 'contact_at'
  | 'derived_from'
  | 'supersedes'
  | 'space'
  | 'co_investor'

/** One canonical, model-agnostic shape for everything AI-visible. */
export type ContextItem = {
  /** Stable citation id — see `ref.ts`. */
  ref: string
  kind: ContextKind
  /** Plain-text rendering. Text is the interchange, not embeddings. */
  text: string
  /** What it is about. */
  entityIds: ReadonlyArray<string>
  /** When it was true (ISO 8601), null for timeless facts. */
  at: string | null
}
