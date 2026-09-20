import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { NoteNotFound, NoteQueryFailed } from '#/lib/notes/delete'
import { canRead } from '#/lib/server/shared'

/**
 * Filing a note against a record (SPA-116), from the note's own end.
 *
 * Two filing mechanisms, never mixed (CONTEXT.md → The note model): a space
 * files through `entity_space`, a record files through `link(tagged_in)`.
 * This file is the second one, and it writes exactly the stamp
 * `createNoteProgram` writes when "Note about this" starts a note on a
 * record — `relation: 'tagged_in'`, `source: 'manual'` — so a note filed
 * from the editor and a note filed at birth are the same row.
 *
 * **Unfiling removes the filing and nothing else.** The edge table's unique
 * index is `(from, to, relation, attr_slug)`, so a `mentions` row to the
 * same record is a different row: deleting the `tagged_in` one leaves the
 * body's mention alone, and the note moves from "Filed here" to "Mentions
 * this" on that record rather than disappearing from it. `filing.test.ts`
 * pins that.
 *
 * The target allowlist lives **here**, not in the picker. The client filters
 * so the user is never offered a target that would be refused; the server
 * refuses anyway, because a client allowlist is a convenience and never a
 * rule. `mandate` is deliberately absent from both: it is a workspace row,
 * not an entity, so it has no id the `link` table could point at — the
 * picker cannot offer it and this program could not accept it.
 */

/** The kinds a note may be filed against. `space` files the other way. */
export const FILING_TARGET_KINDS = [
  'company',
  'person',
  'deal',
  'custom',
] as const

export type FilingTargetKind = (typeof FILING_TARGET_KINDS)[number]

export function isFilingTargetKind(kind: string): boolean {
  return FILING_TARGET_KINDS.some((k) => k === kind)
}

/**
 * The target is not one a note can be filed against. Carries the sentence
 * rather than a code: each refusal has its own reason, and the dialog-less
 * chip row has nowhere to look one up.
 */
export class FilingTargetRejected extends Schema.TaggedError<FilingTargetRejected>()(
  'FilingTargetRejected',
  { reason: Schema.String },
) {}

export type NoteFilingFailure =
  NoteNotFound | NoteQueryFailed | FilingTargetRejected

/**
 * Why a kind is refused, in the words that say what to do instead. The
 * default covers `term` and anything a later kind adds.
 */
const KIND_REFUSAL: Record<string, string> = {
  space: 'A space is filed into, not against — use “Filed in space”.',
  note: 'A note is not filed against another note; mention it instead.',
  document: 'A document is filed against a record, not against a note.',
}

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function noteFilingMessage(failure: unknown): string {
  if (failure instanceof FilingTargetRejected) return failure.reason
  if (failure instanceof NoteNotFound) return 'Note not found'
  return 'Could not change this note’s filing'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new NoteQueryFailed({ cause }),
  })

/**
 * `delete.ts`'s read, applied here for the same reason: a note that is not
 * there and a note that is not yours answer alike, because a distinct error
 * would confirm that someone else's private note exists. Filing is not
 * author-only — a shared note is team-editable, the rule `saveNote` and
 * `setNoteKind` already apply.
 */
const readNote = Effect.fn('filing.readNote')(function* (
  userId: string,
  id: string,
): Effect.fn.Return<void, NoteNotFound | NoteQueryFailed> {
  const rows = yield* query(() =>
    db
      .select({ authorId: note.authorId, visibility: note.visibility })
      .from(note)
      .where(eq(note.entityId, id)),
  )
  const row = rows.at(0)
  if (!row || !canRead({ id: userId }, row))
    return yield* new NoteNotFound({ id })
})

/**
 * The target half of the check. Four refusals, each with its own sentence:
 * the note itself, a target that is gone, a target merged away (filing
 * against a tombstone would hide the note on the record that survived), and
 * a kind that does not take filings.
 */
const readTarget = Effect.fn('filing.readTarget')(function* (
  noteId: string,
  targetId: string,
): Effect.fn.Return<void, NoteQueryFailed | FilingTargetRejected> {
  if (targetId === noteId)
    return yield* new FilingTargetRejected({
      reason: 'A note cannot be filed against itself.',
    })

  const rows = yield* query(() =>
    db
      .select({
        kind: entity.kind,
        name: entity.canonicalName,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, targetId)),
  )
  const row = rows.at(0)
  if (!row)
    return yield* new FilingTargetRejected({
      reason: 'That record no longer exists.',
    })
  if (row.mergedIntoId !== null)
    return yield* new FilingTargetRejected({
      reason: `“${row.name}” was merged into another record — file the note against that one.`,
    })
  if (!isFilingTargetKind(row.kind))
    return yield* new FilingTargetRejected({
      reason:
        KIND_REFUSAL[row.kind] ??
        `A note is filed against a company, person, deal or custom record — not a ${row.kind}.`,
    })
})

/**
 * File one note against one record. `{ filed: false }` means the edge was
 * already there — a second click is the same outcome, not an error, and it
 * writes no activity row, the rule `setNoteKind` set for non-events.
 */
export const fileNoteAgainstProgram = Effect.fn('fileNoteAgainstProgram')(
  function* (
    userId: string,
    noteId: string,
    targetId: string,
  ): Effect.fn.Return<{ filed: boolean }, NoteFilingFailure> {
    yield* readNote(userId, noteId)
    yield* readTarget(noteId, targetId)

    return yield* query(() =>
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(link)
          .values({
            fromEntityId: noteId,
            toEntityId: targetId,
            relation: 'tagged_in',
            source: 'manual',
            createdBy: userId,
          })
          .onConflictDoNothing()
          .returning({ id: link.id })
        if (inserted.length === 0) return { filed: false }
        // Subject is the record, object is the note — the shape
        // `note.created` already writes when a note is born on a record, so
        // the record's timeline reads it without a second join rule.
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'note.filed',
          subjectEntityId: targetId,
          objectEntityId: noteId,
        })
        return { filed: true }
      }),
    )
  },
)

/**
 * Remove one filing. Deletes the `tagged_in` row alone: a `mentions` row to
 * the same record is a separate edge and survives, which is what moves the
 * note to "Mentions this" instead of off the record's page.
 *
 * No target check here, deliberately: the allowlist guards what may be
 * *created*, and a filing that already exists must stay removable whatever
 * its target has since become — a record merged away after the fact would
 * otherwise leave a chip that refuses to go.
 *
 * `{ unfiled: false }` means there was no filing to remove.
 */
export const unfileNoteFromProgram = Effect.fn('unfileNoteFromProgram')(
  function* (
    userId: string,
    noteId: string,
    targetId: string,
  ): Effect.fn.Return<{ unfiled: boolean }, NoteFilingFailure> {
    yield* readNote(userId, noteId)

    return yield* query(() =>
      db.transaction(async (tx) => {
        const removed = await tx
          .delete(link)
          .where(
            and(
              eq(link.fromEntityId, noteId),
              eq(link.toEntityId, targetId),
              eq(link.relation, 'tagged_in'),
            ),
          )
          .returning({ id: link.id })
        if (removed.length === 0) return { unfiled: false }
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'note.unfiled',
          subjectEntityId: targetId,
          objectEntityId: noteId,
        })
        return { unfiled: true }
      }),
    )
  },
)
