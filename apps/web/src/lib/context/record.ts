import { Effect } from 'effect'
import { assembleProgram } from './assemble'
import type {
  ContextEntityNotFound,
  ContextLeak,
  ContextQueryFailed,
} from './assemble'
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
}

export type RecordContext = {
  seed: { id: string; kind: string; name: string }
  items: Array<RecordContextItem>
  usedChars: number
}

export type RecordContextInput = {
  entityId: string
  user: { id: string }
  /** ISO 8601 — the only clock. */
  asOf: string
  budgetChars: number
}

export const recordContextProgram = Effect.fn('recordContextProgram')(
  function* (
    input: RecordContextInput,
  ): Effect.fn.Return<
    RecordContext,
    ContextQueryFailed | ContextEntityNotFound | ContextLeak
  > {
    const result = yield* assembleProgram(
      { entityId: input.entityId },
      { user: input.user, asOf: input.asOf, budgetChars: input.budgetChars },
    )
    const resolved = yield* resolveRefsProgram(result.items.map((i) => i.ref))
    const asOfMs = Date.parse(input.asOf)
    return {
      seed: result.seed,
      usedChars: result.usedChars,
      items: result.items.map((i, n) => {
        const atMs = i.at === null ? Number.NaN : Date.parse(i.at)
        return {
          ref: i.ref,
          kind: i.kind,
          text: i.text,
          at: i.at,
          cite: resolved[n].label,
          sinceMs: Number.isNaN(atMs) ? null : Math.max(0, asOfMs - atMs),
        }
      }),
    }
  },
)
