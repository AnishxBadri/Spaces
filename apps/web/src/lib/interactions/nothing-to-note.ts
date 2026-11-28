import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interaction } from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'

/**
 * `Nothing to note`: a member says a past meeting needs no write-up, so it
 * leaves the `No write-up` band and Today's Write-ups for everyone. The mark
 * is `MeetingMeta.nothing_to_note`; a meeting with no calendar metadata (a
 * logged call or meeting) cannot hold it and is refused.
 * - Any member may set it, as any member may pin a record to the meeting;
 *   it writes no History line, as pinning writes none.
 * - Answers the value it replaced, so Undo puts exactly that back.
 */

export class NothingToNoteFailed extends Schema.TaggedError<NothingToNoteFailed>()(
  'NothingToNoteFailed',
  { cause: Schema.Defect() },
) {}

/** The row is gone, or it is not a meeting that can hold the mark. */
export class NothingToNoteRefused extends Schema.TaggedError<NothingToNoteRefused>()(
  'NothingToNoteRefused',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function nothingToNoteMessage(failure: unknown): string {
  if (failure instanceof NothingToNoteRefused)
    return 'That meeting cannot be marked'
  return 'Could not mark the meeting'
}

export const setNothingToNoteProgram = Effect.fn('setNothingToNoteProgram')(
  function* (
    interactionId: string,
    on: boolean,
  ): Effect.fn.Return<
    { was: boolean },
    NothingToNoteFailed | NothingToNoteRefused
  > {
    const was = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // Locked: a calendar sync rewriting the meta meanwhile keeps the
          // mark, since it spreads what it finds.
          const row = (
            await tx
              .select({ meta: interaction.meta })
              .from(interaction)
              .where(eq(interaction.id, interactionId))
              .for('update')
          ).at(0)
          const meta = row?.meta?.kind === 'meeting' ? row.meta : null
          if (meta === null) return null
          const before = meta.nothing_to_note === true
          if (before !== on) {
            const next: MeetingMeta = { ...meta }
            if (on) next.nothing_to_note = true
            else delete next.nothing_to_note
            await tx
              .update(interaction)
              .set({ meta: next })
              .where(eq(interaction.id, interactionId))
          }
          return before
        }),
      catch: (cause) => new NothingToNoteFailed({ cause }),
    })
    if (was === null)
      return yield* new NothingToNoteRefused({ id: interactionId })
    return { was }
  },
)
