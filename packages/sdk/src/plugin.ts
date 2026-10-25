import type { Effect } from 'effect'
import type { JobFor } from './contract.ts'
import type { AuthoredManifest } from './manifest.ts'
import type { Config, Http, Log, PortService, Secrets } from './ports.ts'
import type { StorageSource } from './storage-source.ts'

/** A lifecycle hook the loader runs when the integration is enabled/disabled. */
export type LifecycleHook = () => Effect.Effect<void, unknown, unknown>

/**
 * One job per name the manifest declares — no more, no fewer — each typed by
 * its trigger (`JobFor`). A `schedule` job must hand back `{ nextCursor }`,
 * only an `action` job may carry `cost`, and an action declaring `input:
 * 'payload'` is handed `{ payload }`.
 *
 * Each job's `R` is bounded by its `uses`: a job that yields `Facts` without
 * listing `'Facts'` fails typecheck — the same grant the loader enforces at
 * runtime, where the undeclared port is "service not found".
 */
export type PluginJobs<TManifest extends AuthoredManifest> = {
  readonly [K in keyof TManifest['jobs']]: JobFor<
    TManifest['jobs'][K]['trigger'],
    PortService<TManifest['jobs'][K]['uses'][number]>,
    TManifest['jobs'][K] extends { readonly input: 'payload' }
      ? 'payload'
      : undefined
  >
}

/**
 * How a `provides: 'storage-source'` plugin hands core its provider: an
 * Effect that builds the `StorageSource` over the ambient ports, which the
 * host provides bound to the integration row. The built methods need
 * nothing more — every port they call was taken here.
 */
export type StorageSourceProvider = Effect.Effect<
  StorageSource,
  never,
  Http | Secrets | Log | Config
>

/**
 * `storageSource` follows the manifest: required when it says `provides:
 * 'storage-source'`, refused when it does not. The unparameterised `Plugin`
 * — a loaded bundle, whose manifest is not known statically — may carry one.
 */
export type StorageSourceMember<TManifest extends AuthoredManifest> =
  AuthoredManifest extends TManifest
    ? { readonly storageSource?: StorageSourceProvider }
    : TManifest extends { readonly provides: 'storage-source' }
      ? { readonly storageSource: StorageSourceProvider }
      : { readonly storageSource?: never }

export type Plugin<TManifest extends AuthoredManifest = AuthoredManifest> = {
  readonly manifest: TManifest
  readonly jobs: PluginJobs<TManifest>
  readonly onEnable?: LifecycleHook
  readonly onDisable?: LifecycleHook
} & StorageSourceMember<TManifest>

/**
 * The one export a bundle has (`export default definePlugin({ … })`).
 * Identity at runtime; the type is the point:
 * `jobs` must carry exactly the manifest's job names, each shaped by its
 * trigger, so a bundle that declares `enrich` and exports `enrichh` — or
 * writes a schedule job that forgets its cursor — fails typecheck rather
 * than at the first run. A storage-source plugin without its
 * `storageSource` fails the same way.
 */
export const definePlugin = <const TManifest extends AuthoredManifest>(
  plugin: Plugin<TManifest>,
): Plugin<TManifest> => plugin
