import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, note } from '@spaces/db/schema'
import { canRead } from '../../read-policy'
import { documentWidenedSql, noteWidenedSql } from '../read/can-read-sql'
import { ContextEntityNotFound, ContextQueryFailed } from '../../context/errors'
import type { ContextLeak } from '../../context/errors'
import { SimilarLane } from '../../context/similar-lane'
import type { ContextKind } from '../../context/types'
import { assembleProgram } from './assemble'
import { resolveRefsProgram } from './names'

/**
 * The record page's Context section, as one program: assemble the record for
 * the requesting user, then label every item's ref for a person to read. The
 * clock and the budget are arguments — the caller stamps them at its
 * boundary — so this stays as deterministic as the assembler is.
 * Declares the `SimilarLane` service rather than importing the embedding
 * substrate: `similarAvailable` is the lane's `pinned()`.
 */

export type RecordContextItem = {
  ref: string
  kind: ContextKind
  text: string
  at: string | null
  /** Human citation — `resolveRefsProgram` over `cite`. */
  cite: string
  /** `asOf − at`, for `formatSince`; null for a timeless fact. */
  sinceMs: number | null
  /** From the judgment-memory lane: another record's, not this one's. */
  similar: boolean
}

export type RecordContext = {
  seed: { id: string; kind: string; name: string }
  items: Array<RecordContextItem>
  usedChars: number
  /** Something assembled is sensitive — `AssembleResult.sensitive`. */
  sensitive: boolean
  /** Every entity the context is about, for an egress gate. */
  reveals: ReadonlyArray<string>
  /**
   * Whether the judgment-memory mode can say anything: an embedding model is
   * pinned. The readout shows its toggle only when this is true.
   */
  similarAvailable: boolean
}

export type RecordContextInput = {
  entityId: string
  user: { id: string }
  /** ISO 8601 — the only clock. */
  asOf: string
  budgetChars: number
  /** The judgment-memory mode — `AssembleOptions.similar`. */
  similar?: boolean | undefined
  /**
   * Task text — `AssembleOptions.taskText`, the lexical lane. The record page
   * never sends one; the MCP `get_context` tool passes its `task`.
   */
  taskText?: string | undefined
  /** `AssembleOptions.excludeSensitive`: set by an AI caller on a non-local route. */
  excludeSensitive?: boolean | undefined
}

/** The Context section's default budget; the MCP tool's too. */
export const DEFAULT_BUDGET_CHARS = 8000

export const recordContextProgram = Effect.fn('recordContextProgram')(
  function* (
    input: RecordContextInput,
  ): Effect.fn.Return<
    RecordContext,
    ContextQueryFailed | ContextEntityNotFound | ContextLeak,
    SimilarLane
  > {
    // A private note or document is its author's: asked for as the seed by
    // anyone else, it does not exist — not even its title leaves as the
    // seed's name. The assembler filters what it reaches over a link; this
    // is the one door it does not walk through (a token asks by id).
    const gates = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          db
            .select({
              visibility: note.visibility,
              authorId: note.authorId,
              widened: noteWidenedSql(input.user.id),
            })
            .from(note)
            .where(eq(note.entityId, input.entityId)),
          db
            .select({
              visibility: document.visibility,
              authorId: document.authorId,
              widened: documentWidenedSql(input.user.id),
            })
            .from(document)
            .where(eq(document.entityId, input.entityId)),
        ]),
      catch: (cause) => new ContextQueryFailed({ cause }),
    })
    if (gates.flat().some((row) => !canRead(input.user, row)))
      return yield* new ContextEntityNotFound({
        id: input.entityId,
        message: 'Record not found',
      })
    const result = yield* assembleProgram(
      { entityId: input.entityId },
      {
        user: input.user,
        asOf: input.asOf,
        budgetChars: input.budgetChars,
        similar: input.similar,
        taskText: input.taskText,
        excludeSensitive: input.excludeSensitive,
      },
    )
    // A pin that cannot be read only hides the toggle; the mode itself,
    // asked for, still fails loudly through the assembler.
    const lane = yield* SimilarLane
    const similarAvailable = yield* lane
      .pinned()
      .pipe(Effect.orElseSucceed(() => false))
    const resolved = yield* resolveRefsProgram(result.items.map((i) => i.ref))
    const asOfMs = Date.parse(input.asOf)
    return {
      seed: result.seed,
      usedChars: result.usedChars,
      sensitive: result.sensitive,
      reveals: result.reveals,
      similarAvailable,
      items: result.items.map((i, n) => {
        const atMs = i.at === null ? Number.NaN : Date.parse(i.at)
        return {
          ref: i.ref,
          kind: i.kind,
          text: i.text,
          at: i.at,
          cite: resolved[n].label,
          sinceMs: Number.isNaN(atMs) ? null : Math.max(0, asOfMs - atMs),
          similar: i.hop === 'similar',
        }
      }),
    }
  },
)
