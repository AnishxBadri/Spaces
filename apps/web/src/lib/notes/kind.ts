import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { NoteNotFound, NoteQueryFailed } from '#/lib/notes/delete'
import { canRead } from '#/lib/server/shared'

/**
 * Note kind: `memo · note · scratch`, three and frozen. A memo is a note with
 * the flag up, so a promote or demote updates one column and writes no link,
 * no `entity_space` and no body; the test pins that.
 * - Not author-only: whoever may read a shared note may promote it.
 * - Missing and unreadable answer the same `NoteNotFound` (imported, not
 *   re-declared) so a private note's existence is never confirmed.
 */

/** The three kinds, in the order the editor's segmented control draws them. */
export const NOTE_KINDS = ['note', 'memo', 'scratch'] as const

export type NoteKind = (typeof NOTE_KINDS)[number]

export type SetNoteKindFailure = NoteNotFound | NoteQueryFailed

/**
 * The sentence the client is shown — `Effect.runPromise` rejects with the
 * tagged error itself, and a `Schema.TaggedError` carries no `message`.
 */
export function noteKindMessage(failure: unknown): string {
  if (failure instanceof NoteNotFound) return 'Note not found'
  return 'Could not change this note’s kind'
}

/**
 * Promote or demote one note; setting the current kind is not an error.
 * `changed` says whether a row moved, keeping non-events out of the activity
 * stream.
 */
export const setNoteKindProgram = Effect.fn('setNoteKindProgram')(function* (
  userId: string,
  id: string,
  kind: NoteKind,
): Effect.fn.Return<{ kind: NoteKind; changed: boolean }, SetNoteKindFailure> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          kind: note.kind,
          authorId: note.authorId,
          visibility: note.visibility,
        })
        .from(note)
        .where(eq(note.entityId, id)),
    catch: (cause) => new NoteQueryFailed({ cause }),
  })
  const row = rows.at(0)
  if (!row || !canRead({ id: userId }, row))
    return yield* new NoteNotFound({ id })
  if (row.kind === kind) return { kind, changed: false }

  const from = row.kind
  yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        await tx
          .update(note)
          .set({ kind, updatedAt: new Date() })
          .where(eq(note.entityId, id))
        // Subject is the note. `from`/`to` in the meta let the timeline say
        // which way it went without reading the row.
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'note.kind_changed',
          subjectEntityId: id,
          meta: { from, to: kind },
        })
      }),
    catch: (cause) => new NoteQueryFailed({ cause }),
  })
  return { kind, changed: true }
})
