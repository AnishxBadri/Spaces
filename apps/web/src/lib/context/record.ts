import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { note } from '@spaces/db/schema'
import { readEmbeddingPinProgram } from '#/lib/ai/embedding-pin'
import { canRead } from '#/lib/notes/visibility'
import { ContextEntityNotFound, ContextQueryFailed } from './errors'
import { assembleProgram } from './assemble'
import type { ContextLeak } from './assemble'
import { resolveRefsProgram } from './names'
import type { ContextKind } from './types'

/**
 * The record page's Context section, as one program: assemble the record for
 * the requesting user, then label every item's ref for a person to read. The
 * clock and the budget are arguments — `getRecordContext` stamps them at the
 * server-fn boundary — so this stays as deterministic as the assembler is.
 *
 * It lives outside `lib/server/` so a test can run it without a request
 * (CLAUDE.md, SPA-155).
 */

export type RecordContextItem = {
  ref: string
  kind: ContextKind
  text: string
  at: string | null
  /** Human citation — `resolveRefsProgram` (`names.ts`) over `cite.ts`. */
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
   * never sends one; the MCP `get_context` tool passes its `task` (SPA-23).
   */
  taskText?: string | undefined
}

/** The Context section's default budget; the MCP tool's too (SPA-23). */
export const DEFAULT_BUDGET_CHARS = 8000

export const recordContextProgram = Effect.fn('recordContextProgram')(
  function* (
    input: RecordContextInput,
  ): Effect.fn.Return<
    RecordContext,
    ContextQueryFailed | ContextEntityNotFound | ContextLeak
  > {
    // A private note is its author's: asked for as the seed by anyone else,
    // it does not exist — not even its title leaves as the seed's name. The
    // assembler filters notes it reaches over a link; this is the one door
    // it does not walk through (SPA-23: a token asks by id).
    const seedNote = (yield* Effect.tryPromise({
      try: () =>
        db
          .select({ visibility: note.visibility, authorId: note.authorId })
          .from(note)
          .where(eq(note.entityId, input.entityId)),
      catch: (cause) => new ContextQueryFailed({ cause }),
    })).at(0)
    if (seedNote && !canRead(input.user, seedNote))
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
      },
    )
    // A pin that cannot be read only hides the toggle; the mode itself,
    // asked for, still fails loudly through the assembler.
    const pin = yield* readEmbeddingPinProgram().pipe(
      Effect.orElseSucceed(() => null),
    )
    const resolved = yield* resolveRefsProgram(result.items.map((i) => i.ref))
    const asOfMs = Date.parse(input.asOf)
    return {
      seed: result.seed,
      usedChars: result.usedChars,
      similarAvailable: pin !== null,
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
