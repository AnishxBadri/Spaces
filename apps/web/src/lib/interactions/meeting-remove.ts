import { Effect, Schema } from 'effect'
import { and, count, eq, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interaction, meetingRemoval, suggestion } from '@spaces/db/schema'
import { ref } from '@spaces/core/context/ref'
import { removeInteractions } from '@spaces/core/writes/interactions/remove'
import { seriesUidOf } from '#/lib/meetings/removal'
import type { MeetingRemoval } from '#/lib/meetings/removal'
import {
  MeetingNotFound,
  MeetingReadFailed,
  attendsMeetingProgram,
} from './meeting-read'
import type { MeetingReader } from './meeting-read'

/**
 * `Remove from Spaces…`: a calendar meeting, or its whole series, taken out
 * of Spaces and remembered, so the next sync does not bring it back. It stays
 * in Google Calendar.
 * - Offered to the meeting's attendees (the `Mine` rule) and to admins.
 * - What it leaves stays: the people it created, its write-up and its other
 *   notes (each an ordinary note from then on), and the tasks accepted from
 *   its action items. Only the meeting rows and their edges go, through
 *   `removeInteractions`, in the transaction that writes the memory.
 */

/** Who asks: the `Mine` rule's reader, and their role for the admin's say. */
export type MeetingRemover = MeetingReader & { role: string }

/** The reader is neither in the meeting nor an admin. */
export class MeetingRemoveForbidden extends Schema.TaggedError<MeetingRemoveForbidden>()(
  'MeetingRemoveForbidden',
  { id: Schema.String },
) {}

/** The sentence a client is shown for a refused or failed remove. */
export function removeMessage(failure: unknown): string {
  if (failure instanceof MeetingNotFound)
    return 'That meeting is no longer there'
  if (failure instanceof MeetingRemoveForbidden)
    return 'Only the people in this meeting, or an admin, can remove it'
  return 'Could not remove the meeting'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MeetingReadFailed({ cause }),
  })

/** A calendar meeting by id: its key and whether it is one of a series. */
const calendarMeeting = (id: string) =>
  query(() =>
    db
      .select({
        uid: interaction.messageId,
        sourceClass: interaction.sourceClass,
        meta: interaction.meta,
      })
      .from(interaction)
      .where(and(eq(interaction.id, id), eq(interaction.kind, 'meeting'))),
  ).pipe(
    Effect.map((rows) => {
      const row = rows.at(0)
      // A meeting logged by hand has no calendar to come back from.
      if (
        row === undefined ||
        row.uid === null ||
        row.sourceClass !== 'integration' ||
        row.meta?.kind !== 'meeting'
      )
        return null
      return { uid: row.uid, series: row.meta.recurring_instance_id !== null }
    }),
  )

const mayRemove = (reader: MeetingRemover, id: string) =>
  reader.role === 'admin'
    ? Effect.succeed(true)
    : attendsMeetingProgram(reader, id)

/**
 * What the sheet's `Remove from Spaces…` needs: whether it is one of a
 * series and how many tasks came from it; null when it is not the reader's
 * to remove, or not a calendar meeting.
 */
export const meetingRemovalProgram = Effect.fn('meetingRemovalProgram')(
  function* (
    reader: MeetingRemover,
    id: string,
  ): Effect.fn.Return<MeetingRemoval | null, MeetingReadFailed> {
    const meeting = yield* calendarMeeting(id)
    if (meeting === null || !(yield* mayRemove(reader, id))) return null
    const tasks = yield* query(() =>
      db
        .select({ n: count() })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.kind, 'task'),
            eq(suggestion.status, 'accepted'),
            sql`${suggestion.refs} @> array[${ref.interaction(id)}]::text[]`,
          ),
        ),
    )
    return { series: meeting.series, tasks: tasks.at(0)?.n ?? 0 }
  },
)

/**
 * Removes the meeting `id`, or with `series` every held occurrence of its
 * series, and remembers the key so no sync births it, or any occurrence to
 * come, again. Answers how many meeting rows went.
 */
export const removeMeetingProgram = Effect.fn('removeMeetingProgram')(
  function* (
    reader: MeetingRemover,
    id: string,
    scope: 'meeting' | 'series',
  ): Effect.fn.Return<
    { removed: number },
    MeetingReadFailed | MeetingNotFound | MeetingRemoveForbidden
  > {
    const meeting = yield* calendarMeeting(id)
    if (meeting === null) return yield* new MeetingNotFound({ id })
    if (!(yield* mayRemove(reader, id)))
      return yield* new MeetingRemoveForbidden({ id })
    const series = scope === 'series' && meeting.series
    const key = series ? seriesUidOf(meeting.uid) : meeting.uid
    return yield* query(() =>
      db.transaction(async (tx) => {
        await tx
          .insert(meetingRemoval)
          .values({ uid: key, series, removedBy: reader.id })
          .onConflictDoUpdate({
            target: meetingRemoval.uid,
            // A key once removed as a series stays one.
            set: {
              series: sql`${meetingRemoval.series} or excluded.series`,
              removedBy: reader.id,
              removedAt: new Date(),
            },
          })
        const ids = series
          ? (
              await tx
                .select({ id: interaction.id })
                .from(interaction)
                .where(
                  and(
                    eq(interaction.kind, 'meeting'),
                    or(
                      eq(interaction.messageId, key),
                      sql`left(${interaction.messageId}, ${key.length + 1}) = ${`${key}#`}`,
                    ),
                  ),
                )
            ).map((r) => r.id)
          : [id]
        // The notes `removeInteractions` hands back are left as they are:
        // a write-up outlives the meeting it was written about.
        const { removed } = await removeInteractions(tx, ids)
        return { removed }
      }),
    )
  },
)
