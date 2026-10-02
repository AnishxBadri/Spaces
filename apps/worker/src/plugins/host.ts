import { Cause, Context, Effect, Exit, Layer, Predicate, Scope } from 'effect'
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
import { grantLayer } from './grant'
import { messageOf, truncate } from './loader'
import type { LoadedHook, LoadedPlugin } from './loader'

/**
 * The plugin host: loader step six. For each loaded plugin it builds one
 * scoped Layer per (integration, job) from that job's `uses` (D51), caches
 * it, runs jobs through it (`invoke`), and closes the scopes on release.
 *
 * - The Layer is the privilege boundary: a job that reaches for a port it
 *   did not declare dies with "Service not found", which `invoke` maps to
 *   `JobPermanent`.
 * - `onEnable` runs once when a plugin is wired, `onDisable` when it is
 *   released. A failing hook degrades that plugin and no other.
 */

/** What a job is handed, by its trigger. */
export type JobInput =
  ActionInput | ScheduleInput | EventInput | WebhookInput | FileInput

/** What a job hands back: a schedule job's cursor, nothing for the rest. */
export type JobOutput = ScheduleOutput | void

export type PluginHostOptions = {
  /** Built inside each job's scope, so its pool closes when the job's Layer is released. */
  readonly enqueue: LayerType.Layer<Enqueue>
  readonly fetch?: FetchLike
  readonly sink?: LogSink
}

/** One plugin's outcome from `wire` or `release`, and the line boot prints. */
export type HostVerdict = {
  readonly integrationId: string
  readonly id: string
  readonly status: 'enabled' | 'degraded' | 'released'
  readonly reason: string | null
  readonly line: string
}

export type PluginHost = {
  /** Wire every loaded plugin not yet wired; release every wired one no longer loaded. */
  readonly wire: (
    loaded: ReadonlyArray<LoadedPlugin>,
  ) => Effect.Effect<ReadonlyArray<HostVerdict>, Cause.UnknownError>
  /** Run `onDisable`, then close every job scope of this integration. */
  readonly release: (
    integrationId: string,
  ) => Effect.Effect<HostVerdict | null, Cause.UnknownError>
  readonly releaseAll: () => Effect.Effect<void, Cause.UnknownError>
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
          enqueue: options.enqueue,
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
    if (plugin.onEnable !== undefined) {
      const failed = yield* runHook(plugin.onEnable)
      if (failed !== null) {
        yield* closeAll(jobs.values())
        return yield* degraded(plugin, `onEnable failed: ${failed}`)
      }
    }
    wired.set(plugin.integrationId, {
      id: plugin.manifest.id,
      jobs,
      ...(plugin.onDisable === undefined
        ? {}
        : { onDisable: plugin.onDisable }),
    })
    const verdict: HostVerdict = {
      integrationId: plugin.integrationId,
      id: plugin.manifest.id,
      status: 'enabled',
      reason: null,
      line: `[plugins] ${plugin.manifest.id}: wired ${[...jobs.keys()].join(', ')}`,
    }
    return verdict
  })

  const release = Effect.fn('PluginHost.release')(function* (
    integrationId: string,
  ) {
    const plugin = wired.get(integrationId)
    if (plugin === undefined) return null
    wired.delete(integrationId)
    const failed =
      plugin.onDisable === undefined ? null : yield* runHook(plugin.onDisable)
    yield* closeAll(plugin.jobs.values())
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

  const wire = Effect.fn('PluginHost.wire')(function* (
    loaded: ReadonlyArray<LoadedPlugin>,
  ) {
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
    return verdicts
  })

  const releaseAll = Effect.fn('PluginHost.releaseAll')(function* () {
    for (const integrationId of [...wired.keys()]) yield* release(integrationId)
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

  return { wire, release, releaseAll, invoke, granted }
}
