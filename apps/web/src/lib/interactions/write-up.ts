import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interaction, interactionEntity, link } from '@spaces/db/schema'
import { deleteEntityProgram } from '#/lib/entities/delete'
import { NoteCreateFailed } from '#/lib/notes/create'
import { stamp } from '#/lib/timeline/stamp'
import { AttendeeNotFound, InteractionLogFailed, writeUpNote } from './log'

/**
 * Writing up an interaction that was logged without a body (SPA-128).
 *
 * `interaction.note_id` is nullable and lazily filled (CONTEXT.md →
 * "Interactions and enrichment"; SPA-123): the twenty-second "Log call" path
 * leaves it null, every row synced from a calendar or a mailbox has it null,
 * and the common case is writing the call up that evening. This is that
 * second door — the same note, born the same way, just later.
 *
 * **Idempotent by contract.** An interaction that already has a body gets
 * that body back; nothing is created, nothing is moved. The two calls the
 * "write up" affordance can make between one render and the next therefore
 * land in the same editor.
 *
 * Deliberately no backfill job. A note manufactured for every historical
 * interaction is exactly the empty-note problem SPA-123 refused to create;
 * a meeting stays bodyless until someone writes the body.
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

const KIND_LABEL: Record<(typeof interaction.kind.enumValues)[number], string> =
  {
    email: 'Email',
    meeting: 'Meeting',
    call: 'Call',
  }

/**
 * The note's name at birth. `interaction.subject` is nullable — a synced row
 * may carry no subject at all, and "Untitled" for a meeting whose kind and
 * hour are both known is a worse answer than saying them. The date format is
 * the ledger's own `stamp`, so the note's name and the timeline row it was
 * written from print the same instant the same way.
 */
export function writeUpTitle(
  kind: (typeof interaction.kind.enumValues)[number],
  subject: string | null,
  occurredAt: Date,
): string {
  const named = subject?.trim()
  return named
    ? named
    : `${KIND_LABEL[kind]} · ${stamp(occurredAt.toISOString())}`
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InteractionLogFailed({ cause }),
  })

/**
 * `23505` anywhere in the cause chain naming `interaction_note_unique` —
 * drizzle wraps the driver error, so the pg fields are a level down. Same
 * walk as `entities/resolve.ts`'s `isUniqueViolation`, narrowed to the one
 * index that can refuse this write.
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
    // one. This is the whole of the "open note" case, and the cheap half of
    // the race — the expensive half is below.
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
     * The claim, and the race.
     *
     * Note-first for the reason SPA-123 is note-first: the failure it leaves
     * is a note the author can see and delete, where interaction-first would
     * leave a silently body-less meeting. The cost is that two concurrent
     * calls have each already made a body by the time either claims one, so
     * the claim has to be the thing that decides.
     *
     * `where id = … and note_id is null` is what decides it. Under READ
     * COMMITTED the second UPDATE blocks on the row lock, re-evaluates the
     * predicate after the winner commits, and matches nothing — so exactly
     * one call comes back with a row. `interaction_note_unique` is the
     * backstop behind that guard, not the guard itself: it constrains one
     * body to one interaction, and two write-ups of the *same* interaction
     * carry two distinct new note ids, which is a lost update rather than a
     * uniqueness violation. Both are caught here and both mean the same
     * thing — someone else got there first — so both answer `null`.
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
