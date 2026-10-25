import { excerpt } from '@spaces/core/context/excerpt'
import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, note } from '@spaces/db/schema'
import { byMemoThenRecent } from './ordering'
import type { NoteKind } from './ordering'

/**
 * The notes filed into one space (`entity_space`, not a `mentions` edge),
 * ordered by `byMemoThenRecent`. There is no singular memo: a space holds any
 * number of filed notes.
 * - `canRead` is applied in SQL: a teammate's private note must never reach
 *   the loader, since its title is what leaks. Merged-away notes are dropped.
 */

export class FiledNotesFailed extends Schema.TaggedError<FiledNotesFailed>()(
  'FiledNotesFailed',
  { cause: Schema.Defect() },
) {}

export type FiledNote = {
  id: string
  /** Raw: the page decides what an untitled note is called. */
  title: string
  kind: NoteKind
  snippet: string
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  updatedAt: string
}

/** How much of the body the space page shows under each filed note. */
const SNIPPET_CHARS = 400

export const filedNotesProgram = Effect.fn('filedNotesProgram')(function* (
  userId: string,
  spaceId: string,
): Effect.fn.Return<Array<FiledNote>, FiledNotesFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: note.entityId,
          title: note.title,
          bodyMd: note.bodyMd,
          kind: note.kind,
          updatedAt: note.updatedAt,
        })
        .from(entitySpace)
        .innerJoin(note, eq(note.entityId, entitySpace.entityId))
        .innerJoin(entity, eq(entity.id, note.entityId))
        .where(
          and(
            eq(entitySpace.spaceId, spaceId),
            isNull(entity.mergedIntoId),
            // canRead in SQL: private notes file into spaces like any other,
            // but only their author sees them there.
            or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
          ),
        )
        .orderBy(desc(note.updatedAt)),
    catch: (cause) => new FiledNotesFailed({ cause }),
  })

  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      snippet: excerpt(r.bodyMd, { noteBody: true, max: SNIPPET_CHARS }),
      updatedAt: r.updatedAt.toISOString(),
    }))
    .sort(byMemoThenRecent)
})
