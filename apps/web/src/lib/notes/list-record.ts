import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, note } from '@spaces/db/schema'
import { byMemoThenRecent } from './ordering'
import type { NoteKind } from './ordering'

/**
 * The notes of one record, in two lanes (SPA-104) — the record-page twin of
 * `getSpace`'s filed/notes split, and the same shape.
 *
 * - **Filed here** — `link(tagged_in)`. The user put the note against this
 *   record, so it is the record's own prose. Memos first (see `ordering`).
 * - **Mentions this** — `link(mentions)` and nothing else. The body happens
 *   to name the record. A note in both lanes shows once, under filed: an
 *   edge is not a second note.
 *
 * Both lanes apply `canRead` **in SQL** rather than filtering a row set the
 * database already sent — a teammate's private note must not reach the
 * loader at all, since its title is what leaks. `entity.merged_into_id` is
 * filtered the same way, so a note merged away stops appearing under the
 * record it was filed against.
 */

export class NoteListFailed extends Schema.TaggedError<NoteListFailed>()(
  'NoteListFailed',
  { cause: Schema.Defect() },
) {}

export type RecordNote = {
  id: string
  title: string
  kind: NoteKind
  updatedAt: string
}

export type RecordNotes = {
  filed: Array<RecordNote>
  mentions: Array<RecordNote>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new NoteListFailed({ cause }),
  })

/** One lane: every readable, unmerged note pointing at `recordId` this way. */
const lane = Effect.fn('listRecordNotes.lane')(function* (
  userId: string,
  recordId: string,
  relation: 'tagged_in' | 'mentions',
) {
  return yield* query(() =>
    db
      .select({
        id: note.entityId,
        title: note.title,
        kind: note.kind,
        updatedAt: note.updatedAt,
      })
      .from(link)
      .innerJoin(note, eq(note.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          eq(link.toEntityId, recordId),
          eq(link.relation, relation),
          isNull(entity.mergedIntoId),
          // canRead in SQL: shared, or private-and-mine.
          or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
        ),
      )
      .orderBy(desc(note.updatedAt)),
  )
})

export const listRecordNotesProgram = Effect.fn('listRecordNotesProgram')(
  function* (
    userId: string,
    recordId: string,
  ): Effect.fn.Return<RecordNotes, NoteListFailed> {
    const [filedRows, mentionRows] = yield* Effect.all(
      [lane(userId, recordId, 'tagged_in'), lane(userId, recordId, 'mentions')],
      { concurrency: 'unbounded' },
    )

    const shape = (r: (typeof filedRows)[number]): RecordNote => ({
      id: r.id,
      title: r.title || 'Untitled',
      kind: r.kind,
      updatedAt: r.updatedAt.toISOString(),
    })

    const filed = filedRows.map(shape).sort(byMemoThenRecent)
    const filedIds = new Set(filed.map((f) => f.id))

    return {
      filed,
      mentions: mentionRows.map(shape).filter((m) => !filedIds.has(m.id)),
    }
  },
)
