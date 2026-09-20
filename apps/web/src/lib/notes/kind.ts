import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { NoteNotFound, NoteQueryFailed } from '#/lib/notes/delete'
import { canRead } from '#/lib/server/shared'

/**
 * Note kind (SPA-109). `memo · note · scratch` — three, frozen (CONTEXT.md →
 * The note model). A memo is a note with the flag up: same row, same edges,
 * same filing, so a promote or a demote is one `update` of one column and
 * nothing else. This file writes no link, no `entity_space`, no body — and
 * the test pins that it cannot start to.
 *
 * Unlike visibility, kind is **not** author-only. Visibility is the author's
 * own trust boundary; the genre of a shared note is the team's reading of
 * it, so whoever may read the note may promote it — the same rule `saveNote`
 * already applies to the body.
 *
 * The read is `delete.ts`'s read: a note that is not there and a note that
 * is not yours answer with the same `NoteNotFound`, because a distinct error
 * would confirm that someone else's private note exists. Its two tagged
 * errors are imported rather than re-declared so the collapse stays one
 * collapse.
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
 * Promote or demote one note. Returns the kind it now has, so a caller that
 * set the kind it already had gets the same answer as one that changed it —
 * a second click is not an error. `changed` says whether a row moved, which
 * is what keeps the activity stream free of non-events.
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
        // The note's own stream: the subject is the note, as `note.created`
        // already writes it when the note was born out of nothing. `from`
        // and `to` are in the meta so the timeline can say which way it went
        // without reading the row it is describing.
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
