import { Context } from 'effect'
import type { Effect } from 'effect'

/**
 * A plugin's breaker, for a core job that runs a plugin's provider in
 * process: the failure is the plugin's, so it is charged to the plugin as a
 * failed attempt on its own queues is. The live Layer is the plugin host's
 * (`pluginBreakerLayer`). Never fails.
 */
export class PluginBreaker extends Context.Service<
  PluginBreaker,
  {
    readonly charge: (
      integrationId: string,
      error: string,
    ) => Effect.Effect<void>
  }
>()('spaces/worker/jobs/PluginBreaker') {}
