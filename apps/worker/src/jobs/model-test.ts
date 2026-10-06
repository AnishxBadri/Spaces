import { Clock, Effect } from 'effect'
import { findLocalModel } from '@spaces/core/ai/local-model'
import { localModelPresent } from '@spaces/core/writes/ai/local-model-files'
import { QUEUES } from '@spaces/core/queue/names'
import {
  LOCAL_TEST_RUNNING_LINE,
  localTestLine,
} from '#web/lib/ai/providers/embed/ids'
import { JobContext, JobPermanent, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'
import type { LocalModelHost } from '../local-model/host'
import { modelJobData } from './model-download'
import type { ModelJobData } from './model-download'

/**
 * model.test — one word embedded by the local model in the worker that holds
 * it, the settings Test for a model web cannot call directly. (D50)
 * - While it runs, its `job_run` row says the first run loads the model.
 * - Its summary is the answer — model, width, the first four values, the
 *   time, and whether this run loaded the model — and a green one is what the
 *   sensitive slot is offered on.
 */

/** The word the Test embeds, as the cloud Test does. */
export const MODEL_TEST_TEXT = 'Spaces'

export const modelTestRetry: JobRetryPolicy = {
  limit: 0,
  delaySeconds: 0,
  backoff: false,
}

export const runModelTest = Effect.fn('runModelTest')(function* (
  host: LocalModelHost,
  data: ModelJobData,
): Effect.fn.Return<string, JobPermanent | JobRetryable, JobContext> {
  const spec = findLocalModel(data.model)
  if (spec === undefined)
    return yield* new JobPermanent({
      reason: `${data.model} is not a local model this version knows`,
    })
  const present = yield* Effect.tryPromise({
    try: () => localModelPresent(spec),
    catch: () =>
      new JobRetryable({ reason: 'Could not read the model directory' }),
  })
  if (!present)
    return yield* new JobPermanent({
      reason: `Download ${spec.id} before testing it`,
    })

  const loads = !host.isLoaded(spec.id)
  const ctx = yield* JobContext
  if (loads && ctx.progress !== undefined)
    yield* ctx.progress(LOCAL_TEST_RUNNING_LINE)
  const started = yield* Clock.currentTimeMillis
  const vectors = yield* host
    .embed(spec.id, [MODEL_TEST_TEXT])
    .pipe(Effect.mapError((e) => new JobPermanent({ reason: e.message })))
  const ms = (yield* Clock.currentTimeMillis) - started
  const vector = vectors.at(0) ?? []
  if (vector.length !== spec.dims)
    return yield* new JobPermanent({
      reason: `${spec.id} returned ${String(vector.length)} dimensions; this workspace stores ${String(spec.dims)}`,
    })
  return localTestLine(spec.id, vector.length, vector.slice(0, 4), ms, loads)
})

export const modelTest = (host: LocalModelHost): JobDef<ModelJobData> => ({
  name: QUEUES.modelTest,
  schema: modelJobData,
  retry: modelTestRetry,
  run: (data) => runModelTest(host, data),
})
