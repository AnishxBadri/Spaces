import { Effect, Schema } from 'effect'
import { and, eq, exists, inArray, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  entity,
  integration,
  interaction,
  interactionNote,
  note,
} from '@spaces/db/schema'
import { integrationName } from '@spaces/core/plugins/name'
import type { NoteVia } from './via-mark'

/**
 * The "via <tool> · <author>" mark on a note a person filed from their tool:
 * read from the note's provenance, never stored.
 * - A note marks when an integration wrote it (`entity.source_ref`) and a
 *   meeting or call carries it, as write-up or second note. An email's body
 *   is integration-written too but is mail, not a filed note.
 * - A hand-written note and an Ask answer saved as a note carry no mark.
 */

export class NoteViaReadFailed extends Schema.TaggedError<NoteViaReadFailed>()(
  'NoteViaReadFailed',
  { cause: Schema.Defect() },
) {}

/** Each of `noteIds` that carries the mark, with its tool and author. */
export const notesViaProgram = Effect.fn('notesVia')(function* (
  noteIds: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, NoteVia>, NoteViaReadFailed> {
  if (noteIds.length === 0) return new Map()
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: note.entityId,
          author: user.name,
          capabilityId: integration.capabilityId,
          manifest: integration.manifest,
        })
        .from(note)
        .innerJoin(entity, eq(entity.id, note.entityId))
        .innerJoin(integration, eq(integration.id, entity.sourceRef))
        .innerJoin(user, eq(user.id, note.authorId))
        .where(
          and(
            inArray(note.entityId, [...new Set(noteIds)]),
            eq(entity.sourceClass, 'integration'),
            or(
              exists(
                db
                  .select({ id: interaction.id })
                  .from(interaction)
                  .where(
                    and(
                      eq(interaction.noteId, note.entityId),
                      inArray(interaction.kind, ['meeting', 'call']),
                    ),
                  ),
              ),
              exists(
                db
                  .select({ id: interactionNote.noteId })
                  .from(interactionNote)
                  .where(eq(interactionNote.noteId, note.entityId)),
              ),
            ),
          ),
        ),
    catch: (cause) => new NoteViaReadFailed({ cause }),
  })
  return new Map(
    rows.map((r) => [r.id, { tool: integrationName(r), author: r.author }]),
  )
})

/** One note's mark, or null. */
export const noteViaProgram = Effect.fn('noteVia')(function* (noteId: string) {
  return (yield* notesViaProgram([noteId])).get(noteId) ?? null
})
