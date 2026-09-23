import { Clock, Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { embedBackfillProgram } from '#/lib/ai/embed-backfill'
import type {
  BackfillCapped,
  BackfillEmbedFailed,
  EmbedBackfillInput,
} from '#/lib/ai/embed-backfill'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * chunk.embed-backfill — every chunk not on the pinned model, embedded in
 * batches (SPA-136). The program is `lib/ai/embed-backfill.ts`; this is the
 * wrapper's view of it, enqueued only by the admin confirming the estimate
 * on Settings → Embeddings.
 *
 * The outcome mapping:
 *
 *   - done, or no pin                → completed
 *   - the day's AI cap               → `JobRateLimited` until the next UTC
 *     midnight (plus a minute of slack, so the resumed run's cap check reads
 *     the new day). The wrapper completes this job and re-sends it with the
 *     same `singletonKey` and that `startAfter`; the batches before the cap
 *     are committed, and the resumed run selects only what is still pending.
 *   - the per-run cap                → permanent: the run already sizes
 *     batches under it, so only a single chunk over the cap stops here, and
 *     waiting does not shrink a chunk
 *   - provider down / usage row lost → retryable; the run resumes where the
 *     rows say it stopped
 *   - no key, a wrong width, …       → permanent, with `embedMessage`'s
 *     sentence — the same answer in a minute
 *   - Postgres unreachable           → retryable
 */

export const embedBackfillData = z.object({})

export type EmbedBackfillData = z.infer<typeof embedBackfillData>

/** How long after the cap's reset the resumed run starts. */
export const RESUME_SLACK_MS = 60_000

const RETRYABLE_EMBED_FAILURES = new Set([
  'ProviderCallFailed',
  'UsageWriteFailed',
  'CapReadFailed',
  'EmbeddingPinReadFailed',
  'CredentialReadFailed',
])

const capped = Effect.fn('embedBackfill.capped')(function* (
  err: BackfillCapped,
): Effect.fn.Return<never, JobPermanent | JobRateLimited> {
  const reason = `${String(err.embedded)} chunk(s) embedded, then stopped: ${err.reason}`
  if (err.kind === 'per_run' || err.resetsAt === null)
    return yield* new JobPermanent({ reason })
  const now = yield* Clock.currentTimeMillis
  return yield* new JobRateLimited({
    reason,
    retryAfterMs: Math.max(0, Date.parse(err.resetsAt) - now) + RESUME_SLACK_MS,
  })
})

const embedFailed = (err: BackfillEmbedFailed) => {
  const reason = `${String(err.embedded)} chunk(s) embedded, then: ${err.reason}`
  return RETRYABLE_EMBED_FAILURES.has(err.cause)
    ? Effect.fail(new JobRetryable({ reason }))
    : Effect.fail(new JobPermanent({ reason }))
}

/** The job's body, with the model seam the test uses. */
export const runEmbedBackfill = (
  _data: EmbedBackfillData,
  seam: EmbedBackfillInput = {},
) =>
  embedBackfillProgram(seam).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] embed backfill: ${String(r.embedded)} chunk(s) embedded${r.model === null ? '' : ` with ${r.model}`}, ${String(r.skipped)} skipped as sensitive`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags({
      BackfillCapped: capped,
      BackfillEmbedFailed: embedFailed,
      BackfillReadFailed: (e) =>
        Effect.fail(new JobRetryable({ reason: e.message })),
      BackfillWriteFailed: (e) =>
        Effect.fail(new JobRetryable({ reason: e.message })),
      EmbeddingPinReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not read the embedding pin' }),
        ),
      CapReadFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'Could not read the AI cap' })),
      SensitivityReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not resolve sensitivity' }),
        ),
    }),
  )

/** Set on the queue at create (`worker/index.ts`), as every queue's policy is. */
export const embedBackfillRetry: JobRetryPolicy = {
  limit: 2,
  delaySeconds: 60,
  backoff: true,
}

export const embedBackfill: JobDef<EmbedBackfillData> = {
  name: QUEUES.embedBackfill,
  schema: embedBackfillData,
  retry: embedBackfillRetry,
  run: (data) => runEmbedBackfill(data),
}
