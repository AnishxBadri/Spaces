import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  summarizeEmailBackfillProgram,
  summarizeEmailMessage,
  summarizeEmailProgram,
} from '#web/lib/ai/summarize-email'
import type {
  SummarizeEmailFailure,
  SummarizeEmailInput,
} from '#web/lib/ai/summarize-email'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * interaction.summarize-email and its nightly backfill: an email's summary
 * and categories (D67). The programs are `summarizeEmailProgram` and
 * `summarizeEmailBackfillProgram`; these are the wrapper's view of them.
 * - A refused or unrouted lane is not a failure: the field stays absent and
 *   the job completes.
 * - A provider down or an unreadable row is retried; anything else (the
 *   cap, no key) is permanent, and the backfill picks the email up later.
 */

const RETRYABLE = new Set([
  'ProviderCallFailed',
  'SummarizeEmailQueryFailed',
  'SensitivityReadFailed',
  'RouteReadFailed',
  'CapReadFailed',
  'UsageWriteFailed',
])

const failed = (failure: SummarizeEmailFailure) => {
  const reason = summarizeEmailMessage(failure)
  return RETRYABLE.has(failure._tag)
    ? new JobRetryable({ reason })
    : new JobPermanent({ reason })
}

export const summarizeEmailData = z.object({
  interactionId: z.string().uuid(),
})

export type SummarizeEmailData = z.infer<typeof summarizeEmailData>

type Seam = Pick<SummarizeEmailInput, 'model'>

/** The job's body, with the model seam the test uses. */
export const runSummarizeEmail = (data: SummarizeEmailData, seam: Seam = {}) =>
  summarizeEmailProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.status === 'done'
            ? `[worker] email ${data.interactionId}: summary ${r.summary}, categories ${r.categories}`
            : `[worker] email ${data.interactionId} skipped: ${r.reason}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.mapError(failed),
  )

export const summarizeEmail: JobDef<SummarizeEmailData> = {
  name: QUEUES.summarizeEmail,
  schema: summarizeEmailData,
  retry: { limit: 2, delaySeconds: 60, backoff: true },
  run: (data) => runSummarizeEmail(data),
}

export const summarizeEmailBackfillData = z.object({})

export type SummarizeEmailBackfillData = z.infer<
  typeof summarizeEmailBackfillData
>

/** The backfill's body, with the model seam the test uses. */
export const runSummarizeEmailBackfill = (
  _data: SummarizeEmailBackfillData,
  seam: Seam = {},
) =>
  summarizeEmailBackfillProgram(seam).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] email backfill: ${String(r.written)} written, ${String(r.untouched)} left as they were`,
        )
      }),
    ),
    Effect.asVoid,
    // Never retried: the next night is the retry.
    Effect.mapError(
      (failure) => new JobPermanent({ reason: summarizeEmailMessage(failure) }),
    ),
  )

export const summarizeEmailBackfill: JobDef<SummarizeEmailBackfillData> = {
  name: QUEUES.summarizeEmailBackfill,
  schema: summarizeEmailBackfillData,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runSummarizeEmailBackfill(data),
}
