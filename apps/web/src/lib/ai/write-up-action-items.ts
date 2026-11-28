import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interaction, jobRun, note } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import {
  RecordedNoteTasksQueryFailed,
  recordedNoteTasksMessage,
  recordedNoteTasksProgram,
} from './recorded-note-tasks'
import type {
  RecordedNoteTasksFailure,
  RecordedNoteTasksResult,
} from './recorded-note-tasks'

/**
 * A typed write-up's two ways into the Extract lane: its window closing
 * (queued, so the close never waits on a model) and `Find action items`
 * (run while the reader waits, so the card shows what it found).
 */

/** The meeting a note is the write-up of, while the write-up is shared. */
const sharedWriteUp = (noteId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ interactionId: interaction.id })
        .from(interaction)
        .innerJoin(note, eq(note.entityId, interaction.noteId))
        .where(
          and(eq(interaction.noteId, noteId), eq(note.visibility, 'shared')),
        )
        .then((rows) => rows.at(0)?.interactionId ?? null),
    catch: (cause) => new RecordedNoteTasksQueryFailed({ cause }),
  })

/**
 * Whether the write-up was read already: a finished run of the job about
 * this note. A read that found no action items leaves no suggestion behind,
 * so the ledger is what remembers it and a later close costs no model call.
 */
const readBefore = (noteId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ id: jobRun.id })
        .from(jobRun)
        .where(
          and(
            eq(jobRun.queue, QUEUES.recordedNoteTasks),
            eq(jobRun.entityId, noteId),
            eq(jobRun.status, 'succeeded'),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0),
    catch: (cause) => new RecordedNoteTasksQueryFailed({ cause }),
  })

/**
 * A note window closed: when the note is a meeting's write-up, its action
 * items are read in the background, once. A close after that read queues
 * nothing; `Find action items` is how it is read again. Answers whether a
 * read was queued.
 */
export const writeUpClosedProgram = Effect.fn('writeUpClosedProgram')(
  function* (noteId: string) {
    const interactionId = yield* sharedWriteUp(noteId)
    if (interactionId === null) return { queued: false }
    if (yield* readBefore(noteId)) return { queued: false }
    // `enqueue` never fails: a job that could not be sent answers null.
    const sent = yield* Effect.promise(() =>
      enqueue(
        QUEUES.recordedNoteTasks,
        { interactionId, noteId },
        { singletonKey: noteId },
      ),
    )
    return { queued: sent !== null }
  },
)

/** `Find action items`: the write-up read again for items added since. */
export const findActionItemsProgram = Effect.fn('findActionItemsProgram')(
  function* (
    userId: string,
    noteId: string,
  ): Effect.fn.Return<RecordedNoteTasksResult, RecordedNoteTasksFailure> {
    const interactionId = yield* sharedWriteUp(noteId)
    if (interactionId === null)
      return { status: 'skipped', reason: 'Not a meeting’s write-up' }
    return yield* recordedNoteTasksProgram({
      interactionId,
      noteId,
      again: true,
      askedBy: userId,
    })
  },
)

/** What the toast says once `Find action items` has read the write-up. */
export function foundActionItemsMessage(r: RecordedNoteTasksResult): string {
  switch (r.status) {
    case 'proposed': {
      const n = r.suggestionIds.length
      if (n === 0) return 'No new action items'
      return n === 1 ? '1 action item found' : `${n} action items found`
    }
    case 'refused':
      return 'This meeting is sensitive, so AI does not read it'
    case 'unrouted':
      return 'No model is set up to read it'
    case 'skipped':
      return r.reason
  }
}

/**
 * `Find action items` as the button reads it: how many it proposed and the
 * toast's sentence, or `failed` with the sentence a failure leaves.
 */
export const findActionItemsAnswer = (userId: string, noteId: string) =>
  findActionItemsProgram(userId, noteId).pipe(
    Effect.map((r) => ({
      failed: false,
      found: r.status === 'proposed' ? r.suggestionIds.length : 0,
      message: foundActionItemsMessage(r),
    })),
    Effect.catch((failure) =>
      Effect.succeed({
        failed: true,
        found: 0,
        message: recordedNoteTasksMessage(failure),
      }),
    ),
  )
