import { Duration, Effect, Layer } from 'effect'
import { eq, sql } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { pluginQueueName } from '@spaces/core/queue/names'
import type { PluginQueueName } from '@spaces/core/queue/names'
import {
  ACTION_TARGETS,
  DOMAIN_EVENTS,
  JobPermanent,
  JobRetryable,
} from '@spaces/sdk'
import type { JobDeclaration, JobError, Manifest } from '@spaces/sdk'
import { runJob } from '../run-job'
import type {
  JobClose,
  JobDef,
  JobHost,
  JobRetryPolicy,
  JobRunLedger,
  JobTx,
} from '../run-job'
import type { JobInput, JobOutput } from './host'
import { messageOf } from './loader'

/**
 * Loader step seven: every declared job becomes a pg-boss queue worked
 * through `runJob`, and a schedule job is scheduled at its cron.
 *
 * - Queue names encode ownership: `plugin.<id>.<job>`, and an interactive
 *   job its own `plugin.<id>.<job>.interactive`.
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
}

/** Runs a wired job: the host's `invoke`. */
export type Invoke = (
  integrationId: string,
  jobName: string,
  input: JobInput,
) => Effect.Effect<JobOutput, JobError>

/** The prefix every plugin queue and schedule carries. */
export const PLUGIN_QUEUE_PREFIX = 'plugin.'

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

/** The queues a manifest declares, one per job. */
export const pluginQueues = (manifest: Manifest): ReadonlyArray<PluginQueue> =>
  Object.entries(manifest.jobs).map(([job, declared]) => ({
    queue: pluginQueueName(manifest.id, job, declared.interactive === true),
    job,
    declared,
  }))

/** The cron a queue is scheduled at, or null when its job has none. */
const cronOf = (plan: PluginQueue): string | null =>
  plan.declared.trigger === 'schedule' && plan.declared.schedule !== undefined
    ? plan.declared.schedule
    : null

/** The schedule queues of these plans: what reconciliation keeps. */
export const scheduledQueues = (
  plans: ReadonlyArray<PluginQueue>,
): ReadonlyArray<PluginQueueName> =>
  plans.flatMap((plan) => (cronOf(plan) === null ? [] : [plan.queue]))

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
const eventData = z.object({
  event: z.object({
    name: z.enum(DOMAIN_EVENTS),
    entityId: z.uuid(),
    kind: z.enum(ACTION_TARGETS),
    occurredAt: z.string().min(1),
  }),
})
const webhookData = z.object({
  payload: z.json(),
  receivedAt: z.string().min(1),
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
          run: (data) =>
            invoke(integrationId, plan.job, data).pipe(Effect.asVoid),
          refs: (data) => ({ integrationId, entityId: data.entityId }),
        },
        concurrency,
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
              if (out === undefined) {
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
      )
    case 'file':
      // A file job is handed a stream in-process; a queued job has no way
      // to carry one, so whatever arrives here is refused, not guessed at.
      return work(
        options,
        {
          ...common(plan),
          schema: z.unknown(),
          run: () =>
            Effect.fail(
              new JobPermanent({
                reason: `${plan.queue} is a file job, which is not run from its queue`,
              }),
            ),
          refs: () => integrationRef,
        },
        concurrency,
      )
  }
}

// ---------------------------------------------------------------------------
// Register, unregister, reconcile
// ---------------------------------------------------------------------------

/**
 * Creates each queue (its policy is fixed at create, so `updateQueue` carries
 * retry and expiry to one an earlier boot made), works it, and schedules a
 * schedule job. A schedule queue is `singleton`: two runs never share a cursor.
 */
export const registerQueues = Effect.fn('registerQueues')(function* (
  options: PluginQueuesOptions,
  integrationId: string,
  plans: ReadonlyArray<PluginQueue>,
  invoke: Invoke,
) {
  const { boss } = options
  for (const plan of plans) {
    const cron = cronOf(plan)
    const queue = queueOptions(plan.declared)
    yield* Effect.promise(() =>
      boss
        .createQueue(plan.queue, {
          policy: cron === null ? 'standard' : 'singleton',
          ...queue,
        })
        .catch(() => undefined),
    )
    yield* Effect.tryPromise(() => boss.updateQueue(plan.queue, queue))
    yield* Effect.tryPromise(() =>
      workPlan(options, integrationId, plan, invoke),
    )
    if (cron !== null) {
      yield* Effect.tryPromise(() =>
        boss.schedule(plan.queue, cron, {}, { tz: SCHEDULE_TZ }),
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
