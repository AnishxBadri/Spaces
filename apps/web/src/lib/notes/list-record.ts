import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  entity,
  interaction,
  interactionEntity,
  interactionNote,
  link,
  note,
} from '@spaces/db/schema'
import { byMemoThenRecent } from './ordering'
import type { NoteKind } from './ordering'
import { noteExcerpt } from './excerpt'
import { notesViaProgram } from './via'
import type { NoteVia } from './via-mark'
import { viewerSelf } from '#/lib/timeline/record'

/**
 * The notes of one record, in three lanes — the record-page twin of
 * `getSpace`'s filed/notes split, plus the meetings.
 *
 * - **Filed here** — `link(tagged_in)`. The user put the note against this
 *   record, so it is the record's own prose. Memos first (see `ordering`).
 * - **From meetings** — the write-ups and second notes of the record's
 *   meetings and calls, newest meeting first. A deal reads its
 *   company's and contacts' meetings too, as its Interactions tab does.
 *   May overlap Filed here.
 * - **Mentions this** — `link(mentions)` and nothing else: a note in either
 *   other lane shows there, since an edge is not a second note.
 *
 * Each note carries what its row prints: the author, or a meeting note's
 * attendees (never the viewer), an excerpt of its body, and the newer note
 * that supersedes it.
 *
 * Every lane applies `canRead` **in SQL** rather than filtering a row set
 * the database already sent — a teammate's private note must not reach the
 * loader at all, since its title is what leaks. `entity.merged_into_id` is
 * filtered the same way, so a note merged away stops appearing.
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
  /** "via <tool> · <author>" for a note a recorder filed. */
  via: NoteVia | null
  /** Who wrote it; null when it is the viewer, who is never listed. */
  author: string | null
  /** A meeting note's attendees by name, the viewer left out. */
  attendees: Array<string>
  /** About the first 160 characters of its body, markdown stripped. */
  excerpt: string | null
  /** The newer note that supersedes this one; null for a current note. */
  supersededBy: string | null
}

export type RecordNotes = {
  filed: Array<RecordNote>
  fromMeetings: Array<RecordNote>
  mentions: Array<RecordNote>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new NoteListFailed({ cause }),
  })

const noteColumns = {
  id: note.entityId,
  title: note.title,
  kind: note.kind,
  updatedAt: note.updatedAt,
  authorId: note.authorId,
  // Enough of the body for an excerpt once the markdown is stripped.
  body: sql<string>`left(${note.bodyMd}, 800)`,
}

/** canRead in SQL: shared, or private-and-mine. */
const readable = (userId: string) =>
  or(eq(note.visibility, 'shared'), eq(note.authorId, userId))

/** One edge lane: every readable, unmerged note pointing at `recordId`. */
const lane = Effect.fn('listRecordNotes.lane')(function* (
  userId: string,
  recordId: string,
  relation: 'tagged_in' | 'mentions',
) {
  return yield* query(() =>
    db
      .select(noteColumns)
      .from(link)
      .innerJoin(note, eq(note.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          eq(link.toEntityId, recordId),
          eq(link.relation, relation),
          isNull(entity.mergedIntoId),
          readable(userId),
        ),
      )
      .orderBy(desc(note.updatedAt)),
  )
})

/** Whose meetings a record reads: its own, and on a deal its company's and contacts'. */
const meetingHolders = Effect.fn('listRecordNotes.meetingHolders')(function* (
  recordId: string,
) {
  const derived = yield* query(() =>
    db
      .select({ id: link.toEntityId })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.fromEntityId, recordId),
          eq(entity.kind, 'deal'),
          eq(link.relation, 'references'),
          inArray(link.attrSlug, ['company', 'people']),
        ),
      ),
  )
  return [...new Set([recordId, ...derived.map((r) => r.id)])]
})

/** The meetings lane: write-ups and `interaction_note` rows, newest meeting first. */
const meetingLane = Effect.fn('listRecordNotes.meetingLane')(function* (
  userId: string,
  recordId: string,
) {
  const holders = yield* meetingHolders(recordId)
  const onMeeting = and(
    inArray(interactionEntity.entityId, holders),
    inArray(interaction.kind, ['meeting', 'call']),
    isNull(entity.mergedIntoId),
    readable(userId),
  )
  const columns = {
    ...noteColumns,
    at: interaction.occurredAt,
    interactionId: interaction.id,
  }
  const [writeUps, carried] = yield* Effect.all(
    [
      query(() =>
        db
          .select(columns)
          .from(interactionEntity)
          .innerJoin(
            interaction,
            eq(interaction.id, interactionEntity.interactionId),
          )
          .innerJoin(note, eq(note.entityId, interaction.noteId))
          .innerJoin(entity, eq(entity.id, note.entityId))
          .where(onMeeting),
      ),
      query(() =>
        db
          .select(columns)
          .from(interactionEntity)
          .innerJoin(
            interaction,
            eq(interaction.id, interactionEntity.interactionId),
          )
          .innerJoin(
            interactionNote,
            eq(interactionNote.interactionId, interaction.id),
          )
          .innerJoin(note, eq(note.entityId, interactionNote.noteId))
          .innerJoin(entity, eq(entity.id, note.entityId))
          .where(onMeeting),
      ),
    ],
    { concurrency: 'unbounded' },
  )
  const seen = new Set<string>()
  // The write-up first within a meeting, then its second notes.
  return [...writeUps, ...carried]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.at.getTime() - a.r.at.getTime() || a.i - b.i)
    .map(({ r }) => r)
    .filter((r) => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
})

/** The authors' names, and each meeting's attendees without the viewer. */
const rowPeople = Effect.fn('listRecordNotes.people')(function* (
  userId: string,
  rows: ReadonlyArray<{ authorId: string | null; interactionId?: string }>,
) {
  const authorIds = [
    ...new Set(rows.flatMap((r) => (r.authorId === null ? [] : [r.authorId]))),
  ]
  const meetingIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.interactionId === undefined ? [] : [r.interactionId],
      ),
    ),
  ]
  const authors =
    authorIds.length > 0
      ? yield* query(() =>
          db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, authorIds)),
        )
      : []
  const present =
    meetingIds.length > 0
      ? yield* query(() =>
          db
            .select({
              interactionId: interactionEntity.interactionId,
              id: entity.id,
              name: entity.canonicalName,
            })
            .from(interactionEntity)
            .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
            .where(
              and(
                inArray(interactionEntity.interactionId, meetingIds),
                eq(entity.kind, 'person'),
              ),
            )
            .orderBy(entity.canonicalName),
        )
      : []
  const self =
    present.length > 0
      ? (yield* viewerSelf(userId).pipe(
          Effect.mapError((cause) => new NoteListFailed({ cause })),
        )).people
      : new Set<string>()
  const attendees = new Map<string, Array<string>>()
  for (const p of present) {
    if (self.has(p.id)) continue
    attendees.set(p.interactionId, [
      ...(attendees.get(p.interactionId) ?? []),
      p.name,
    ])
  }
  return { authors: new Map(authors.map((a) => [a.id, a.name])), attendees }
})

/** Each superseded note's newest successor: `link(supersedes)` newer → older. */
const supersededBy = Effect.fn('listRecordNotes.supersededBy')(function* (
  noteIds: ReadonlyArray<string>,
) {
  if (noteIds.length === 0) return new Map<string, string>()
  const rows = yield* query(() =>
    db
      .selectDistinctOn([link.toEntityId], {
        older: link.toEntityId,
        newer: link.fromEntityId,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.relation, 'supersedes'),
          inArray(link.toEntityId, [...new Set(noteIds)]),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(link.toEntityId, desc(link.createdAt)),
  )
  return new Map(rows.map((r) => [r.older, r.newer]))
})

export const listRecordNotesProgram = Effect.fn('listRecordNotesProgram')(
  function* (
    userId: string,
    recordId: string,
  ): Effect.fn.Return<RecordNotes, NoteListFailed> {
    const [filedRows, meetingRows, mentionRows] = yield* Effect.all(
      [
        lane(userId, recordId, 'tagged_in'),
        meetingLane(userId, recordId),
        lane(userId, recordId, 'mentions'),
      ],
      { concurrency: 'unbounded' },
    )
    const via = yield* notesViaProgram(
      [...filedRows, ...meetingRows].map((r) => r.id),
    ).pipe(Effect.mapError((cause) => new NoteListFailed({ cause })))
    const people = yield* rowPeople(userId, [
      ...filedRows,
      ...meetingRows,
      ...mentionRows,
    ])
    const newer = yield* supersededBy(
      [...filedRows, ...meetingRows, ...mentionRows].map((r) => r.id),
    )

    const shape = (
      r: (typeof filedRows)[number] & { interactionId?: string },
    ): RecordNote => ({
      id: r.id,
      title: r.title || 'Untitled',
      kind: r.kind,
      updatedAt: r.updatedAt.toISOString(),
      via: via.get(r.id) ?? null,
      author:
        r.authorId === userId ? null : (people.authors.get(r.authorId) ?? null),
      attendees:
        r.interactionId === undefined
          ? []
          : (people.attendees.get(r.interactionId) ?? []),
      excerpt: noteExcerpt(r.body),
      supersededBy: newer.get(r.id) ?? null,
    })

    const filed = filedRows.map(shape).sort(byMemoThenRecent)
    const fromMeetings = meetingRows.map(shape)
    const attached = new Set([...filed, ...fromMeetings].map((n) => n.id))

    return {
      filed,
      fromMeetings,
      mentions: mentionRows.map(shape).filter((m) => !attached.has(m.id)),
    }
  },
)
