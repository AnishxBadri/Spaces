import type { Effect } from 'effect'
import type { AuthoredManifest } from './manifest.ts'

/**
 * A job function, before sdk-4a types it per trigger. The parameter is
 * `never` so any input shape is assignable here; sdk-4a replaces this with
 * the five trigger shapes (docs/spec-plugin-sdk.md §5). Until then this
 * slice constrains job *names* only.
 */
export type JobFn = (input: never) => Effect.Effect<unknown, unknown, unknown>

/** A lifecycle hook the loader runs when the integration is enabled/disabled. */
export type LifecycleHook = () => Effect.Effect<void, unknown, unknown>

/** One function per job the manifest declares — no more, no fewer. */
export type PluginJobs<TManifest extends AuthoredManifest> = {
  readonly [K in keyof TManifest['jobs']]: JobFn
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
 * `jobs` must carry exactly the manifest's job names, so a bundle that
 * declares `enrich` and exports `enrichh` fails typecheck rather than
 * registering a queue nobody enqueues.
 */
export const definePlugin = <const TManifest extends AuthoredManifest>(
  plugin: Plugin<TManifest>,
): Plugin<TManifest> => plugin
