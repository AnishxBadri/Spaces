import type { ContextHop, ContextKind } from '@spaces/db/entity-refs'

/**
 * The context contract. Pure types, no drizzle or server imports, so the
 * ranker and the registry can both depend on them.
 * `ContextKind` and `ContextHop` live in `@spaces/db/entity-refs` because every
 * `ENTITY_REFS` entry declares the kind and hop its column contributes.
 */
export type { ContextHop, ContextKind }

/**
 * Where an assembled item sits: a hop from the seed, a standing source, or
 * `similar`, the lane that reaches sideways to other records' close_reasons
 * and terminal-stage notes by embedding distance. Not in `ContextHop`: that
 * is the registry's, and no column contributes a sideways item.
 */
export type AssembledHop = ContextHop | 'similar'

/** How an item at hop ≥ 1 was reached; modulates the hop weight. */
export type ContextEdge =
  | 'references'
  | 'tagged_in'
  | 'mentions'
  | 'derived_from'
  | 'supersedes'
  | 'space'
  | 'co_investor'
  /** Another company filed in the seed's leaf space. */
  | 'peer'

/** One canonical, model-agnostic shape for everything AI-visible. */
export type ContextItem = {
  /** Stable citation id, in the `ref` grammar. */
  ref: string
  kind: ContextKind
  /** Plain-text rendering. Text is the interchange, not embeddings. */
  text: string
  /** What it is about. */
  entityIds: ReadonlyArray<string>
  /** When it was true (ISO 8601), null for timeless facts. */
  at: string | null
}
