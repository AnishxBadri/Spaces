import { Cause, Effect, Fiber } from 'effect'
import type { HostVerdict, PluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { ReconcileOptions, Reconciled, Verdict } from './loader'

/**
 * Re-runs the loader in-process: for one plugin when `plugin_changed` names
 * it, for every plugin on boot and on every (re)connect of the listener.
 *
 * - One plugin: release it (unregister its queues, waiting out a job in
 *   flight; `onDisable`; close its scopes), reconcile its row and files, wire
 *   what comes back. Other plugins are never touched.
 * - Everything: reconcile every row, then `wire`, which reloads only what
 *   changed (`LoadedPlugin.fingerprint`).
 * - Requests coalesce and never run concurrently: they wait `debounceMs`,
 *   and one arriving while a reload runs folds into a single follow-up.
 * - A failed reload is logged, never fatal: the remedy is an ordinary
 *   restart. No exit-75 fallback. (D62)
 */

export type PluginReloaderOptions = {
  readonly host: PluginHost
  /** Defaults to `<dataDir()>/plugins`. */
  readonly pluginsRoot?: string
  /** Defaults to `reconcilePlugins`. */
  readonly reconcile?: (
    options: ReconcileOptions,
  ) => Effect.Effect<Reconciled, Cause.UnknownError>
  /** How long a request waits for others to fold into it. Defaults to 50. */
  readonly debounceMs?: number
  /** Defaults to the console. */
  readonly log?: (line: string) => void
}

export type PluginReloader = {
  /** Reload one plugin by id, or every plugin with null. Returns at once. */
  readonly request: (pluginId: string | null) => void
  /** Completes once nothing is queued or running. */
  readonly settled: () => Effect.Effect<void>
}

type Pending = { all: boolean; readonly ids: Set<string> }

export const makePluginReloader = (
  options: PluginReloaderOptions,
): PluginReloader => {
  const { host } = options
  const reconcile = options.reconcile ?? reconcilePlugins
  const debounceMs = options.debounceMs ?? 50
  const log = options.log ?? ((line: string) => console.log(line))
  const root =
    options.pluginsRoot === undefined
      ? {}
      : { pluginsRoot: options.pluginsRoot }

  let pending: Pending = { all: false, ids: new Set() }
  let draining: Fiber.Fiber<void> | null = null

  const print = (verdicts: ReadonlyArray<Verdict | HostVerdict>) =>
    Effect.sync(() => {
      for (const verdict of verdicts) log(verdict.line)
    })

  const failed = (what: string) => (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      log(
        `[plugins] reload of ${what} failed; restart the worker to recover: ${Cause.pretty(cause)}`,
      )
    })

  const reloadOne = (pluginId: string) =>
    Effect.gen(function* () {
      log(`[plugins] ${pluginId}: reloading`)
      yield* print(yield* host.releasePlugin(pluginId))
      const { verdicts, loaded } = yield* reconcile({ ...root, only: pluginId })
      yield* print(verdicts)
      yield* print(yield* host.wire(loaded, { only: pluginId }))
    }).pipe(Effect.catchCause(failed(pluginId)))

  const reloadAll = Effect.gen(function* () {
    const { verdicts, loaded } = yield* reconcile(root)
    yield* print(verdicts)
    yield* print(yield* host.wire(loaded))
  }).pipe(Effect.catchCause(failed('every plugin')))

  /** The next batch, or null — clearing `draining` in the same step, so no request is stranded. */
  const take = Effect.sync((): Pending | null => {
    const batch = pending
    if (!batch.all && batch.ids.size === 0) {
      draining = null
      return null
    }
    pending = { all: false, ids: new Set() }
    return batch
  })

  const drain = Effect.gen(function* () {
    // Async before the first `take`, so `draining` is assigned before it can be cleared.
    yield* Effect.sleep(debounceMs)
    for (;;) {
      const batch = yield* take
      if (batch === null) return
      for (const id of batch.ids) yield* reloadOne(id)
      if (batch.all) yield* reloadAll
    }
  })

  const request = (pluginId: string | null) => {
    if (pluginId === null) pending.all = true
    else pending.ids.add(pluginId)
    if (draining === null) draining = Effect.runFork(drain)
  }

  const settled = (): Effect.Effect<void> =>
    Effect.suspend(() =>
      draining === null
        ? Effect.void
        : Fiber.await(draining).pipe(Effect.andThen(settled())),
    )

  return { request, settled }
}
