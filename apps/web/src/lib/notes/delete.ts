import { Effect, Schema } from 'effect'
import { asc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, link, note } from '@spaces/db/schema'
import type { linkRelation } from '@spaces/db/schema'
import {
  Blocked,
  deleteEntityProgram,
  deleteRefusalProgram,
} from '#/lib/entities/delete'
import type { DeleteQueryFailed } from '#/lib/entities/delete'
import { canRead } from '#/lib/server/shared'

/**
 * Note deletion (SPA-125). Hard delete, no trash — the same answer documents
 * and terms already give (CONTEXT.md → The note model).
 *
 * The note row and the entity row go; what the note *fed* survives. That is
 * not a promise this file keeps by hand: `deleteEntityProgram` walks
 * ENTITY_REFS, where `link` is `cascade` in both directions, so a document
 * `derived_from → note` loses the edge and keeps its blob, its
 * `extracted_text` and its `tsv`; `entity_space` and `activity` cascade the
 * same way; `mandate.note` is `block`, so the fund's mandate refuses by name
 * before a single row is touched.
 *
 * Two programs, one read path: both start at `readNote`, which applies the
 * predicate `getNote` applies, so a private note someone else wrote answers
 * "Note not found" rather than confirming it exists.
 */

/** The note is not there, or not yours to read. The two are one answer. */
export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()(
  'NoteNotFound',
  { id: Schema.String },
) {}

export class NoteQueryFailed extends Schema.TaggedError<NoteQueryFailed>()(
  'NoteQueryFailed',
  { cause: Schema.Defect() },
) {}

export type NoteDeleteFailure =
  NoteNotFound | NoteQueryFailed | Blocked | DeleteQueryFailed

/**
 * The sentence the client is shown. `Effect.runPromise` rejects with the
 * typed error itself, and a `Schema.TaggedError` carries no `message`, so
 * without this the dialog would get an empty string — which is the generic
 * error toast the acceptance criteria rule out. A `Blocked` answers in the
 * registry's own words, which is why `DeleteStrategy.reason` is written as a
 * sentence about the data.
 */
export function noteDeleteMessage(failure: unknown): string {
  if (failure instanceof Blocked) return failure.reason
  if (failure instanceof NoteNotFound) return 'Note not found'
  return 'Could not delete this note'
}

type LinkRelation = (typeof linkRelation.enumValues)[number]

/** Read from the note's side: the note does this to the other record. */
const OUTGOING: Record<LinkRelation, string> = {
  mentions: 'mentioned here',
  tagged_in: 'filed against',
  contact_at: 'contact at',
  derived_from: 'derived from',
  supersedes: 'supersedes',
  references: 'referenced here',
}

/** The other record does this to the note. */
const INCOMING: Record<LinkRelation, string> = {
  mentions: 'mentions this note',
  tagged_in: 'filed against this note',
  contact_at: 'contact at',
  derived_from: 'derived from this note',
  supersedes: 'supersedes this note',
  references: 'references this note',
}

/** One line of the confirm's ledger: what loses its edge to this note. */
export type NoteUnlink = { name: string; meta: string }

export type NoteDeleteImpact = {
  title: string
  /** Spaces, then edges — every row the delete removes that names something else. */
  unlinks: Array<NoteUnlink>
  /** Set when the registry would refuse; the dialog says this instead of offering Delete. */
  blockedReason: string | null
}

const readNote = Effect.fn('readNote')(function* (
  userId: string,
  id: string,
): Effect.fn.Return<{ title: string }, NoteNotFound | NoteQueryFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          title: note.title,
          authorId: note.authorId,
          visibility: note.visibility,
        })
        .from(note)
        .where(eq(note.entityId, id)),
    catch: (cause) => new NoteQueryFailed({ cause }),
  })
  const row = rows.at(0)
  // "Not found" on purpose, the same collapse `getNote` makes: a distinct
  // error would confirm that someone else's private note exists.
  if (!row || !canRead({ id: userId }, row))
    return yield* new NoteNotFound({ id })
  return { title: row.title }
})

/**
 * What deleting this note would take with it, and what would refuse it —
 * asked before the confirm dialog opens, so the dialog can name both. The
 * delete re-asks the refusal question inside its own transaction; this is
 * what the user reads, never what the server trusts.
 */
export const noteDeleteImpactProgram = Effect.fn('noteDeleteImpactProgram')(
  function* (
    userId: string,
    id: string,
  ): Effect.fn.Return<NoteDeleteImpact, NoteDeleteFailure> {
    const { title } = yield* readNote(userId, id)

    const spaces = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ name: entity.canonicalName })
          .from(entitySpace)
          .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
          .where(eq(entitySpace.entityId, id))
          .orderBy(asc(entity.canonicalName)),
      catch: (cause) => new NoteQueryFailed({ cause }),
    })

    const outgoing = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ name: entity.canonicalName, relation: link.relation })
          .from(link)
          .innerJoin(entity, eq(entity.id, link.toEntityId))
          .where(eq(link.fromEntityId, id))
          .orderBy(asc(entity.canonicalName)),
      catch: (cause) => new NoteQueryFailed({ cause }),
    })

    const incoming = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ name: entity.canonicalName, relation: link.relation })
          .from(link)
          .innerJoin(entity, eq(entity.id, link.fromEntityId))
          .where(eq(link.toEntityId, id))
          .orderBy(asc(entity.canonicalName)),
      catch: (cause) => new NoteQueryFailed({ cause }),
    })

    const refusal = yield* deleteRefusalProgram(id)

    return {
      title,
      unlinks: [
        ...spaces.map((s) => ({ name: s.name, meta: 'filed in space' })),
        ...outgoing.map((l) => ({ name: l.name, meta: OUTGOING[l.relation] })),
        ...incoming.map((l) => ({ name: l.name, meta: INCOMING[l.relation] })),
      ],
      blockedReason: refusal === null ? null : refusal.reason,
    }
  },
)

/**
 * Delete one note. `{ deleted: false }` means it was already gone — a second
 * click is the same outcome, not an error.
 */
export const deleteNoteProgram = Effect.fn('deleteNoteProgram')(function* (
  userId: string,
  id: string,
): Effect.fn.Return<{ deleted: boolean }, NoteDeleteFailure> {
  yield* readNote(userId, id)
  return yield* deleteEntityProgram(id)
})
