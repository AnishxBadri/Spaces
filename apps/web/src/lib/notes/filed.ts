import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, note } from '@spaces/db/schema'
import { byMemoThenRecent } from './ordering'
import type { NoteKind } from './ordering'

/**
 * The notes filed into one space (SPA-120) — the space-page twin of
 * `listRecordNotesProgram`'s filed lane, and ordered by the same rule.
 *
 * Filing into a space is an act: `entity_space`, not a `mentions` edge
 * (CONTEXT.md → Filed vs referenced). **There is no singular memo** — a space
 * holds as many filed notes as its owner wants, so this answers a list and
 * the ordering is what says which one is the face of the space: memos first,
 * then most recently updated, through the one comparator in `./ordering`.
 * `order by kind = 'memo' desc` in SQL would have put that rule in a second
 * place and left it untestable without a database.
 *
 * `canRead` is applied **in SQL** rather than over a row set the database
 * already sent: a teammate's private note must not reach the loader at all,
 * since its title is what leaks. `entity.merged_into_id` is filtered the same
 * way, so a note merged away stops appearing in the space it was filed into.
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

/**
 * The lede of a note's body: the trailing `Mentions:` block the editor
 * appends is not prose, so it is cut before the whitespace is collapsed.
 */
function snippetOf(bodyMd: string): string {
  return bodyMd
    .replace(/Mentions:.*$/s, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_CHARS)
}

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
      snippet: snippetOf(r.bodyMd),
      updatedAt: r.updatedAt.toISOString(),
    }))
    .sort(byMemoThenRecent)
})
