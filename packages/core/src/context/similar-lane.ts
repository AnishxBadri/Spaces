import { Context, Effect, Layer } from 'effect'
import type { ContextQueryFailed } from './errors'
import type { Candidate } from './rank'

/**
 * The assembler's one seam to the embedding substrate, which stays in apps/web:
 * the assembler asks for the similar lane as a service, same tag + Layer
 * pattern as the plugin ports. Live Layer: `SimilarLaneLive`; tests use
 * {@link SimilarLaneEmpty} or a stub.
 *
 * - `candidates(input)`: the lane's items for the anchors, nearest first,
 *   before the assembler's dedupe and {@link SIMILAR_TOP_N} cut. Empty with
 *   no pin, anchor or neighbour.
 * - `pinned()`: whether an embedding model is pinned, which is all
 *   `recordContextProgram` needs to offer the mode.
 *
 * The key is stable like a port's: the Layer finds the tag by it.
 */

/**
 * Similar items per assembly. A first guess; tune against real data. The
 * assembler applies it after its dedupe; the lane's reach
 * (`SIMILAR_MAX_DISTANCE`) belongs to the live implementation.
 */
export const SIMILAR_TOP_N = 5

export type SimilarInput = {
  userId: string
  /** The seed and, for a company, the deals linked to it. */
  anchorIds: ReadonlyArray<string>
  /** Leave out chunks stamped sensitive — `AssembleOptions.excludeSensitive`. */
  excludeSensitive?: boolean
}

export type SimilarCandidate = Candidate & {
  /** The note row behind a note item, for the assembler's output invariant. */
  noteRow: {
    entityId: string
    visibility: string
    authorId: string
    /** As `canRead` takes it: an email body widened to the asker. */
    widened: boolean
  } | null
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
