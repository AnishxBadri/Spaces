import { Effect, Layer, Redacted } from 'effect'
import { JobPermanent, NotConnected, Secrets } from '@spaces/sdk'
import { resolveSecretById } from '../vault/index'
import type { BoundIntegration } from './binding'

/**
 * SecretsLive (sdk-6a): the bound row's credential, decrypted through the
 * vault's existing `resolveSecretById` — which rebuilds the AAD from the
 * credential row's own scope and provider — and nothing else. The port takes
 * no id: a plugin cannot name another integration's credential, so the only
 * secret its Layer can hand out is the one on its own row. Worker process
 * only; the value travels as `Redacted`, and LogLive / HttpLive scrub it from
 * every line (`./binding.ts`).
 *
 * Resolved once, when the Layer is built: `secret` is what the binding
 * resolved, so the scrubbers and this port agree on it.
 *
 * `get()` on a row with no credential (or a credential since revoked) fails
 * `JobPermanent` — the frozen contract's shape (sdk-5); the loader's
 * `requires.credential` check (sdk-11) already degrades such a row before a
 * job can run. `accessToken()` is the storage area's (project 20) and fails
 * `NotConnected` until then.
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
        Effect.fail(
          new NotConnected({
            reason: `${row.capabilityId}: OAuth connections arrive with the storage area`,
          }),
        ),
    }),
  )
