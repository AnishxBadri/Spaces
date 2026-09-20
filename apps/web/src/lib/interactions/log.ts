import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, interaction, interactionEntity, link } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { NoteCreateFailed, createNoteProgram } from '#/lib/notes/create'

/**
 * Manual interaction logging (SPA-123), Effect-first behind `effectFn` per
 * the ratchet — the conversion of `writeInteraction`, which used to live in
 * `server/shared.ts` and is now this program.
 *
 * Out here rather than in `server/interactions.ts` for the reason
 * `lib/timeline/record.ts` and `lib/notes/create.ts` are out here:
 * `src/lib/server-fns.ts` re-exports every `server/*` module wholesale to the
 * client (CLAUDE.md → Traps), so an exported Effect program in that folder
 * would drag Effect and the pg client into the browser bundle.
 *
 * **The write-up is a real note, not a body column.** `interaction` never
 * carried prose (CONTEXT.md → "Interactions and enrichment", decided
 * 2026-09-14): the structured event keeps kind, occurred_at and the attendee
 * edges, and `interaction.note_id` points at a `note` row filed against the
 * same records. One editor, one mention system, one search index.
 *
 * Two paths, and the difference is one boolean:
 *
 * - **Log** — the twenty-second path. `note_id` stays null and no note row is
 *   written, because a call nobody wrote up should not leave an empty note
 *   behind for the notes list to carry forever.
 * - **Log and write up** — the note is born first, through
 *   `createNoteProgram`, so the row, its `note.created` activity and the
 *   first attendee's `link(tagged_in, manual)` all come from the one door;
 *   the interaction transaction then files it against the remaining
 *   attendees and claims it with `note_id`. Note-first because the failure it
 *   leaves is visible — a note the author can delete — where
 *   interaction-first would leave a silently body-less meeting.
 */

/** The interaction (or its edges) could not be written. */
export class InteractionLogFailed extends Schema.TaggedError<InteractionLogFailed>()(
  'InteractionLogFailed',
  { cause: Schema.Defect() },
) {}

/** The attendee list named a record that is not there. */
export class AttendeeNotFound extends Schema.TaggedError<AttendeeNotFound>()(
  'AttendeeNotFound',
  { id: Schema.String },
) {}

export type InteractionLogFailure =
  InteractionLogFailed | AttendeeNotFound | NoteCreateFailed

export type LogInteractionInput = {
  kind: 'meeting' | 'call'
  subject: string
  occurredAt: Date
  attendeeIds: Array<string>
  /** Write the body note now, and hand back its id so the caller can land in it. */
  writeUp: boolean
}

/** `noteId` is null exactly when the caller did not ask for a write-up. */
export type LoggedInteraction = { id: string; noteId: string | null }

/**
 * The sentence the client is shown. `Effect.runPromise` rejects with the
 * typed failure itself and a `Schema.TaggedError` carries no `message`, so
 * without this the dialog would get an empty string.
 */
export function interactionLogMessage(failure: unknown): string {
  if (failure instanceof AttendeeNotFound)
    return 'One of the attendees no longer exists'
  if (failure instanceof NoteCreateFailed)
    return 'Logged nothing: the write-up could not be created'
  return 'Could not log it'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InteractionLogFailed({ cause }),
  })

/**
 * The write-up, born before the interaction that claims it. The seed is the
 * first attendee, which is the one filing `createNoteProgram` itself writes;
 * the rest are added by the interaction's own transaction.
 */
const writeUpNote = Effect.fn('writeUpNote')(function* (
  actorId: string,
  title: string,
  seed: string,
): Effect.fn.Return<
  string,
  InteractionLogFailed | AttendeeNotFound | NoteCreateFailed
> {
  const about = (yield* query(() =>
    db
      .select({ name: entity.canonicalName, kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, seed)),
  )).at(0)
  if (!about) return yield* new AttendeeNotFound({ id: seed })

  // `starter: false` — the attendees are filed, not mentioned. A starter
  // block would drag a `link(mentions, extracted)` along and put the
  // write-up in both lanes of the record's Notes section for a sentence
  // nobody wrote.
  const created = yield* createNoteProgram(actorId, {
    about: {
      entityId: seed,
      label: about.name,
      kind: about.kind,
      objectSlug: '',
    },
    noteKind: 'note',
    title,
    starter: false,
  })
  return created.id
})

export const logInteractionProgram = Effect.fn('logInteractionProgram')(
  function* (
    actorId: string,
    input: LogInteractionInput,
  ): Effect.fn.Return<LoggedInteraction, InteractionLogFailure> {
    // Deduped once, here: the attendee list is what the activity row, the
    // edge table and the note's filings are all derived from, so they cannot
    // disagree about who was in the room.
    const attendeeIds = [...new Set(input.attendeeIds)]
    const seed = attendeeIds.at(0)
    if (!seed) {
      return yield* new InteractionLogFailed({
        cause: new Error('an interaction needs at least one attendee'),
      })
    }

    const bodyId = input.writeUp
      ? yield* writeUpNote(actorId, input.subject, seed)
      : null

    return yield* query(() =>
      db.transaction(async (tx) => {
        const row = (
          await tx
            .insert(interaction)
            .values({
              kind: input.kind,
              // Written as a literal, not left to the column default: a
              // person filling in the Log-interaction dialog is the clearest
              // `manual` writer in the product, and a row whose provenance is
              // whatever the default happened to be is not a claim anyone
              // checked.
              sourceClass: 'manual',
              subject: input.subject,
              occurredAt: input.occurredAt,
              noteId: bodyId,
            })
            .returning({ id: interaction.id })
        ).at(0)
        if (!row) throw new Error('interaction insert returned no row')

        for (const entityId of attendeeIds) {
          await tx
            .insert(interactionEntity)
            .values({ interactionId: row.id, entityId })
            .onConflictDoNothing()
          // The write-up is filed against everyone who was in the room, with
          // the stamp `createNoteProgram` uses — the seed's row is already
          // there from that call, so its insert is the no-op the unique edge
          // index makes it.
          if (bodyId) {
            await tx
              .insert(link)
              .values({
                fromEntityId: bodyId,
                toEntityId: entityId,
                relation: 'tagged_in',
                source: 'manual',
                createdBy: actorId,
              })
              .onConflictDoNothing()
          }
        }

        await tx.insert(activity).values({
          actorId,
          verb: `interaction.${input.kind}`,
          subjectEntityId: seed,
          meta: { interactionId: row.id },
        })

        return { id: row.id, noteId: bodyId }
      }),
    )
  },
)
