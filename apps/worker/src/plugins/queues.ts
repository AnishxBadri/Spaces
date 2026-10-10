import { Duration, Effect, Layer } from 'effect'
import { eq, sql } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { db } from '@spaces/db'
import { importBatch, integration, spaceWatch } from '@spaces/db/schema'
import { runLinePrefix } from '@spaces/core/import/commit'
import { fileJobData } from '@spaces/core/import/dialect'
import type { FileJobData } from '@spaces/core/import/dialect'
import { jsonValue } from '@spaces/core/json'
import { pluginQueueName } from '@spaces/core/queue/names'
import type { PluginQueueName } from '@spaces/core/queue/names'
import {
  WATCH_TICK_CRON,
  watchRunData,
  watchTickQueue,
} from '@spaces/core/queue/watch'
import type { WatchRunData } from '@spaces/core/queue/watch'
import { ImportRun } from '@spaces/core/writes/ports/import'
import { dueWatchesProgram, liveSpaceOf } from '@spaces/core/writes/watches/run'
import { storage } from '@spaces/core/writes/storage'
import {
  ACTION_TARGETS,
  JobPermanent,
  JobRateLimited,
  JobRetryable,
} from '@spaces/sdk'
import type {
  CostHook,
  FileInput,
  JobDeclaration,
  JobError,
  Manifest,
} from '@spaces/sdk'
import { JobSkipped, runJob } from '../run-job'
import type {
  JobBreaker,
  JobClose,
  JobDef,
  JobHost,
  JobRetryPolicy,
  JobRunLedger,
  JobTx,
} from '../run-job'
import { costOf, creditDefaults, guardAction } from './credit'
import type { CreditPolicy } from './credit'
import type { JobInput, JobOutput } from './host'
import { messageOf } from './loader'

/**
 * Loader step seven: every declared job becomes a pg-boss queue worked
 * through `runJob`, and a schedule job is scheduled at its cron.
 *
 * - Queue names encode ownership: `plugin.<id>.<job>`, and an interactive
 *   job its own `plugin.<id>.<job>.interactive`.
 * - A watch job's queue is `stately`, keyed by watch, with a `.tick` queue
 *   beside it on a one-minute cron that sends each due watch (D72).
 * - Unregistering stops the work and the schedule but never deletes the
 *   queue, so a job sent while the plugin is off waits for it to come back.
 */

/** The pg-boss calls registration makes; the worker passes its `PgBoss`. */
export type PluginBoss = Pick<
  PgBoss,
  | 'createQueue'
  | 'updateQueue'
  | 'work'
  | 'offWork'
  | 'schedule'
  | 'unschedule'
  | 'getSchedules'
  | 'send'
>

export type PluginQueuesOptions = {
  readonly boss: PluginBoss
  /** How `runJob` settles a job; `pgBossHost(boss)` in the worker. */
  readonly host: JobHost
  /** Defaults to the Postgres ledger. */
  readonly ledger?: JobRunLedger
  /** pg-boss's idle poll; its own default when omitted. */
  readonly pollingIntervalSeconds?: number
}

/** One declared job and the queue it is registered on. */
export type PluginQueue = {
  readonly queue: PluginQueueName
  readonly job: string
  readonly declared: JobDeclaration
  /** An action job's `cost` hook; null when it has none or is not one. */
  readonly cost: CostHook | null
  /** The manifest's defaults for the credit guard's two settings. */
  readonly credit: CreditPolicy
}

/** Runs a wired job: the host's `invoke`. */
export type Invoke = (
  integrationId: string,
  jobName: string,
  input: JobInput,
) => Effect.Effect<JobOutput, JobError>

/** The prefix every plugin queue and schedule carries. */
export const PLUGIN_QUEUE_PREFIX = 'plugin.'

/** One plugin's queues, as the breaker groups them: `plugin.<id>.`. */
export const breakerGroup = (pluginId: string): string =>
  `${PLUGIN_QUEUE_PREFIX}${pluginId}.`

/** pg-boss's own default, stated so an upgrade that drops `retry` resets it. */
const DEFAULT_RETRY_LIMIT = 2
const RETRY_DELAY_SECONDS = 30
/** pg-boss's default active-job expiry, for a job with no `timeout`. */
const DEFAULT_EXPIRE_SECONDS = 15 * 60
/** How long past its own timeout an active job may sit before pg-boss expires it. */
const EXPIRE_MARGIN_SECONDS = 60
const SCHEDULE_TZ = 'UTC'

const unitMs = (unit: string): number => {
  switch (unit) {
    case 'ms':
      return 1
    case 's':
      return 1000
    case 'm':
      return 60_000
    case 'h':
      return 3_600_000
    default:
      throw new Error(`not a duration unit: ${unit}`)
  }
}

/** A manifest duration (`60s`, `500ms`, `5m`, `1h`) in milliseconds. */
export const durationMs = (text: string): number => {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text)
  const amount = match?.at(1)
  const unit = match?.at(2)
  if (amount === undefined || unit === undefined)
    throw new Error(`not a manifest duration: ${text}`)
  return Number(amount) * unitMs(unit)
}

/**
 * The queues a manifest declares, one per job. `jobs` is the bundle's job
 * exports, where an action job's `cost` hook lives; without them every job
 * is guarded as one with no `cost` hook.
 */
export const pluginQueues = (
  manifest: Manifest,
  jobs: { readonly [name: string]: unknown } = {},
): ReadonlyArray<PluginQueue> => {
  const credit = creditDefaults(manifest)
  return Object.entries(manifest.jobs).map(([job, declared]) => ({
    queue: pluginQueueName(manifest.id, job, declared.interactive === true),
    job,
    declared,
    cost:
      declared.trigger === 'action' && Object.hasOwn(jobs, job)
        ? costOf(jobs[job])
        : null,
    credit,
  }))
}

/** The cron a queue is scheduled at, or null when its job has none. */
const cronOf = (plan: PluginQueue): string | null =>
  plan.declared.trigger === 'schedule' && plan.declared.schedule !== undefined
    ? plan.declared.schedule
    : null

/** A watch job's tick queue; null for any other job. */
const tickOf = (plan: PluginQueue): PluginQueueName | null =>
  plan.declared.trigger === 'watch' ? watchTickQueue(plan.queue) : null

/** The scheduled queues of these plans: what reconciliation keeps. */
export const scheduledQueues = (
  plans: ReadonlyArray<PluginQueue>,
): ReadonlyArray<PluginQueueName> =>
  plans.flatMap((plan) => {
    const tick = tickOf(plan)
    if (tick !== null) return [tick]
    return cronOf(plan) === null ? [] : [plan.queue]
  })

const retryOf = (declared: JobDeclaration): JobRetryPolicy => ({
  limit: declared.retry ?? DEFAULT_RETRY_LIMIT,
  delaySeconds: RETRY_DELAY_SECONDS,
  backoff: true,
})

const queueOptions = (declared: JobDeclaration) => {
  const retry = retryOf(declared)
  return {
    retryLimit: retry.limit,
    retryDelay: retry.delaySeconds,
    retryBackoff: retry.backoff,
    expireInSeconds:
      declared.timeout === undefined
        ? DEFAULT_EXPIRE_SECONDS
        : Math.ceil(durationMs(declared.timeout) / 1000) +
          EXPIRE_MARGIN_SECONDS,
  }
}

// ---------------------------------------------------------------------------
// The schedule cursor
// ---------------------------------------------------------------------------

/** The cursor a schedule job's next run is handed: null before its first. */
export const readCursor = (
  integrationId: string,
  job: string,
): Effect.Effect<string | null, JobRetryable> =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ cursors: integration.cursors })
        .from(integration)
        .where(eq(integration.id, integrationId)),
    catch: (error) =>
      new JobRetryable({
        reason: `could not read the ${job} cursor: ${messageOf(error)}`,
      }),
  }).pipe(
    Effect.map((rows) => {
      const cursors = rows.at(0)?.cursors ?? {}
      return Object.hasOwn(cursors, job) ? cursors[job] : null
    }),
  )

/** Sets one job's key in `integration.cursors`, leaving the others. */
const writeCursor = async (
  tx: JobTx,
  integrationId: string,
  job: string,
  next: string | null,
): Promise<void> => {
  await tx
    .update(integration)
    .set({
      cursors: sql`coalesce(${integration.cursors}, '{}'::jsonb) || jsonb_build_object(${job}::text, ${next}::text)`,
    })
    .where(eq(integration.id, integrationId))
}

// ---------------------------------------------------------------------------
// JobDefs, by trigger
// ---------------------------------------------------------------------------

const actionData = z.object({ entityId: z.uuid() })
const scheduleData = z.object({})
/** What core's dispatcher sends, one shape per `DOMAIN_EVENTS` name. */
const eventBase = {
  entityId: z.uuid(),
  kind: z.enum(ACTION_TARGETS),
  occurredAt: z.string().min(1),
}
const eventData = z.object({
  event: z.discriminatedUnion('name', [
    z.object({ name: z.literal('entity.created'), ...eventBase }),
    z.object({ name: z.literal('filed'), ...eventBase, spaceId: z.uuid() }),
    z.object({
      name: z.literal('deal.linked'),
      ...eventBase,
      kind: z.enum(['company', 'person']),
      dealId: z.uuid(),
    }),
    z.object({
      name: z.literal('identity.added'),
      ...eventBase,
      kind: z.enum(['company', 'person']),
      key: z.enum(['domain', 'email']),
      value: z.string().min(1),
    }),
  ]),
})
const webhookData = z.object({
  payload: z.json(),
  receivedAt: z.string().min(1),
})

// ---------------------------------------------------------------------------
// A file job run from its queue
// ---------------------------------------------------------------------------

/** The stored bytes as the stream a file job is handed. */
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

/** The same failure, its reason led by `prefix` so the batch page finds it. */
const prefixed = (prefix: string, error: JobError): JobError => {
  switch (error._tag) {
    case 'JobPermanent':
      return new JobPermanent({ reason: `${prefix}${error.reason}` })
    case 'JobRetryable':
      return new JobRetryable({ reason: `${prefix}${error.reason}` })
    case 'JobRateLimited':
      return new JobRateLimited({
        reason: `${prefix}${error.reason}`,
        retryAfterMs: error.retryAfterMs,
      })
  }
}

const stagedRows = (batchId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ rowCount: importBatch.rowCount })
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
        .then((rows) => rows.at(0)?.rowCount ?? 0),
    catch: (error) =>
      new JobRetryable({
        reason: `could not read import batch ${batchId}: ${messageOf(error)}`,
      }),
  })

/**
 * One queued file job: the stored bytes as its stream. With a `batchId` the
 * import wizard is waiting on, the run is scoped to that batch for the
 * Import port, and its line is led by `batch <id> · `, as the commit's is,
 * which is how the batch page finds the reader's run.
 */
export const runFileJob = (
  integrationId: string,
  plan: PluginQueue,
  invoke: Invoke,
  data: FileJobData,
) =>
  Effect.gen(function* () {
    const prefix = data.batchId === undefined ? '' : runLinePrefix(data.batchId)
    const bytes = yield* Effect.tryPromise({
      try: () => storage().getBytes(data.blobSha),
      catch: (error) =>
        new JobRetryable({
          reason: `${prefix}could not read the stored file: ${messageOf(error)}`,
        }),
    })
    const input: FileInput = {
      stream: streamOf(bytes),
      filename: data.filename,
      mime: data.mime,
    }
    if (data.batchId === undefined) {
      yield* invoke(integrationId, plan.job, input)
      return
    }
    const batchId = data.batchId
    yield* invoke(integrationId, plan.job, input).pipe(
      Effect.provideService(ImportRun, { batchId }),
      Effect.mapError((error) => prefixed(prefix, error)),
    )
    const rows = yield* stagedRows(batchId).pipe(
      Effect.mapError((error) => prefixed(prefix, error)),
    )
    if (rows === 0)
      return yield* new JobPermanent({
        reason: `${prefix}${plan.queue} read the file and staged no rows`,
      })
    return `${prefix}${rows} rows staged by ${plan.queue}`
  })

// ---------------------------------------------------------------------------
// A watch run, and the tick that sends them
// ---------------------------------------------------------------------------

const tickData = z.object({})

/** What a watch job hands back, decoded once for the column. */
const watchState = z.object({
  state: z.record(z.string(), jsonValue).nullable(),
})

const watchFailed = (what: string) => (cause: unknown) =>
  new JobRetryable({ reason: `could not ${what}: ${messageOf(cause)}` })

const markWatch = (
  watchId: string,
  set: Partial<typeof spaceWatch.$inferInsert>,
  what: string,
) =>
  Effect.tryPromise({
    try: () => db.update(spaceWatch).set(set).where(eq(spaceWatch.id, watchId)),
    catch: watchFailed(what),
  })

/**
 * One watch run: re-read the row, hand the job its space, settings and
 * state, and write back the state it returns in the transaction closing the
 * `job_run` row — so a run that fails leaves `state` as it was.
 * - A gone watch or an archived space is skipped, never run.
 * - `last_run_at` is stamped as the run starts: that is what keeps the tick
 *   from sending it again in the same slot.
 */
export const runWatchJob = (
  integrationId: string,
  plan: PluginQueue,
  invoke: Invoke,
  data: WatchRunData,
) =>
  Effect.gen(function* () {
    const row = (yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            integrationId: spaceWatch.integrationId,
            spaceId: spaceWatch.spaceId,
            settings: spaceWatch.settings,
            state: spaceWatch.state,
            live: sql<boolean>`${liveSpaceOf(spaceWatch.spaceId)}`,
          })
          .from(spaceWatch)
          .where(eq(spaceWatch.id, data.watchId)),
      catch: watchFailed(`read watch ${data.watchId}`),
    })).at(0)
    if (row === undefined)
      return yield* new JobSkipped({ reason: `watch ${data.watchId} is gone` })
    if (row.integrationId !== integrationId)
      return yield* new JobPermanent({
        reason: `watch ${data.watchId} belongs to another integration`,
      })
    if (!row.live)
      return yield* new JobSkipped({
        reason: `watch ${data.watchId} is paused: its space is archived`,
      })
    yield* markWatch(
      data.watchId,
      { lastRunAt: new Date(), lastStatus: 'running', lastError: null },
      `stamp watch ${data.watchId}`,
    )
    const out = yield* invoke(integrationId, plan.job, {
      watchId: data.watchId,
      spaceId: row.spaceId,
      settings: row.settings,
      state: row.state,
    }).pipe(
      Effect.tapError((error) =>
        markWatch(
          data.watchId,
          { lastStatus: 'failed', lastError: error.reason.slice(0, 1000) },
          `mark watch ${data.watchId} failed`,
        ).pipe(Effect.ignore),
      ),
    )
    const parsed = watchState.safeParse(out)
    if (!parsed.success)
      return yield* new JobPermanent({
        reason: `${plan.queue} returned no { state } object or null`,
      })
    const state = parsed.data.state
    const result: JobClose = {
      summary: `watch ${data.watchId} · state ${state === null ? 'cleared' : 'kept'}`,
      close: async (tx) => {
        await tx
          .update(spaceWatch)
          .set({ state, lastStatus: 'succeeded', lastError: null })
          .where(eq(spaceWatch.id, data.watchId))
      },
    }
    return result
  })

/**
 * One tick: send each of this integration's due watches onto its queue,
 * keyed by watch, so one already waiting is not sent twice.
 */
export const tickWatches = (
  options: Pick<PluginQueuesOptions, 'boss'>,
  integrationId: string,
  queue: PluginQueueName,
  now: Date,
) =>
  Effect.gen(function* () {
    const due = yield* dueWatchesProgram(integrationId, now).pipe(
      Effect.mapError(
        (e) =>
          new JobRetryable({
            reason: `could not read due watches: ${messageOf(e.cause)}`,
          }),
      ),
    )
    let sent = 0
    for (const data of due) {
      const id = yield* Effect.tryPromise({
        try: () =>
          options.boss.send(queue, data, { singletonKey: data.watchId }),
        catch: watchFailed(`send watch ${data.watchId}`),
      })
      if (id !== null) sent += 1
    }
    return sent === 0 ? undefined : `sent ${sent} of ${due.length} due`
  })

/** What every plugin JobDef shares: name, retry, timeout, concurrency. */
const common = (plan: PluginQueue) => ({
  name: plan.queue,
  retry: retryOf(plan.declared),
  ...(plan.declared.timeout === undefined
    ? {}
    : { timeout: Duration.millis(durationMs(plan.declared.timeout)) }),
  ...(plan.declared.concurrency === undefined
    ? {}
    : { concurrency: plan.declared.concurrency }),
})

/** Registers one JobDef's worker; generic so each trigger keeps its data type. */
const work = <TData>(
  options: PluginQueuesOptions,
  def: JobDef<TData>,
  concurrency: number,
  breaker: JobBreaker,
): Promise<string> =>
  options.boss.work(
    def.name,
    {
      batchSize: 1,
      includeMetadata: true,
      localConcurrency: concurrency,
      ...(options.pollingIntervalSeconds === undefined
        ? {}
        : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    },
    runJob(def, {
      host: options.host,
      layer: Layer.empty,
      breaker,
      ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    }),
  )

/**
 * Starts the worker for one plan. The job's ports are already built: `invoke`
 * runs it on its cached Layer, so `runJob` provides nothing more.
 */
const workPlan = (
  options: PluginQueuesOptions,
  integrationId: string,
  plan: PluginQueue,
  invoke: Invoke,
  breaker: JobBreaker,
): Promise<string> => {
  const concurrency = plan.declared.concurrency ?? 1
  const integrationRef = { integrationId }
  switch (plan.declared.trigger) {
    case 'action':
      return work(
        options,
        {
          ...common(plan),
          schema: actionData,
          // The credit guard runs first, so a skip makes no provider call.
          run: (data) =>
            guardAction({
              integrationId,
              entityId: data.entityId,
              defaults: plan.credit,
              cost: plan.cost,
            }).pipe(
              Effect.andThen(invoke(integrationId, plan.job, data)),
              Effect.asVoid,
            ),
          refs: (data) => ({ integrationId, entityId: data.entityId }),
        },
        concurrency,
        breaker,
      )
    case 'schedule':
      return work(
        options,
        {
          ...common(plan),
          schema: scheduleData,
          run: () =>
            Effect.gen(function* () {
              const cursor = yield* readCursor(integrationId, plan.job)
              const out = yield* invoke(integrationId, plan.job, { cursor })
              if (out === undefined || !('nextCursor' in out)) {
                return yield* new JobPermanent({
                  reason: `${plan.queue} returned no { nextCursor }`,
                })
              }
              const next = out.nextCursor
              const result: JobClose = {
                summary: `nextCursor ${next ?? 'null'}`,
                close: (tx) => writeCursor(tx, integrationId, plan.job, next),
              }
              return result
            }),
          refs: () => integrationRef,
        },
        concurrency,
        breaker,
      )
    case 'event':
      return work(
        options,
        {
          ...common(plan),
          schema: eventData,
          run: (data) =>
            invoke(integrationId, plan.job, data).pipe(Effect.asVoid),
          refs: (data) => ({ integrationId, entityId: data.event.entityId }),
        },
        concurrency,
        breaker,
      )
    case 'webhook':
      return work(
        options,
        {
          ...common(plan),
          schema: webhookData,
          run: (data) =>
            invoke(integrationId, plan.job, data).pipe(Effect.asVoid),
          refs: () => integrationRef,
        },
        concurrency,
        breaker,
      )
    case 'file':
      // A queued job cannot carry a stream, so it carries the stored blob's
      // digest and the worker reads the bytes back.
      return work(
        options,
        {
          ...common(plan),
          schema: fileJobData,
          run: (data) => runFileJob(integrationId, plan, invoke, data),
          refs: () => integrationRef,
        },
        concurrency,
        breaker,
      )
    case 'watch':
      return work(
        options,
        {
          ...common(plan),
          schema: watchRunData,
          run: (data) => runWatchJob(integrationId, plan, invoke, data),
          // The space is the entity, so its status stream reaches the space.
          refs: (data) => ({
            integrationId,
            entityId: data.spaceId,
            watchId: data.watchId,
          }),
        },
        concurrency,
        breaker,
      )
  }
}

/**
 * Works a watch job's tick queue. No breaker: a tick is the host's
 * scheduling, never the plugin's work.
 */
const workTick = (
  options: PluginQueuesOptions,
  integrationId: string,
  plan: PluginQueue,
  tick: PluginQueueName,
): Promise<string> =>
  options.boss.work(
    tick,
    {
      batchSize: 1,
      includeMetadata: true,
      ...(options.pollingIntervalSeconds === undefined
        ? {}
        : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    },
    runJob(
      {
        name: tick,
        schema: tickData,
        run: () =>
          Effect.suspend(() =>
            tickWatches(options, integrationId, plan.queue, new Date()),
          ),
      },
      {
        host: options.host,
        layer: Layer.empty,
        ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
      },
    ),
  )

// ---------------------------------------------------------------------------
// Register, unregister, reconcile
// ---------------------------------------------------------------------------

/**
 * Creates each queue (its policy is fixed at create, so `updateQueue` carries
 * retry and expiry to one an earlier boot made), works it, and schedules a
 * schedule job. A schedule queue is `singleton`: two runs never share a cursor.
 * Every queue runs under `breaker`, whose failures count across them all.
 */
export const registerQueues = Effect.fn('registerQueues')(function* (
  options: PluginQueuesOptions,
  integrationId: string,
  plans: ReadonlyArray<PluginQueue>,
  invoke: Invoke,
  breaker: JobBreaker,
) {
  const { boss } = options
  for (const plan of plans) {
    const cron = cronOf(plan)
    const tick = tickOf(plan)
    const queue = queueOptions(plan.declared)
    yield* Effect.promise(() =>
      boss
        .createQueue(plan.queue, {
          policy:
            cron !== null
              ? 'singleton'
              : tick !== null
                ? 'stately'
                : 'standard',
          ...queue,
        })
        .catch(() => undefined),
    )
    yield* Effect.tryPromise(() => boss.updateQueue(plan.queue, queue))
    yield* Effect.tryPromise(() =>
      workPlan(options, integrationId, plan, invoke, breaker),
    )
    if (cron !== null) {
      yield* Effect.tryPromise(() =>
        boss.schedule(plan.queue, cron, {}, { tz: SCHEDULE_TZ }),
      )
    }
    if (tick !== null) {
      yield* Effect.promise(() =>
        boss
          .createQueue(tick, { policy: 'singleton', retryLimit: 0 })
          .catch(() => undefined),
      )
      yield* Effect.tryPromise(() =>
        workTick(options, integrationId, plan, tick),
      )
      yield* Effect.tryPromise(() =>
        boss.schedule(tick, WATCH_TICK_CRON, {}, { tz: SCHEDULE_TZ }),
      )
    }
  }
})

/** Stops each queue's worker, waiting out a job in flight, and unschedules it. */
export const unregisterQueues = Effect.fn('unregisterQueues')(function* (
  options: PluginQueuesOptions,
  plans: ReadonlyArray<PluginQueue>,
) {
  for (const plan of plans) {
    yield* Effect.tryPromise(() => options.boss.offWork(plan.queue))
    if (cronOf(plan) !== null)
      yield* Effect.tryPromise(() => options.boss.unschedule(plan.queue))
    const tick = tickOf(plan)
    if (tick !== null) {
      yield* Effect.tryPromise(() => options.boss.offWork(tick))
      yield* Effect.tryPromise(() => options.boss.unschedule(tick))
    }
  }
})

/**
 * Unschedules every plugin schedule not in `keep`: a job whose schedule left
 * its manifest, or a plugin no longer wired, stops firing. Never touches a
 * core schedule.
 */
export const reconcileSchedules = Effect.fn('reconcileSchedules')(function* (
  options: PluginQueuesOptions,
  keep: ReadonlySet<string>,
) {
  const schedules = yield* Effect.tryPromise(() => options.boss.getSchedules())
  const dropped: Array<string> = []
  for (const schedule of schedules) {
    if (!schedule.name.startsWith(PLUGIN_QUEUE_PREFIX)) continue
    if (keep.has(schedule.name)) continue
    yield* Effect.tryPromise(() =>
      options.boss.unschedule(schedule.name, schedule.key),
    )
    dropped.push(schedule.name)
  }
  return dropped
})
