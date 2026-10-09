import { Data, Effect, Layer, Redacted } from 'effect'
import type { z } from 'zod'
import { Secrets } from '@spaces/sdk'
import type { PortName, Trigger } from '@spaces/sdk'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { AiLive } from '@spaces/core/writes/ports/ai'
import type { ModelCall } from '@spaces/core/writes/ports/ai'
import { AmbientPortsLive } from '@spaces/core/writes/ports/ambient'
import type { BoundIntegration } from '@spaces/core/writes/ports/binding'
import type { ConfigInvalid } from '@spaces/core/writes/ports/config'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { FactsLive } from '@spaces/core/writes/ports/facts'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { IdentityLive } from '@spaces/core/writes/ports/identity'
import { ImportLive } from '@spaces/core/writes/ports/import'
import { JudgmentLive } from '@spaces/core/writes/ports/judgment'
import type { LogSink } from '@spaces/core/writes/ports/log'
import { ReadLive } from '@spaces/core/writes/ports/read'
import { ReceiptsLive } from '@spaces/core/writes/ports/receipts'
import { SpacesLive } from '@spaces/core/writes/ports/spaces'
import { standInFor } from './fakes/switch'
import type { FakeProviders, StandIn } from './fakes/switch'
import { PluginDbLive } from './plugin-db'

/**
 * The grant: the Layer one (integration, job) runs on, built from exactly
 * the ports the job's `uses` names and bound to the row (D51).
 *
 * - There is no port table: `uses` is the grant. The host picks the declared
 *   tags out of what this builds, so an ambient port the job did not name
 *   never reaches it.
 * - `Enqueue` is provided to the lanes that hand work back and is never one
 *   of the job's services.
 */

/** A port the grant was asked for and cannot build. */
export class PortUnprovided extends Data.TaggedError('PortUnprovided')<{
  readonly reason: string
}> {}

const AMBIENT: ReadonlyArray<PortName> = ['Config', 'Secrets', 'Log', 'Http']

/** What every grant shares, from the host and the bundle. */
export type GrantOptions = {
  /** The bundle's `manifest.settings` zod schema. */
  readonly settings: z.ZodType
  /** `manifest.http.rateLimit.rpm`. */
  readonly rpm?: number
  /** The host's shared sender; building it opens nothing the job's scope owns. */
  readonly enqueue: Layer.Layer<Enqueue>
  readonly fetch?: FetchLike
  readonly sink?: LogSink
  /** `SPACES_FAKE_PROVIDERS`: a fake standing in for this plugin's provider wins over `fetch`. */
  readonly fakes?: FakeProviders | null
  /** What `Ai` needs: the job's trigger, which fixes its lanes, and the model call. */
  readonly ai?: {
    readonly trigger: Trigger
    readonly modelCall: Layer.Layer<ModelCall>
  }
}

/** The bound Secrets with a stand-in's access token, and its key when `secret` is given. */
const standInSecrets = (
  standIn: StandIn,
  secret: string | null,
): Layer.Layer<Secrets, never, Secrets> =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const bound = yield* Secrets
      return Secrets.of({
        get:
          secret === null
            ? bound.get
            : () => Effect.succeed(Redacted.make(secret)),
        accessToken: () => Effect.succeed(Redacted.make(standIn.accessToken)),
      })
    }),
  )

const mergeList = <TError, TIn>(
  layers: ReadonlyArray<Layer.Layer<never, TError, TIn>>,
): Layer.Layer<never, TError, TIn> =>
  layers.reduce<Layer.Layer<never, TError, TIn>>(
    (merged, layer) => Layer.merge(merged, layer),
    Layer.empty,
  )

/**
 * The Layer for one job. Its static output is `never` on purpose: which
 * services it holds is decided by `uses` at runtime, and the job's `R` did
 * not survive the bundle boundary to be checked against it.
 */
export const grantLayer = (
  row: BoundIntegration,
  uses: ReadonlyArray<PortName>,
  options: GrantOptions,
): Layer.Layer<never, ConfigInvalid | PortUnprovided> => {
  const standalone: Array<Layer.Layer<never, ConfigInvalid | PortUnprovided>> =
    []
  const handsBack: Array<Layer.Layer<never, never, Enqueue>> = []

  if (uses.some((port) => AMBIENT.includes(port))) {
    const standIn = standInFor(options.fakes, row.capabilityId)
    const fetch = standIn?.fetch ?? options.fetch
    const ambient = AmbientPortsLive(row, {
      settings: options.settings,
      ...(options.rpm === undefined ? {} : { rpm: options.rpm }),
      ...(fetch === undefined ? {} : { fetch }),
      ...(options.sink === undefined ? {} : { sink: options.sink }),
    })
    // A faked plugin's Secrets, merged last so it is the one the job sees:
    // the fake's access token, and the fake's key for an unkeyed row (a
    // bound credential is still used).
    standalone.push(
      standIn === null
        ? ambient
        : Layer.merge(
            ambient,
            Layer.provide(
              standInSecrets(
                standIn,
                row.credentialId === null ? standIn.secret : null,
              ),
              ambient,
            ),
          ),
    )
  }
  for (const port of new Set(uses)) {
    switch (port) {
      case 'Identity':
        handsBack.push(IdentityLive(row))
        break
      case 'Facts':
        handsBack.push(FactsLive(row))
        break
      case 'Content':
        handsBack.push(ContentLive(row))
        break
      case 'Judgment':
        standalone.push(JudgmentLive(row))
        break
      case 'Receipts':
        standalone.push(ReceiptsLive(row))
        break
      case 'Read':
        standalone.push(ReadLive(row))
        break
      case 'Import':
        standalone.push(ImportLive(row))
        break
      case 'PluginDb':
        standalone.push(PluginDbLive(row))
        break
      case 'Spaces':
        standalone.push(SpacesLive(row))
        break
      // The host provides no Discover: declared, it builds nothing, and a job
      // that reaches for it fails "service not found".
      case 'Discover':
        break
      case 'Ai':
        standalone.push(
          options.ai === undefined
            ? Layer.effectDiscard(
                Effect.fail(
                  new PortUnprovided({
                    reason: 'Ai was granted without the job it runs for',
                  }),
                ),
              )
            : Layer.provide(
                AiLive(row, { trigger: options.ai.trigger }),
                options.ai.modelCall,
              ),
        )
        break
      case 'Config':
      case 'Secrets':
      case 'Log':
      case 'Http':
        break
    }
  }
  if (handsBack.length > 0) {
    standalone.push(Layer.provide(mergeList(handsBack), options.enqueue))
  }
  return mergeList(standalone)
}
