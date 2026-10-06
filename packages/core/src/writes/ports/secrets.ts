import { Effect, Layer, Redacted } from 'effect'
import { JobPermanent, NotConnected, Secrets } from '@spaces/sdk'
import { accessTokenFor } from '../connections/token'
import { resolveSecretById } from '../vault/index'
import type { BoundIntegration } from './binding'

/**
 * SecretsLive: the bound row's credential and OAuth connection, and nothing
 * else. The port takes no id, so a plugin cannot name another integration's
 * secret. Worker process only; values travel as `Redacted`.
 * - `get()`: the credential `resolveBoundSecret` decrypted once when the
 *   Layer was built (the scrubbers hold the same value). None bound →
 *   `JobPermanent`.
 * - `accessToken()`: `accessTokenFor` on the row's `connection_id`, fresh
 *   on every call — refreshed under the row lock when it is about to lapse.
 *   No connection, or one that fails, → `NotConnected` with the reason.
 */
export const resolveBoundSecret = (
  row: BoundIntegration,
): Effect.Effect<string | null> =>
  row.credentialId === null
    ? Effect.succeed(null)
    : Effect.promise(() => resolveSecretById(row.credentialId ?? ''))

export const SecretsLive = (
  row: BoundIntegration,
  secret: string | null,
): Layer.Layer<Secrets> =>
  Layer.succeed(
    Secrets,
    Secrets.of({
      get: () =>
        secret === null
          ? Effect.fail(
              new JobPermanent({
                reason: `${row.capabilityId} has no active credential bound`,
              }),
            )
          : Effect.succeed(Redacted.make(secret)),
      accessToken: () =>
        row.connectionId === null
          ? Effect.fail(
              new NotConnected({
                reason: `${row.capabilityId} has no OAuth connection bound`,
              }),
            )
          : accessTokenFor(row.connectionId).pipe(
              Effect.mapError(
                (e) =>
                  new NotConnected({
                    reason: `${row.capabilityId}: ${e.message}`,
                  }),
              ),
            ),
    }),
  )
