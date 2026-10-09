import { Effect, Layer } from 'effect'
import { EnrichmentSources } from '@spaces/core/enrichment/sources'
import type { AskInput, AskResult } from '@spaces/core/enrichment/sources'
import { enrichActionFor } from '@spaces/core/enrichment/settings'
import { costOf, creditDefaults, guardAction } from './credit'
import type { PluginHost } from './host'

/**
 * The worker's `EnrichmentSources`: a source's enrich action run in process
 * on its wired Layer, behind the same credit guard as its queue (D53) — a
 * receipt younger than the reuse window or a reached cap declines before
 * any call.
 */
export const EnrichmentSourcesLive = (
  host: PluginHost,
): Layer.Layer<EnrichmentSources> =>
  Layer.succeed(
    EnrichmentSources,
    EnrichmentSources.of({
      ask: Effect.fn('EnrichmentSources.ask')(function* (
        integrationId: string,
        input: AskInput,
      ) {
        const declined = (reason: string): AskResult => ({
          asked: false,
          reason,
        })
        const plugin = host.loaded(integrationId)
        if (plugin === null) return declined('not loaded')
        const action = enrichActionFor(plugin.manifest, input.kind)
        if (action === null)
          return declined(`no enrich action for ${input.kind}`)
        const skipped = yield* guardAction({
          integrationId,
          entityId: input.entityId,
          defaults: creditDefaults(plugin.manifest),
          cost: costOf(plugin.jobs[action.job]),
          ...(input.reuseDays === null ? {} : { cacheDays: input.reuseDays }),
        }).pipe(
          Effect.as(null),
          Effect.catchTag('JobSkipped', (skip) => Effect.succeed(skip.reason)),
        )
        if (skipped !== null) return declined(skipped)
        yield* host.invoke(integrationId, action.job, {
          entityId: input.entityId,
          keys: input.keys,
        })
        const asked: AskResult = { asked: true }
        return asked
      }),
    }),
  )
