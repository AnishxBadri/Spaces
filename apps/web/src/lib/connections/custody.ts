import { Effect, Schema } from 'effect'
import { PROVIDERS } from '@spaces/core/providers/registry'
import { connectionState } from '@spaces/core/writes/connections/token'
import type { ProviderEndpoints } from '@spaces/core/writes/connections/token'
import { revokeConnection as revokeAtProvider } from '@spaces/core/writes/connections/revoke'
import {
  forgetConnection,
  listConnectionsFor,
} from '@spaces/core/writes/connections/list'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type { ConnectionDisconnectResult, ConnectionIdInput } from './input'

/**
 * The session user's hand on their own connections: Disconnect (delete the
 * row, revoking at the provider when it was the account's last product).
 * - Core takes no user; ownership is asserted here, before anything reads
 *   the tokens. Someone else's id and an unknown id answer the same
 *   'Not your connection'.
 * - The token itself never leaves the server.
 */

export class NotYourConnection extends Schema.TaggedError<NotYourConnection>()(
  'NotYourConnection',
  { message: Schema.String },
) {}

const ownedBy = Effect.fn('connectionOwnedBy')(function* (
  userId: string,
  connectionId: string,
): Effect.fn.Return<void, NotYourConnection> {
  const row = yield* Effect.promise(() => connectionState(connectionId))
  if (row?.userId !== userId)
    return yield* new NotYourConnection({ message: 'Not your connection' })
})

type RevokeStep = ConnectionDisconnectResult['revoke']

/** Whether another live product row of the user's holds the same account's grant. */
const sharesGrant = Effect.fn('connectionSharesGrant')(function* (
  userId: string,
  connectionId: string,
) {
  const rows = yield* Effect.promise(() => listConnectionsFor(userId))
  const self = rows.find((r) => r.id === connectionId)
  if (self === undefined) return false
  return rows.some(
    (r) =>
      r.id !== connectionId &&
      r.provider === self.provider &&
      r.externalEmail === self.externalEmail &&
      r.status !== 'revoked',
  )
})

/**
 * Disconnect one product: delete its row, and revoke at the provider only
 * when it was the account's last live product row. (D81)
 * - Google's revoke ends the whole grant for the account, so while a Mail,
 *   Calendar or Drive row for the same address is live the grant is `kept`.
 *   A sibling already `revoked` holds no grant and does not count.
 * - A 4xx is `already-revoked` (core logs it); an outage is `unreachable`,
 *   logged here, and the row goes anyway — a provider that already forgot
 *   the grant cannot strand it.
 * - `forgetConnection` unlinks the documents and integrations that pointed
 *   at the row in the same transaction; the files stay.
 */
export const disconnectConnectionProgram = Effect.fn('disconnectConnection')(
  function* (
    userId: string,
    connectionId: string,
    providers: ProviderEndpoints = PROVIDERS,
  ) {
    yield* ownedBy(userId, connectionId)
    const shared = yield* sharesGrant(userId, connectionId)
    const revoke: RevokeStep = shared
      ? 'kept'
      : yield* revokeAtProvider(connectionId, {
          providers,
        }).pipe(
          Effect.catchTag('ProviderUnavailable', (error) =>
            Effect.logWarning(
              `disconnecting connection ${connectionId}: the provider could not be asked to revoke (${error.message}); deleting the row anyway`,
            ).pipe(Effect.andThen(Effect.succeed<RevokeStep>('unreachable'))),
          ),
          Effect.catchTag('ConnectionNotFound', () =>
            Effect.fail(
              new NotYourConnection({ message: 'Not your connection' }),
            ),
          ),
        )
    const forgotten = yield* Effect.promise(() =>
      forgetConnection(userId, connectionId),
    )
    if (!forgotten)
      return yield* new NotYourConnection({ message: 'Not your connection' })
    const result: ConnectionDisconnectResult = { connectionId, revoke }
    return result
  },
)

// The server fns' bodies. `requireUser()` first, always.

export async function disconnectConnectionHandler(
  data: ConnectionIdInput,
  providers: ProviderEndpoints = PROVIDERS,
): Promise<ConnectionDisconnectResult> {
  const user = await requireUser()
  return effectFn(disconnectConnectionProgram)(
    user.id,
    data.connectionId,
    providers,
  )
}
