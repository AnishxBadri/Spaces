import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Scope,
} from 'effect'
import type { Layer as LayerType } from 'effect'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import {
  Ai,
  ConnectionRefused,
  CursorInvalid,
  Discover,
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
  PortName,
  ScheduleInput,
  ScheduleOutput,
  Trigger,
  WatchInput,
  WatchOutput,
  WebhookInput,
} from '@spaces/sdk'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import type { MeetingLane } from '@spaces/core/writes/interactions/meeting-lane'
import type { EmailLane } from '@spaces/core/writes/interactions/email-lane'
import {
  markBoundConnectionRefused,
  markConnectionRefused,
} from '@spaces/core/writes/connections/refused'
import { AiBinder } from '@spaces/core/writes/ports/ai'
import { DiscoverBinder } from '@spaces/core/writes/ports/discover'
import type { DiscoverBinding } from '@spaces/core/writes/ports/discover'
import type { ModelCall } from '@spaces/core/writes/ports/ai'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import type { LogSink } from '@spaces/core/writes/ports/log'
import { BREAKER_REASON } from '../run-job'
import type { JobBreaker } from '../run-job'
import type { FakeProviders } from './fakes/switch'
import { grantLayer } from './grant'
import type { GrantOptions } from './grant'
import { messageOf, truncate } from './loader'
import type { LoadedHook, LoadedPlugin } from './loader'
import { ModelCallLive } from './model-call'
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
 * - `Ai` is built once per (integration, job) and bound per invocation to
 *   the entity the job runs on (`AiBinder`): sensitivity is resolved from
 *   that entity, never from anything the plugin passes.
 * - `Discover` is bound the same way to a watch run's watch and space
 *   (`DiscoverBinder`); outside a watch run it refuses.
 * - One `Enqueue` serves every job, built in the host's own scope: closing a
 *   job's scope closes its ports and never the shared sender.
 * - A tripped breaker releases its plugin from a detached fiber, never from
 *   the job that tripped it: `offWork` waits out that job, so it cannot wait
 *   inside it. The row says `disabled`; `release` never degrades it.
 * - Not safe to call concurrently: after boot, `makePluginReloader`
 *   serializes every `wire` and `releasePlugin`.
 */

/** What a job is handed, by its trigger. */
export type JobInput =
  | ActionInput
  | ScheduleInput
  | EventInput
  | WebhookInput
  | FileInput
  | WatchInput

/** What a job hands back: a schedule job's cursor, a watch's state, nothing for the rest. */
export type JobOutput = ScheduleOutput | ScheduleReset | WatchOutput | void

/** A schedule job failed `CursorInvalid`: the stored cursor is cleared, and why. */
export type ScheduleReset = {
  readonly nextCursor: null
  readonly cursorInvalid: string
}

export type PluginHostOptions = {
  /** Built once, on the first job that hands work back; closed by `releaseAll` or `shutdown`. */
  readonly enqueue: LayerType.Layer<Enqueue>
  /** What `Content.logMeeting` files through; every meeting is refused without it. */
  readonly meetings?: LayerType.Layer<MeetingLane>
  /** What `Content.logEmail` files through; every message is refused without it. */
  readonly mail?: LayerType.Layer<EmailLane>
  /** pg-boss and the wrapper's seams; without it no queue is registered. */
  readonly queues?: PluginQueuesOptions
  readonly fetch?: FetchLike
  readonly sink?: LogSink
  /** `SPACES_FAKE_PROVIDERS`: what the grant swaps in for a faked provider. */
  readonly fakes?: FakeProviders | null
  /** The model call every `Ai` grant runs on; `complete()` when omitted. */
  readonly modelCall?: LayerType.Layer<ModelCall>
}

/** One plugin's outcome from `wire` or `release`, and the line boot prints. */
export type HostVerdict = {
  readonly integrationId: string
  readonly id: string
  readonly status: 'enabled' | 'degraded' | 'released' | 'disabled'
  readonly reason: string | null
  readonly line: string
}

export type WireOptions = {
  /** `loaded` is this plugin's rows only: wired plugins with another id are left alone. */
  readonly only?: string
}

export type PluginHost = {
  /**
   * Wire every loaded plugin not yet wired; release every wired one no longer
   * loaded or whose fingerprint changed (a new bundle or a rebound row).
   */
  readonly wire: (
    loaded: ReadonlyArray<LoadedPlugin>,
    options?: WireOptions,
  ) => Effect.Effect<ReadonlyArray<HostVerdict>, Cause.UnknownError>
  /** Unregister its queues, run `onDisable`, then close every job scope of this integration. */
  readonly release: (
    integrationId: string,
  ) => Effect.Effect<HostVerdict | null, Cause.UnknownError>
  /** `release` every wired integration of one plugin id. */
  readonly releasePlugin: (
    pluginId: string,
  ) => Effect.Effect<ReadonlyArray<HostVerdict>, Cause.UnknownError>
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
  /** The plugin as loaded for a wired integration; null when it is not wired. */
  readonly loaded: (integrationId: string) => LoadedPlugin | null
  /** A wired integration's breaker, for a core job that ran its provider; null when not wired. */
  readonly breakerFor: (integrationId: string) => JobBreaker | null
}

type JobRun = (input: JobInput) => unknown

type WiredJob = JobContext & {
  readonly trigger: Trigger
  readonly uses: ReadonlyArray<PortName>
  readonly run: JobRun
  readonly scope: Scope.Closeable
}

/** A built grant as a job reaches it. */
type JobContext = {
  readonly context: Context.Context<never>
  /** Binds `Ai` to one invocation's subject; null when the job has no Ai. */
  readonly bindAi: AiBinder['Service']['bind'] | null
  /** Binds `Discover` to one watch run; null when the job has no Discover. */
  readonly bindDiscover: DiscoverBinder['Service']['bind'] | null
}

/** Exactly the declared tags: an ambient port built alongside a declared one never reaches the job. */
const jobContext = (
  built: Context.Context<never>,
  uses: ReadonlyArray<PortName>,
): JobContext => ({
  context: Context.pick(...uses.map((port) => PORTS[port]))(built),
  bindAi: Option.match(Context.getOption(built, AiBinder), {
    onNone: () => null,
    onSome: (binder) => binder.bind,
  }),
  bindDiscover: Option.match(Context.getOption(built, DiscoverBinder), {
    onNone: () => null,
    onSome: (binder) => binder.bind,
  }),
})

type Wired = {
  readonly id: string
  readonly plugin: LoadedPlugin
  readonly fingerprint: string
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
const watchOutput = z.object({
  state: z.record(z.string(), z.json()).nullable(),
})

/**
 * The entity an invocation runs on, which `Ai` resolves sensitivity from.
 * An action, event or watch job always has one — a watch's is its space: a
 * missing id binds `''`, which the port refuses rather than reading as "no
 * record".
 */
const subjectOf = (trigger: Trigger, input: JobInput): string | null => {
  if (trigger === 'action')
    return Predicate.hasProperty(input, 'entityId') &&
      Predicate.isString(input.entityId)
      ? input.entityId
      : ''
  if (trigger === 'watch')
    return Predicate.hasProperty(input, 'spaceId') &&
      Predicate.isString(input.spaceId)
      ? input.spaceId
      : ''
  if (trigger === 'event')
    return Predicate.hasProperty(input, 'event') &&
      Predicate.hasProperty(input.event, 'entityId') &&
      Predicate.isString(input.event.entityId)
      ? input.event.entityId
      : ''
  return null
}

/** The watch run an invocation is, or null for any other trigger. */
const watchOf = (trigger: Trigger, input: JobInput): DiscoverBinding | null =>
  trigger === 'watch' &&
  Predicate.hasProperty(input, 'watchId') &&
  Predicate.isString(input.watchId) &&
  Predicate.hasProperty(input, 'spaceId') &&
  Predicate.isString(input.spaceId)
    ? { watchId: input.watchId, spaceId: input.spaceId }
    : null

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
  const modelCall = options.modelCall ?? ModelCallLive()
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

  /** What every grant of this plugin's job is built with. */
  const grantOptions = (
    plugin: LoadedPlugin,
    declared: { readonly trigger: Trigger },
  ): GrantOptions => ({
    settings: plugin.settings,
    enqueue: sharedEnqueue,
    ...(options.meetings === undefined ? {} : { meetings: options.meetings }),
    ...(options.mail === undefined ? {} : { mail: options.mail }),
    ...(plugin.manifest.http?.rateLimit === undefined
      ? {}
      : { rpm: plugin.manifest.http.rateLimit.rpm }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.fakes === undefined ? {} : { fakes: options.fakes }),
    ai: { trigger: declared.trigger, modelCall },
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
        grantLayer(plugin.row, declared.uses, grantOptions(plugin, declared)),
        scope,
      ).pipe(Effect.exit)
      if (Exit.isFailure(built)) {
        yield* Scope.close(scope, built)
        yield* closeAll(jobs.values())
        return yield* degraded(plugin, describeCause(built.cause))
      }
      jobs.set(name, {
        trigger: declared.trigger,
        uses: declared.uses,
        run,
        scope,
        ...jobContext(built.value, declared.uses),
      })
    }
    const plans =
      options.queues === undefined
        ? []
        : pluginQueues(plugin.manifest, plugin.jobs)
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
      plugin,
      fingerprint: plugin.fingerprint,
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
  /** Releases in flight: a second release of one integration waits out the first. */
  const releasing = new Map<string, Deferred.Deferred<void>>()

  const releaseBy = Effect.fn('PluginHost.release')(function* (
    integrationId: string,
    by: 'operator' | 'breaker',
  ) {
    const inFlight = releasing.get(integrationId)
    if (inFlight !== undefined) {
      yield* Deferred.await(inFlight)
      return null
    }
    const plugin = wired.get(integrationId)
    if (plugin === undefined) return null
    const done = yield* Deferred.make<void>()
    releasing.set(integrationId, done)
    return yield* releaseWired(integrationId, plugin, by).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          releasing.delete(integrationId)
          return Deferred.succeed(done, undefined)
        }),
      ),
    )
  })

  const releaseWired = Effect.fn('PluginHost.releaseWired')(function* (
    integrationId: string,
    plugin: Wired,
    by: 'operator' | 'breaker',
  ) {
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

  const releasePlugin = Effect.fn('PluginHost.releasePlugin')(function* (
    pluginId: string,
  ) {
    yield* awaitTrips
    const verdicts: Array<HostVerdict> = []
    for (const [integrationId, plugin] of [...wired.entries()]) {
      if (plugin.id !== pluginId) continue
      const released = yield* release(integrationId)
      if (released !== null) verdicts.push(released)
    }
    return verdicts
  })

  const wire = Effect.fn('PluginHost.wire')(function* (
    loaded: ReadonlyArray<LoadedPlugin>,
    wireOptions: WireOptions = {},
  ) {
    yield* awaitTrips
    const verdicts: Array<HostVerdict> = []
    const keep = new Map(loaded.map((p) => [p.integrationId, p.fingerprint]))
    for (const [integrationId, plugin] of [...wired.entries()]) {
      if (wireOptions.only !== undefined && plugin.id !== wireOptions.only)
        continue
      if (keep.get(integrationId) === plugin.fingerprint) continue
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
    connectionId?: string,
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
      if (connectionId === undefined)
        return runJobOn(integrationId, plugin, jobName, job, job, input, null)
      // One member's run (D78): the same grant, bound to their connection,
      // built for this invocation and closed with it.
      return Effect.scoped(
        Layer.build(
          grantLayer(
            { ...plugin.plugin.row, connectionId },
            job.uses,
            grantOptions(plugin.plugin, job),
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new JobPermanent({
                reason: `${plugin.id}.${jobName}: ${messageOf(error)}`,
              }),
          ),
          Effect.flatMap((built) =>
            runJobOn(
              integrationId,
              plugin,
              jobName,
              job,
              jobContext(built, job.uses),
              input,
              connectionId,
            ),
          ),
        ),
      )
    })

  const runJobOn = (
    integrationId: string,
    plugin: Wired,
    jobName: string,
    job: WiredJob,
    on: JobContext,
    input: JobInput,
    connectionId: string | null,
  ): Effect.Effect<JobOutput, JobError> =>
    Effect.suspend(() => {
      const label = `${plugin.id}.${jobName}`
      // Ai is bound here, per invocation, to the entity the job runs on;
      // Discover to the watch run.
      const withAi =
        on.bindAi === null
          ? on.context
          : Context.add(
              on.context,
              Ai,
              on.bindAi(subjectOf(job.trigger, input)),
            )
      const context =
        on.bindDiscover === null
          ? withAi
          : Context.add(
              withAi,
              Discover,
              on.bindDiscover(watchOf(job.trigger, input)),
            )
      return Effect.suspend(() => {
        const out = job.run(input)
        return isBundleEffect(out)
          ? out
          : Effect.die(new Error(`${label} did not return an Effect`))
      }).pipe(
        Effect.provideContext(context),
        Effect.mapError((error) =>
          isJobError(error) ||
          error instanceof ConnectionRefused ||
          (job.trigger === 'schedule' && error instanceof CursorInvalid)
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
          if (job.trigger === 'watch') {
            const parsed = watchOutput.safeParse(out)
            return parsed.success
              ? Effect.succeed(parsed.data)
              : Effect.fail(
                  new JobPermanent({
                    reason: `${label} returned no { state } object or null`,
                  }),
                )
          }
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
        // An expired cursor is an outcome, not a failure: the run closes and
        // the cursor is cleared with it.
        Effect.catchTag('CursorInvalid', (error) =>
          Effect.succeed<ScheduleReset>({
            nextCursor: null,
            cursorInvalid: error.reason,
          }),
        ),
        // A refused grant marks the connection and is never retried: the
        // next attempt would send the same refused token.
        Effect.catchTag('ConnectionRefused', (error) =>
          Effect.promise(() =>
            (connectionId === null
              ? markBoundConnectionRefused(integrationId, error.reason)
              : markConnectionRefused(connectionId, error.reason)
            ).catch(() => false),
          ).pipe(
            Effect.andThen(
              Effect.fail(new JobPermanent({ reason: error.reason })),
            ),
          ),
        ),
      )
    })

  const granted = (integrationId: string, jobName: string) => {
    const job = wired.get(integrationId)?.jobs.get(jobName)
    return job === undefined
      ? null
      : [...job.context.mapUnsafe.keys()].map(portOfKey).sort()
  }

  const loaded = (integrationId: string) =>
    wired.get(integrationId)?.plugin ?? null

  const breakerFor = (integrationId: string): JobBreaker | null => {
    const plugin = wired.get(integrationId)
    return plugin === undefined
      ? null
      : {
          integrationId,
          group: breakerGroup(plugin.id),
          onTrip: () => tripLater(integrationId),
        }
  }

  return {
    wire,
    release,
    releasePlugin,
    releaseAll,
    shutdown,
    invoke,
    granted,
    loaded,
    breakerFor,
  }
}
