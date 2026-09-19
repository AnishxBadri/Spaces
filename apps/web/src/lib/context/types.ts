import type { ContextHop, ContextKind } from '@spaces/db/entity-refs'

/**
 * The context contract (docs/spec-ai-substrate.md §1). Pure types — no
 * drizzle, no server imports — so the ranker and the registry can both
 * depend on them.
 *
 * `ContextKind` and `ContextHop` are the two the registry speaks: every
 * ENTITY_REFS entry declares the kind and hop its column contributes, so
 * they are declared in `@spaces/db/entity-refs` and re-exported here
 * unchanged (SPA-142). Both move to core with the rest of this file at
 * mono-9a.
 */
export type { ContextHop, ContextKind }

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
