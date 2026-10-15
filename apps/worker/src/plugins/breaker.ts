import { Effect, Layer } from 'effect'
import { PluginBreaker } from '../jobs/plugin-breaker'
import { chargePluginBreaker } from '../run-job'
import type { PluginHost } from './host'

/** The live breaker: the wired integration's, charged and tripped as its queues' are. */
export const pluginBreakerLayer = (
  host: Pick<PluginHost, 'breakerFor'>,
): Layer.Layer<PluginBreaker> =>
  Layer.succeed(
    PluginBreaker,
    PluginBreaker.of({
      charge: (integrationId, error) =>
        Effect.promise(async () => {
          const breaker = host.breakerFor(integrationId)
          if (breaker !== null) await chargePluginBreaker(breaker, error)
        }),
    }),
  )
