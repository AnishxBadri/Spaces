import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import type { Json } from '#/lib/json'
import {
  syncExtractedMentions,
  termMentionsIn,
} from '#/lib/glossary/link-terms'
import type { MentionDiff } from '#/lib/glossary/link-terms'
import { NoteNotFound, NoteQueryFailed } from '#/lib/notes/delete'
import { canRead } from '#/lib/notes/visibility'

/**
 * Saving a note (converted to Effect by SPA-34, which opened it to run the
 * glossary matcher on save).
 *
 * One transaction writes the title, the body and the note's extracted
 * `mentions` edges. Those edges have two authors and one diff: the
 * `[[mention]]` chips the client read out of the document, and the glossary
 * terms the shared matcher finds in `body_md` (`lib/glossary/link-terms.ts`).
 * Two diffs over the same rows would each delete the other's, so the wanted
 * set is their union. A manual `mentions` row is never touched — see the
 * edge rule in `link-terms.ts`.
 */

export type SaveNoteInput = {
  id: string
  title: string
  /** Absent = a title-only save; the body and its edges stay untouched. */
  body?: {
    bodyJson: Array<Json>
    bodyMd: string
    /** Entity ids mentioned in the doc, extracted client-side from JSON. */
    mentionIds: Array<string>
  }
}

export type SaveNoteResult = {
  savedAt: string
  /** `null` for a title-only save, which does not sync edges. */
  mentions: MentionDiff | null
}

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function noteSaveMessage(failure: unknown): string {
  if (failure instanceof NoteNotFound) return 'Note not found'
  return 'Could not save this note'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new NoteQueryFailed({ cause }),
  })

export const saveNoteProgram = Effect.fn('saveNoteProgram')(function* (
  userId: string,
  input: SaveNoteInput,
): Effect.fn.Return<SaveNoteResult, NoteNotFound | NoteQueryFailed> {
  // Shared notes are team-editable; private ones are the author's alone.
  const existing = (yield* query(() =>
    db
      .select({ authorId: note.authorId, visibility: note.visibility })
      .from(note)
      .where(eq(note.entityId, input.id)),
  )).at(0)
  if (!existing || !canRead({ id: userId }, existing))
    return yield* new NoteNotFound({ id: input.id })

  const body = input.body
  const mentions = yield* query(() =>
    db.transaction(async (tx) => {
      await tx
        .update(note)
        .set({
          title: input.title,
          updatedAt: new Date(),
          ...(body ? { bodyJson: body.bodyJson, bodyMd: body.bodyMd } : {}),
        })
        .where(eq(note.entityId, input.id))
      await tx
        .update(entity)
        .set({ canonicalName: input.title || 'Untitled' })
        .where(eq(entity.id, input.id))

      if (!body) return null

      const terms = await termMentionsIn(tx, input.id, body.bodyMd)
      return syncExtractedMentions(tx, {
        fromId: input.id,
        wanted: new Set([...body.mentionIds, ...terms]),
        owns: 'all',
        actorId: userId,
      })
    }),
  )

  return { savedAt: new Date().toISOString(), mentions }
})
