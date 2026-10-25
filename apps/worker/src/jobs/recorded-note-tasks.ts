import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  recordedNoteTasksMessage,
  recordedNoteTasksProgram,
} from '#web/lib/ai/recorded-note-tasks'
import type {
  RecordedNoteTasksFailure,
  RecordedNoteTasksInput,
} from '#web/lib/ai/recorded-note-tasks'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * interaction.recorded-note-tasks: a recorded note's action items as `task`
 * suggestions. The program is `recordedNoteTasksProgram`.
 * - A refused or unrouted lane is not a failure: nothing is proposed and the
 *   job completes.
 * - A provider down or an unreadable row is retried; anything else (the
 *   cap, no key) is permanent.
 */

const RETRYABLE = new Set([
  'ProviderCallFailed',
  'RecordedNoteTasksQueryFailed',
  'RecordedNoteTasksProposeFailed',
  'SensitivityReadFailed',
  'RouteReadFailed',
  'CapReadFailed',
  'UsageWriteFailed',
])

const failed = (failure: RecordedNoteTasksFailure) => {
  const reason = recordedNoteTasksMessage(failure)
  return RETRYABLE.has(failure._tag)
    ? new JobRetryable({ reason })
    : new JobPermanent({ reason })
}

export const recordedNoteTasksData = z.object({
  interactionId: z.string().uuid(),
  noteId: z.string().uuid(),
  integrationId: z.string().uuid(),
  receiptId: z.string().uuid(),
})

export type RecordedNoteTasksData = z.infer<typeof recordedNoteTasksData>

type Seam = Pick<RecordedNoteTasksInput, 'model'>

/** The job's body, with the model seam the test uses. */
export const runRecordedNoteTasks = (
  data: RecordedNoteTasksData,
  seam: Seam = {},
) =>
  recordedNoteTasksProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.status === 'proposed'
            ? `[worker] note ${data.noteId}: ${String(r.suggestionIds.length)} action items proposed`
            : `[worker] note ${data.noteId}: ${r.status === 'skipped' ? `skipped: ${r.reason}` : r.status}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.mapError(failed),
  )

export const recordedNoteTasks: JobDef<RecordedNoteTasksData> = {
  name: QUEUES.recordedNoteTasks,
  schema: recordedNoteTasksData,
  retry: { limit: 2, delaySeconds: 60, backoff: true },
  run: (data) => runRecordedNoteTasks(data),
}
