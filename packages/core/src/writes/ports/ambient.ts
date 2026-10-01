import { Effect, Layer } from 'effect'
import type { z } from 'zod'
import type { Config, Http, Log, Secrets } from '@spaces/sdk'
import { makeScrub } from './binding'
import type { BoundIntegration } from './binding'
import { ConfigLive } from './config'
import type { ConfigInvalid } from './config'
import { HttpLive } from './http'
import type { FetchLike } from './http'
import { LogLive } from './log'
import type { LogSink } from './log'
import { SecretsLive, resolveBoundSecret } from './secrets'

/**
 * The four ambient ports for one integration row, built together (sdk-6a):
 * the credential is resolved once, and the same secret feeds SecretsLive and
 * the scrub LogLive and HttpLive write through. What the loader (sdk-12b)
 * merges with the lane ports a job's `uses` names.
 */
export type AmbientOptions = {
  /** The bundle's own `manifest.settings` zod schema. */
  readonly settings: z.ZodType
  /** `manifest.http.rateLimit.rpm`. */
  readonly rpm?: number
  readonly fetch?: FetchLike
  readonly sink?: LogSink
}

export const AmbientPortsLive = (
  row: BoundIntegration,
  options: AmbientOptions,
): Layer.Layer<Config | Secrets | Log | Http, ConfigInvalid> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const secret = yield* resolveBoundSecret(row)
      const scrub = makeScrub(secret === null ? [] : [secret])
      return Layer.mergeAll(
        ConfigLive(row, options.settings),
        SecretsLive(row, secret),
        LogLive(row.capabilityId, {
          scrub,
          ...(options.sink === undefined ? {} : { sink: options.sink }),
        }),
        HttpLive({
          integrationId: row.id,
          pluginId: row.capabilityId,
          scrub,
          ...(options.rpm === undefined ? {} : { rpm: options.rpm }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      )
    }),
  )
