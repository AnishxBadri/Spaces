import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interaction, interactionEntity, link } from '@spaces/db/schema'
import { deleteEntityProgram } from '@spaces/core/writes/entities/delete'
import { writeUpTitle } from '@spaces/core/interactions/write-up-title'
import { NoteCreateFailed } from '#/lib/notes/create'
import { AttendeeNotFound, InteractionLogFailed, writeUpNote } from './log'

/**
 * Writing up an interaction logged without a body (a plain Log, or any
 * calendar or mailbox sync): the same note, born the same way, just later.
 * - Idempotent: an interaction that already has a body hands it back and
 *   nothing is created, so two calls between renders land in one editor.
 * - No backfill job: a note per historical interaction is the empty-note
 *   problem; a meeting stays bodyless until someone writes the body.
 */

/** The interaction is not there — deleted between render and click. */
export class InteractionNotFound extends Schema.TaggedError<InteractionNotFound>()(
  'InteractionNotFound',
  { id: Schema.String },
) {}

export type WriteUpFailure =
  | InteractionNotFound
  | InteractionLogFailed
  | AttendeeNotFound
  | NoteCreateFailed

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function writeUpMessage(failure: unknown): string {
  if (failure instanceof InteractionNotFound)
    return 'That interaction is no longer there'
  if (failure instanceof AttendeeNotFound)
    return 'One of the attendees no longer exists'
  if (failure instanceof NoteCreateFailed)
    return 'The write-up could not be created'
  return 'Could not write it up'
}

export { writeUpTitle }

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InteractionLogFailed({ cause }),
  })

/**
 * `23505` anywhere in the cause chain naming `interaction_note_unique` —
 * drizzle wraps the driver error, so the pg fields are a level down. Same
 * walk as resolve's `isUniqueViolation`, narrowed to the one index that can
 * refuse this write.
 */
function noteAlreadyClaimed(cause: unknown): boolean {
  let e: unknown = cause
  for (let depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    if (typeof e !== 'object') return false
    if (
      'code' in e &&
      e.code === '23505' &&
      'constraint' in e &&
      e.constraint === 'interaction_note_unique'
    )
      return true
    e = 'cause' in e ? e.cause : null
  }
  return false
}

export const writeUpInteractionProgram = Effect.fn('writeUpInteractionProgram')(
  function* (
    actorId: string,
    interactionId: string,
  ): Effect.fn.Return<{ noteId: string }, WriteUpFailure> {
    const row = (yield* query(() =>
      db
        .select({
          kind: interaction.kind,
          subject: interaction.subject,
          occurredAt: interaction.occurredAt,
          noteId: interaction.noteId,
        })
        .from(interaction)
        .where(eq(interaction.id, interactionId)),
    )).at(0)
    if (!row) return yield* new InteractionNotFound({ id: interactionId })
    // Already written up: hand back the body rather than forking a second
    // one. The cheap half of the race; the claim below is the other.
    if (row.noteId) return { noteId: row.noteId }

    // The attendee set is `interaction_entity` and nothing else: the note is
    // filed against exactly who was in the room. Ordered so the seed — the
    // one filing `createNoteProgram` writes itself — is not whatever the
    // heap handed back.
    const attendees = yield* query(() =>
      db
        .select({ entityId: interactionEntity.entityId })
        .from(interactionEntity)
        .where(eq(interactionEntity.interactionId, interactionId))
        .orderBy(asc(interactionEntity.entityId)),
    )
    const attendeeIds = attendees.map((a) => a.entityId)
    const seed = attendeeIds.at(0)
    if (!seed) {
      return yield* new InteractionLogFailed({
        cause: new Error('an interaction with no attendees cannot be filed'),
      })
    }

    const noteId = yield* writeUpNote(
      actorId,
      writeUpTitle(row.kind, row.subject, row.occurredAt),
      seed,
    )

    /**
     * The claim, and the race. Note-first, so a failure leaves a note the
     * author can delete, not a body-less meeting; two concurrent calls each
     * hold a body by now, so the claim decides.
     * - `where note_id is null` decides: under READ COMMITTED the loser's
     *   UPDATE re-evaluates after the winner commits and matches nothing.
     * - `interaction_note_unique` is only the backstop (two write-ups of one
     *   interaction are a lost update, not a violation). Either way someone
     *   else got there first, so both answer `null`.
     */
    const claimed = yield* query(() =>
      db
        .transaction(async (tx) => {
          const won = (
            await tx
              .update(interaction)
              .set({ noteId })
              .where(
                and(
                  eq(interaction.id, interactionId),
                  isNull(interaction.noteId),
                ),
              )
              .returning({ id: interaction.id })
          ).at(0)
          if (!won) return null

          // Filed against every attendee with the stamp `createNoteProgram`
          // uses — the seed's row is already there from that call, so its
          // insert is the no-op the unique edge index makes it.
          for (const entityId of attendeeIds) {
            await tx
              .insert(link)
              .values({
                fromEntityId: noteId,
                toEntityId: entityId,
                relation: 'tagged_in',
                source: 'manual',
                createdBy: actorId,
              })
              .onConflictDoNothing()
          }
          return noteId
        })
        .catch((cause: unknown) => {
          if (noteAlreadyClaimed(cause)) return null
          throw cause
        }),
    )
    if (claimed !== null) return { noteId: claimed }

    // Lost. Re-read the winner and take the body we made with us: a losing
    // note left behind is the empty-note row this whole design exists to
    // avoid, and it is filed against an attendee, so it would show up under
    // "Filed here" on their record.
    const winner = (yield* query(() =>
      db
        .select({ noteId: interaction.noteId })
        .from(interaction)
        .where(eq(interaction.id, interactionId)),
    )).at(0)?.noteId
    yield* Effect.catch(deleteEntityProgram(noteId), (failure) =>
      Effect.logWarning(
        `writeUpInteraction: the losing note ${noteId} could not be removed`,
        failure,
      ),
    )
    if (!winner) return yield* new InteractionNotFound({ id: interactionId })
    return { noteId: winner }
  },
)
