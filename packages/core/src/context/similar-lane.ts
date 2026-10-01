import { Context, Effect, Layer } from 'effect'
import type { ContextQueryFailed } from './errors'
import type { Candidate } from './rank'

/**
 * The assembler's one seam to the AI substrate (SPA-182, D58). The context
 * assembler lives in core (`writes/context/assemble.ts`, `record.ts`); the
 * judgment-memory lane does not — it reads the embedding pin and searches
 * pgvector, and both belong to apps/web's ~1,400-line embedding substrate,
 * which SPA-179 declined to move. So the assembler asks for the lane as a
 * service and the caller provides it, the same tag + Layer pattern the
 * plugin ports use (`packages/sdk/src/ports.ts`, sdk-5): one pattern, not
 * two. The live Layer is `SimilarLaneLive` in `apps/web/src/lib/ai/similar.ts`;
 * a test provides {@link SimilarLaneEmpty} or a stub of its own.
 *
 * Narrow on purpose — two reads, not a wide assembler service:
 *
 * - `candidates(input)` — the lane's items for the anchor set, nearest
 *   first, before the assembler's dedupe against its other lanes and its
 *   {@link SIMILAR_TOP_N} cut. Empty with no pin, no anchor, no neighbour.
 * - `pinned()` — whether an embedding model is pinned, which is all
 *   `recordContextProgram` needs to know to offer the mode at all.
 *
 * The key is stable like a port's: the Layer finds the tag by it.
 */

/**
 * How many sideways items one assembly takes. A **first guess to tune on
 * real data** (the hitl half of SPA-139): five items is a paragraph of
 * precedent, not a report. The assembler applies it, after its dedupe; the
 * lane's reach (`SIMILAR_MAX_DISTANCE`) is the live implementation's.
 */
export const SIMILAR_TOP_N = 5

export type SimilarInput = {
  userId: string
  /** The seed and, for a company, the deals linked to it. */
  anchorIds: ReadonlyArray<string>
}

export type SimilarCandidate = Candidate & {
  /** The note row behind a note item, for the assembler's output invariant. */
  noteRow: { entityId: string; visibility: string; authorId: string } | null
}

export class SimilarLane extends Context.Service<
  SimilarLane,
  {
    readonly candidates: (
      input: SimilarInput,
    ) => Effect.Effect<Array<SimilarCandidate>, ContextQueryFailed>
    readonly pinned: () => Effect.Effect<boolean, ContextQueryFailed>
  }
>()('spaces/core/context/SimilarLane') {}

/**
 * The lane with nothing in it: no pin, no candidates — what the live Layer
 * answers on an install that never pinned a model. The stub the assembler's
 * own tests run on, and any caller's that does not exercise the mode.
 */
export const SimilarLaneEmpty: Layer.Layer<SimilarLane> = Layer.succeed(
  SimilarLane,
  SimilarLane.of({
    candidates: () => Effect.succeed([]),
    pinned: () => Effect.succeed(false),
  }),
)
