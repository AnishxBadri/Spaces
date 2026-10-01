import type { Effect } from 'effect'
import type { JobFor } from './contract.ts'
import type { AuthoredManifest } from './manifest.ts'
import type { PortService } from './ports.ts'

/** A lifecycle hook the loader runs when the integration is enabled/disabled. */
export type LifecycleHook = () => Effect.Effect<void, unknown, unknown>

/**
 * One job per name the manifest declares — no more, no fewer — each typed by
 * the trigger its manifest entry declares (D51; the shapes are
 * `contract.ts`'s). A `schedule` job must hand back `{ nextCursor }`, and
 * only an `action` job may carry `cost` (D53).
 *
 * And each job's `R` is bounded by its `uses` (D51, sdk-5): the services it
 * may require are exactly the ports it declared, so a job that yields `Facts`
 * without listing `'Facts'` fails typecheck here — the same grant the loader
 * enforces at runtime, where the undeclared port is "service not found".
 */
export type PluginJobs<TManifest extends AuthoredManifest> = {
  readonly [K in keyof TManifest['jobs']]: JobFor<
    TManifest['jobs'][K]['trigger'],
    PortService<TManifest['jobs'][K]['uses'][number]>
  >
}

export type Plugin<TManifest extends AuthoredManifest = AuthoredManifest> = {
  readonly manifest: TManifest
  readonly jobs: PluginJobs<TManifest>
  readonly onEnable?: LifecycleHook
  readonly onDisable?: LifecycleHook
}

/**
 * The one export a bundle has (`export default definePlugin({ … })`,
 * docs/spec-plugin-sdk.md §6). Identity at runtime; the type is the point:
 * `jobs` must carry exactly the manifest's job names, each shaped by its
 * trigger, so a bundle that declares `enrich` and exports `enrichh` — or
 * writes a schedule job that forgets its cursor — fails typecheck rather
 * than at the first run.
 */
export const definePlugin = <const TManifest extends AuthoredManifest>(
  plugin: Plugin<TManifest>,
): Plugin<TManifest> => plugin
