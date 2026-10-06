import { Effect, Schema } from 'effect'
import { desc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { jobRun } from '@spaces/db/schema'
import {
  LOCAL_EMBEDDING_MODELS,
  findLocalModel,
  modelDownloadKey,
  modelTestKey,
} from '@spaces/core/ai/local-model'
import type { LocalModelSpec } from '@spaces/core/ai/local-model'
import {
  localModelDir,
  localModelPresent,
} from '@spaces/core/writes/ai/local-model-files'
import { QUEUES } from '@spaces/core/queue/names'
import type { QueueName } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import type { LocalJobRun, LocalModelView } from './providers/embed/ids'

/**
 * The local model as Settings → Embeddings sees it: its files on disk, its
 * download job and its Test job. (D50)
 * - Presence is a stat of every file a load reads, so a directory copied by
 *   hand counts the same as a download.
 * - Each job is `exclusive` on its key; a second press while one is queued
 *   or running is refused by pg-boss.
 * - A job's line is its newest `job_run` row's summary: progress while it
 *   runs, the result once it has.
 */

export class LocalModelFailed extends Schema.TaggedError<LocalModelFailed>()(
  'LocalModelFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const io = <T>(message: string, f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new LocalModelFailed({ message, cause }),
  })

const specOf = (model: string) => {
  const spec = findLocalModel(model)
  return spec === undefined
    ? Effect.fail(
        new LocalModelFailed({
          message: `${model} is not a local model this version knows`,
          cause: null,
        }),
      )
    : Effect.succeed(spec)
}

/** Whether every file `model` loads from is on disk. */
export const localModelPresentProgram = Effect.fn('localModelPresent')(
  function* (model: string): Effect.fn.Return<boolean, LocalModelFailed> {
    const spec = yield* specOf(model)
    return yield* io('Could not read the model directory', () =>
      localModelPresent(spec),
    )
  },
)

/** The newest `job_run` row of `queue`. One local model, so one per queue. */
const newestRun = (queue: QueueName) =>
  io('Could not read the job ledger', () =>
    db
      .select({
        status: jobRun.status,
        summary: jobRun.summary,
        error: jobRun.error,
      })
      .from(jobRun)
      .where(eq(jobRun.queue, queue))
      .orderBy(desc(jobRun.startedAt))
      .limit(1),
  ).pipe(Effect.map((rows) => rows.at(0)))

/** The Test of `model` last came back with a vector. */
export const localModelTestedGreenProgram = Effect.fn('localModelTestedGreen')(
  function* (model: string): Effect.fn.Return<boolean, LocalModelFailed> {
    const run = yield* newestRun(QUEUES.modelTest)
    return (
      run !== undefined &&
      run.status === 'succeeded' &&
      (run.summary ?? '').startsWith(`${model} ·`)
    )
  },
)

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

/** pg-boss's state for the key, then the ledger row for its line. */
const jobRunOf = Effect.fn('localModel.jobRun')(function* (
  queue: QueueName,
  key: string,
): Effect.fn.Return<LocalJobRun, LocalModelFailed> {
  const jobs = yield* io('Could not reach the worker queue', () =>
    jobsByKey(queue, key),
  )
  const newest = [...(jobs ?? [])].sort(
    (a, b) => b.createdOn.getTime() - a.createdOn.getTime(),
  )
  const latest = newest.at(0)
  if (latest === undefined) return { state: 'idle' }
  const row = yield* newestRun(queue)
  if (latest.state === 'active')
    return {
      state: 'running',
      line: row?.status === 'running' ? (row.summary ?? null) : null,
    }
  if (inFlight(latest)) return { state: 'queued' }
  if (latest.state === 'completed')
    return { state: 'done', line: row?.summary ?? null }
  return {
    state: 'failed',
    reason: row?.error?.replace(/^[a-z-]+: /, '') ?? 'The job stopped',
  }
})

export const localModelViewProgram = Effect.fn('localModelView')(function* (
  spec: LocalModelSpec,
): Effect.fn.Return<LocalModelView, LocalModelFailed> {
  const present = yield* io('Could not read the model directory', () =>
    localModelPresent(spec),
  )
  const download = yield* jobRunOf(
    QUEUES.modelDownload,
    modelDownloadKey(spec.id),
  )
  const test = yield* jobRunOf(QUEUES.modelTest, modelTestKey(spec.id))
  return {
    model: spec.id,
    present,
    dir: localModelDir(spec),
    approxMegabytes: spec.approxMegabytes,
    download,
    test,
    testedOk: yield* localModelTestedGreenProgram(spec.id),
  }
})

/** The section shows the one local model the catalogue lists. */
export const localModelsViewProgram = Effect.fn('localModelsView')(
  function* (): Effect.fn.Return<Array<LocalModelView>, LocalModelFailed> {
    const views: Array<LocalModelView> = []
    for (const spec of LOCAL_EMBEDDING_MODELS)
      views.push(yield* localModelViewProgram(spec))
    return views
  },
)

export type LocalJobStarted =
  | { status: 'queued' }
  | { status: 'already-queued' }
  | { status: 'queue-unavailable' }

const start = Effect.fn('localModel.start')(function* (
  queue: QueueName,
  model: string,
  key: string,
): Effect.fn.Return<LocalJobStarted, LocalModelFailed> {
  yield* specOf(model)
  const id = yield* io('Could not reach the worker queue', () =>
    enqueue(queue, { model }, { singletonKey: key }),
  )
  if (id !== null) return { status: 'queued' }
  const jobs = yield* io('Could not reach the worker queue', () =>
    jobsByKey(queue, key),
  )
  return jobs !== null && jobs.some(inFlight)
    ? { status: 'already-queued' }
    : { status: 'queue-unavailable' }
})

/** Download `model` into `<dataDir>/models`; files already there are kept. */
export const startLocalModelDownloadProgram = (model: string) =>
  start(QUEUES.modelDownload, model, modelDownloadKey(model))

/** Embed one word with `model` in the worker. */
export const startLocalModelTestProgram = (model: string) =>
  start(QUEUES.modelTest, model, modelTestKey(model))
