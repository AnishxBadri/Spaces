import { Effect } from 'effect'
import { z } from 'zod'
import { findLocalModel } from '@spaces/core/ai/local-model'
import {
  localModelDir,
  localModelPresent,
} from '@spaces/core/writes/ai/local-model-files'
import { QUEUES } from '@spaces/core/queue/names'
import { localDownloadLine } from '#web/lib/ai/providers/embed/ids'
import { JobContext, JobPermanent, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'
import type { LocalModelHost } from '../local-model/host'

/**
 * model.download — a local model's files into `<dataDir>/models`, on the
 * admin's click. (D50)
 * - Files already on disk, downloaded or copied by hand, are the answer:
 *   nothing is fetched and nothing is loaded.
 * - Progress is written to this attempt's `job_run` row at most every
 *   `PROGRESS_EVERY_MS`; the section polls it.
 * - A lost network or a worker restart is retryable: every file finished
 *   before is kept by the cache, so the retry fetches only the rest.
 * - The download loads the model, so the first Test after it is warm.
 */

export const modelJobData = z.object({ model: z.string().min(1) })
export type ModelJobData = z.infer<typeof modelJobData>

const PROGRESS_EVERY_MS = 1_000

export const modelDownloadRetry: JobRetryPolicy = {
  limit: 3,
  delaySeconds: 30,
  backoff: true,
}

/** An attempt may run this long before pg-boss reclaims it. */
export const MODEL_DOWNLOAD_EXPIRE_SECONDS = 6 * 60 * 60

export const runModelDownload = Effect.fn('runModelDownload')(function* (
  host: LocalModelHost,
  data: ModelJobData,
): Effect.fn.Return<string, JobPermanent | JobRetryable, JobContext> {
  const spec = findLocalModel(data.model)
  if (spec === undefined)
    return yield* new JobPermanent({
      reason: `${data.model} is not a local model this version knows`,
    })
  const present = () =>
    Effect.tryPromise({
      try: () => localModelPresent(spec),
      catch: () =>
        new JobRetryable({ reason: 'Could not read the model directory' }),
    })
  if (yield* present())
    return `${spec.id} · on disk at ${localModelDir(spec)} — nothing to download`

  const ctx = yield* JobContext
  const report = ctx.progress
  let lastAt = 0
  yield* host
    .download(spec.id, (p) => {
      if (report === undefined || p.total === 0) return
      const now = Date.now()
      if (now - lastAt < PROGRESS_EVERY_MS) return
      lastAt = now
      Effect.runFork(report(localDownloadLine(p.loaded, p.total)))
    })
    .pipe(
      Effect.mapError(
        (e) => new JobRetryable({ reason: `download stopped: ${e.message}` }),
      ),
    )
  if (!(yield* present()))
    return yield* new JobPermanent({
      reason: `${spec.id} loaded, but its files are not all under ${localModelDir(spec)}`,
    })
  return `${spec.id} · downloaded to ${localModelDir(spec)}`
})

export const modelDownload = (host: LocalModelHost): JobDef<ModelJobData> => ({
  name: QUEUES.modelDownload,
  schema: modelJobData,
  retry: modelDownloadRetry,
  run: (data) => runModelDownload(host, data),
})
