import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Scope,
} from 'effect'
import type { Layer as LayerType } from 'effect'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import {
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  PORTS,
  PORT_NAMES,
} from '@spaces/sdk'
import type {
  ActionInput,
  EventInput,
  FileInput,
  JobError,
  ScheduleInput,
  ScheduleOutput,
  Trigger,
  WebhookInput,
} from '@spaces/sdk'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import type { LogSink } from '@spaces/core/writes/ports/log'
import { BREAKER_REASON } from '../run-job'
import type { JobBreaker } from '../run-job'
import { grantLayer } from './grant'
import { messageOf, truncate } from './loader'
import type { LoadedHook, LoadedPlugin } from './loader'
import {
  breakerGroup,
  pluginQueues,
  reconcileSchedules,
  registerQueues,
  scheduledQueues,
  unregisterQueues,
} from './queues'
import type { PluginQueue, PluginQueuesOptions } from './queues'

/**
 * The plugin host: loader steps six and seven. For each loaded plugin it
 * builds one scoped Layer per (integration, job) from that job's `uses`
 * (D51), caches it, runs jobs through it (`invoke`), registers each job's
 * queue (`registerQueues`), and undoes all of it on release.
 *
 * - The Layer is the privilege boundary: a job that reaches for a port it
 *   did not declare dies with "Service not found", which `invoke` maps to
 *   `JobPermanent`.
 * - `onEnable` runs once when a plugin is wired, `onDisable` when it is
 *   released. A failing hook degrades that plugin and no other.
 * - One `Enqueue` serves every job, built in the host's own scope: closing a
 *   job's scope closes its ports and never the shared sender.
 * - A tripped breaker releases its plugin from a detached fiber, never from
 *   the job that tripped it: `offWork` waits out that job, so it cannot wait
 *   inside it. The row says `disabled`; `release` never degrades it.
 */

/** What a job is handed, by its trigger. */
export type JobInput =
  ActionInput | ScheduleInput | EventInput | WebhookInput | FileInput

/** What a job hands back: a schedule job's cursor, nothing for the rest. */
export type JobOutput = ScheduleOutput | void

export type PluginHostOptions = {
  /** Built once, on the first job that hands work back; closed by `releaseAll` or `shutdown`. */
  readonly enqueue: LayerType.Layer<Enqueue>
  /** pg-boss and the wrapper's seams; without it no queue is registered. */
  readonly queues?: PluginQueuesOptions
  readonly fetch?: FetchLike
  readonly sink?: LogSink
}

/** One plugin's outcome from `wire` or `release`, and the line boot prints. */
export type HostVerdict = {
  readonly integrationId: string
  readonly id: string
  readonly status: 'enabled' | 'degraded' | 'released' | 'disabled'
  readonly reason: string | null
  readonly line: string
}

export type PluginHost = {
  /** Wire every loaded plugin not yet wired; release every wired one no longer loaded. */
  readonly wire: (
    loaded: ReadonlyArray<LoadedPlugin>,
  ) => Effect.Effect<ReadonlyArray<HostVerdict>, Cause.UnknownError>
  /** Unregister its queues, run `onDisable`, then close every job scope of this integration. */
  readonly release: (
    integrationId: string,
  ) => Effect.Effect<HostVerdict | null, Cause.UnknownError>
  /** Release every plugin, then close the shared sender. */
  readonly releaseAll: () => Effect.Effect<void, Cause.UnknownError>
  /**
   * Process exit, after `boss.stop`: close every job scope and the shared
   * sender. No hook runs and nothing is unscheduled — the rows are still on.
   */
  readonly shutdown: () => Effect.Effect<void>
  /** Run a wired job on its cached Layer with its trigger's input. */
  readonly invoke: (
    integrationId: string,
    jobName: string,
    input: JobInput,
  ) => Effect.Effect<JobOutput, JobError>
  /** The services a wired job's Layer holds, by port name; null when not wired. */
  readonly granted: (
    integrationId: string,
    jobName: string,
  ) => ReadonlyArray<string> | null
}

type JobRun = (input: JobInput) => unknown

type WiredJob = {
  readonly trigger: Trigger
  readonly run: JobRun
  readonly scope: Scope.Closeable
  readonly context: Context.Context<never>
}

type Wired = {
  readonly id: string
  readonly jobs: ReadonlyMap<string, WiredJob>
  /** The queues registered for it; empty when the host has no `queues`. */
  readonly queues: ReadonlyArray<PluginQueue>
  readonly onDisable?: LoadedHook
}

const isRun = (value: unknown): value is JobRun => typeof value === 'function'

/** The function a job export runs: itself, or an action job's `run` (D53). */
const runOf = (trigger: Trigger, exported: unknown): JobRun | null => {
  if (isRun(exported)) return exported
  if (
    trigger === 'action' &&
    Predicate.hasProperty(exported, 'run') &&
    isRun(exported.run)
  )
    return exported.run
  return null
}

/**
 * A bundle's Effect. Its `R` does not survive the import boundary: what it
 * may reach is the context the host provides, and anything else is
 * "Service not found" at runtime.
 */
const isBundleEffect = (
  value: unknown,
): value is Effect.Effect<unknown, unknown> => Effect.isEffect(value)

const isJobError = (error: unknown): error is JobError =>
  error instanceof JobPermanent ||
  error instanceof JobRetryable ||
  error instanceof JobRateLimited

const reasonOf = (error: unknown): string =>
  Predicate.hasProperty(error, 'reason') && Predicate.isString(error.reason)
    ? error.reason
    : messageOf(error)

const describeCause = (cause: Cause.Cause<unknown>): string =>
  truncate(reasonOf(Cause.squash(cause)))

const portOfKey = (key: string): string =>
  PORT_NAMES.find((name) => PORTS[name].key === key) ?? key

/** The port a "Service not found" defect names, or null for any other defect. */
const notGranted = (defect: unknown): string | null => {
  if (!(defect instanceof Error)) return null
  const key = /^Service not found: (.+)$/.exec(defect.message)?.at(1)
  return key === undefined ? null : portOfKey(key)
}

const scheduleOutput = z.object({ nextCursor: z.string().nullable() })

/** Run a lifecycle hook with no ports; the failure's message, or null. */
const runHook = (hook: LoadedHook): Effect.Effect<string | null> =>
  Effect.suspend(() => {
    const out = hook()
    return isBundleEffect(out)
      ? out
      : Effect.fail(new Error('the hook did not return an Effect'))
  }).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit) ? null : describeCause(exit.cause),
    ),
  )

const degrade = (integrationId: string, reason: string) =>
  Effect.tryPromise(() =>
    db
      .update(integration)
      .set({ status: 'degraded', lastError: truncate(reason) })
      .where(eq(integration.id, integrationId)),
  )

const closeAll = (jobs: Iterable<WiredJob>) =>
  Effect.forEach(jobs, (job) => Scope.close(job.scope, Exit.void), {
    discard: true,
  })

export const makePluginHost = (options: PluginHostOptions): PluginHost => {
  const wired = new Map<string, Wired>()
  /** Queue name → the integration whose jobs it runs. */
  const owners = new Map<string, string>()

  let shared: {
    readonly scope: Scope.Closeable
    readonly context: Context.Context<Enqueue>
  } | null = null
  /** The host's one sender, built on first use and reused by every job. */
  const sharedEnqueue: LayerType.Layer<Enqueue> = Layer.effectContext(
    Effect.suspend(() => {
      if (shared !== null) return Effect.succeed(shared.context)
      return Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(options.enqueue, scope)
        shared = { scope, context }
        return context
      })
    }),
  )
  const closeShared = Effect.suspend(() => {
    const open = shared
    shared = null
    return open === null ? Effect.void : Scope.close(open.scope, Exit.void)
  })

  const logFailure = (what: string) => (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      console.error(`[plugins] ${what}: ${describeCause(cause)}`)
    })

  const degraded = (plugin: LoadedPlugin, reason: string) =>
    Effect.gen(function* () {
      yield* degrade(plugin.integrationId, reason)
      const verdict: HostVerdict = {
        integrationId: plugin.integrationId,
        id: plugin.manifest.id,
        status: 'degraded',
        reason: truncate(reason),
        line: `[plugins] ${plugin.manifest.id}: degraded — ${truncate(reason)}`,
      }
      return verdict
    })

  const wireOne = Effect.fn('PluginHost.wireOne')(function* (
    plugin: LoadedPlugin,
  ) {
    const jobs = new Map<string, WiredJob>()
    for (const [name, declared] of Object.entries(plugin.manifest.jobs)) {
      const run = runOf(declared.trigger, plugin.jobs[name])
      if (run === null) {
        yield* closeAll(jobs.values())
        return yield* degraded(
          plugin,
          `job ${name} is not a ${declared.trigger} job`,
        )
      }
      const scope = yield* Scope.make()
      const built = yield* Layer.buildWithScope(
        grantLayer(plugin.row, declared.uses, {
          settings: plugin.settings,
          enqueue: sharedEnqueue,
          ...(plugin.manifest.http?.rateLimit === undefined
            ? {}
            : { rpm: plugin.manifest.http.rateLimit.rpm }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.sink === undefined ? {} : { sink: options.sink }),
        }),
        scope,
      ).pipe(Effect.exit)
      if (Exit.isFailure(built)) {
        yield* Scope.close(scope, built)
        yield* closeAll(jobs.values())
        return yield* degraded(plugin, describeCause(built.cause))
      }
      jobs.set(name, {
        trigger: declared.trigger,
        run,
        scope,
        // Exactly the declared tags: an ambient port built alongside a
        // declared one never reaches the job.
        context: Context.pick(...declared.uses.map((port) => PORTS[port]))(
          built.value,
        ),
      })
    }
    const plans =
      options.queues === undefined ? [] : pluginQueues(plugin.manifest)
    const taken = plans.find((plan) => {
      const owner = owners.get(plan.queue)
      return owner !== undefined && owner !== plugin.integrationId
    })
    if (taken !== undefined) {
      yield* closeAll(jobs.values())
      return yield* degraded(
        plugin,
        `queue ${taken.queue} is already registered by integration ${owners.get(taken.queue) ?? ''}`,
      )
    }
    if (plugin.onEnable !== undefined) {
      const failed = yield* runHook(plugin.onEnable)
      if (failed !== null) {
        yield* closeAll(jobs.values())
        return yield* degraded(plugin, `onEnable failed: ${failed}`)
      }
    }
    // Wired before its queues register: a job fetched at once finds it.
    wired.set(plugin.integrationId, {
      id: plugin.manifest.id,
      jobs,
      queues: plans,
      ...(plugin.onDisable === undefined
        ? {}
        : { onDisable: plugin.onDisable }),
    })
    if (options.queues !== undefined) {
      const queues = options.queues
      const breaker: JobBreaker = {
        integrationId: plugin.integrationId,
        group: breakerGroup(plugin.manifest.id),
        onTrip: () => tripLater(plugin.integrationId),
      }
      const registered = yield* registerQueues(
        queues,
        plugin.integrationId,
        plans,
        invoke,
        breaker,
      ).pipe(Effect.exit)
      if (Exit.isFailure(registered)) {
        yield* unregisterQueues(queues, plans).pipe(
          Effect.catchCause(logFailure(`${plugin.manifest.id}: unregister`)),
        )
        wired.delete(plugin.integrationId)
        if (plugin.onDisable !== undefined) yield* runHook(plugin.onDisable)
        yield* closeAll(jobs.values())
        return yield* degraded(
          plugin,
          `could not register its queues: ${describeCause(registered.cause)}`,
        )
      }
      for (const plan of plans) owners.set(plan.queue, plugin.integrationId)
    }
    const verdict: HostVerdict = {
      integrationId: plugin.integrationId,
      id: plugin.manifest.id,
      status: 'enabled',
      reason: null,
      line: `[plugins] ${plugin.manifest.id}: wired ${[...jobs.keys()].join(', ')}`,
    }
    return verdict
  })

  /** `breaker`: the breaker tripped it, so its row stays `disabled` whatever `onDisable` does. */
  const releaseBy = Effect.fn('PluginHost.release')(function* (
    integrationId: string,
    by: 'operator' | 'breaker',
  ) {
    const plugin = wired.get(integrationId)
    if (plugin === undefined) return null
    // Stopped first, waiting out a job in flight, so none starts after the
    // ports it runs on are closed.
    if (options.queues !== undefined) {
      yield* unregisterQueues(options.queues, plugin.queues).pipe(
        Effect.catchCause(logFailure(`${plugin.id}: unregister`)),
      )
    }
    for (const plan of plugin.queues) owners.delete(plan.queue)
    wired.delete(integrationId)
    const failed =
      plugin.onDisable === undefined ? null : yield* runHook(plugin.onDisable)
    yield* closeAll(plugin.jobs.values())
    if (by === 'breaker') {
      if (failed !== null)
        console.error(`[plugins] ${plugin.id}: onDisable failed: ${failed}`)
      const verdict: HostVerdict = {
        integrationId,
        id: plugin.id,
        status: 'disabled',
        reason: BREAKER_REASON,
        line: `[plugins] ${plugin.id}: disabled — ${BREAKER_REASON}; its queues are unregistered until the row is reset`,
      }
      return verdict
    }
    if (failed !== null) {
      const reason = `onDisable failed: ${failed}`
      yield* degrade(integrationId, reason)
      const verdict: HostVerdict = {
        integrationId,
        id: plugin.id,
        status: 'degraded',
        reason,
        line: `[plugins] ${plugin.id}: released, degraded — ${reason}`,
      }
      return verdict
    }
    const verdict: HostVerdict = {
      integrationId,
      id: plugin.id,
      status: 'released',
      reason: null,
      line: `[plugins] ${plugin.id}: released`,
    }
    return verdict
  })

  const release = (integrationId: string) =>
    releaseBy(integrationId, 'operator')

  /** Breaker releases in flight; everything that releases waits them out first. */
  const trips = new Set<Fiber.Fiber<void>>()
  const awaitTrips = Effect.suspend(() =>
    Effect.forEach([...trips], Fiber.await, { discard: true }),
  )
  const tripLater = (integrationId: string): void => {
    const fiber = Effect.runFork(
      releaseBy(integrationId, 'breaker').pipe(
        Effect.flatMap((verdict) =>
          Effect.sync(() => {
            if (verdict !== null) console.log(verdict.line)
          }),
        ),
        Effect.catchCause(logFailure(`${integrationId}: breaker release`)),
      ),
    )
    trips.add(fiber)
    fiber.addObserver(() => trips.delete(fiber))
  }

  const wire = Effect.fn('PluginHost.wire')(function* (
    loaded: ReadonlyArray<LoadedPlugin>,
  ) {
    yield* awaitTrips
    const verdicts: Array<HostVerdict> = []
    const keep = new Set(loaded.map((p) => p.integrationId))
    for (const integrationId of [...wired.keys()]) {
      if (keep.has(integrationId)) continue
      const released = yield* release(integrationId)
      if (released !== null) verdicts.push(released)
    }
    for (const plugin of loaded) {
      if (wired.has(plugin.integrationId)) continue
      verdicts.push(yield* wireOne(plugin))
    }
    if (options.queues !== undefined) {
      const scheduled = new Set(
        [...wired.values()].flatMap((plugin) => scheduledQueues(plugin.queues)),
      )
      yield* reconcileSchedules(options.queues, scheduled).pipe(
        Effect.catchCause(logFailure('schedule reconciliation')),
      )
    }
    return verdicts
  })

  const releaseAll = Effect.fn('PluginHost.releaseAll')(function* () {
    yield* awaitTrips
    for (const integrationId of [...wired.keys()]) yield* release(integrationId)
    yield* closeShared
  })

  const shutdown = Effect.fn('PluginHost.shutdown')(function* () {
    yield* awaitTrips
    const plugins = [...wired.values()]
    wired.clear()
    owners.clear()
    for (const plugin of plugins) yield* closeAll(plugin.jobs.values())
    yield* closeShared
  })

  const invoke = (
    integrationId: string,
    jobName: string,
    input: JobInput,
  ): Effect.Effect<JobOutput, JobError> =>
    Effect.suspend(() => {
      const plugin = wired.get(integrationId)
      const job = plugin?.jobs.get(jobName)
      if (plugin === undefined || job === undefined) {
        return Effect.fail(
          new JobPermanent({
            reason:
              plugin === undefined
                ? `integration ${integrationId} has no wired plugin`
                : `${plugin.id} has no job ${jobName}`,
          }),
        )
      }
      const label = `${plugin.id}.${jobName}`
      return Effect.suspend(() => {
        const out = job.run(input)
        return isBundleEffect(out)
          ? out
          : Effect.die(new Error(`${label} did not return an Effect`))
      }).pipe(
        Effect.provideContext(job.context),
        Effect.mapError((error) =>
          isJobError(error)
            ? error
            : new JobPermanent({
                reason: `${label} failed: ${reasonOf(error)}`,
              }),
        ),
        Effect.catchDefect((defect) => {
          const port = notGranted(defect)
          return port === null
            ? Effect.die(defect)
            : Effect.fail(
                new JobPermanent({
                  reason: `${label} used ${port}, which its manifest does not grant it: ${messageOf(defect)}`,
                }),
              )
        }),
        Effect.flatMap((out): Effect.Effect<JobOutput, JobError> => {
          if (job.trigger !== 'schedule') return Effect.void
          const parsed = scheduleOutput.safeParse(out)
          return parsed.success
            ? Effect.succeed(parsed.data)
            : Effect.fail(
                new JobPermanent({
                  reason: `${label} returned no { nextCursor }`,
                }),
              )
        }),
      )
    })

  const granted = (integrationId: string, jobName: string) => {
    const job = wired.get(integrationId)?.jobs.get(jobName)
    return job === undefined
      ? null
      : [...job.context.mapUnsafe.keys()].map(portOfKey).sort()
  }

  return { wire, release, releaseAll, shutdown, invoke, granted }
}
