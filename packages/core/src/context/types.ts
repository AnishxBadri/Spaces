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

/**
 * Where an assembled item sits: a hop from the seed, a standing source, or
 * `similar` — the judgment-memory lane (SPA-139), which does not walk out
 * from the seed at all but reaches sideways to other records' close_reasons
 * and terminal-stage notes by embedding distance. Kept out of `ContextHop`
 * on purpose: that type is the registry's (`ENTITY_REFS` declares the hop a
 * column contributes), and no column contributes a sideways item.
 */
export type AssembledHop = ContextHop | 'similar'

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
