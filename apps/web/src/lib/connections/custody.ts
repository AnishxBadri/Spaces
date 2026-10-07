import { Effect, Schema } from 'effect'
import { PROVIDERS } from '@spaces/core/providers/registry'
import {
  accessTokenFor,
  connectionState,
} from '@spaces/core/writes/connections/token'
import type { ProviderEndpoints } from '@spaces/core/writes/connections/token'
import { revokeConnection as revokeAtProvider } from '@spaces/core/writes/connections/revoke'
import { forgetConnection } from '@spaces/core/writes/connections/list'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type {
  ConnectionCustodyRow,
  ConnectionDisconnectResult,
  ConnectionIdInput,
  ConnectionRevokeResult,
} from './input'

/**
 * The session user's hand on their own connections: force a refresh,
 * revoke at the provider, and Disconnect (revoke, then delete the row).
 * - The core accessor takes no user; ownership is asserted here, before
 *   anything reads the tokens. Someone else's id and an unknown id answer
 *   the same 'Not your connection'.
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

export const refreshConnectionProgram = Effect.fn('refreshConnection')(
  function* (
    userId: string,
    connectionId: string,
    providers: ProviderEndpoints = PROVIDERS,
  ) {
    yield* ownedBy(userId, connectionId)
    yield* accessTokenFor(connectionId, { providers, force: true })
    const row = yield* Effect.promise(() => connectionState(connectionId))
    if (row === undefined)
      return yield* new NotYourConnection({ message: 'Not your connection' })
    const result: ConnectionCustodyRow = {
      connectionId,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }
    return result
  },
)

export const revokeConnectionProgram = Effect.fn('revokeConnection')(function* (
  userId: string,
  connectionId: string,
  providers: ProviderEndpoints = PROVIDERS,
) {
  yield* ownedBy(userId, connectionId)
  const outcome = yield* revokeAtProvider(connectionId, { providers })
  const result: ConnectionRevokeResult = { connectionId, outcome }
  return result
})

type RevokeStep = ConnectionDisconnectResult['revoke']

/**
 * Disconnect: revoke at the provider, then delete the row.
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
    const revoke: RevokeStep = yield* revokeAtProvider(connectionId, {
      providers,
    }).pipe(
      Effect.catchTag('ProviderUnavailable', (error) =>
        Effect.logWarning(
          `disconnecting connection ${connectionId}: the provider could not be asked to revoke (${error.message}); deleting the row anyway`,
        ).pipe(Effect.andThen(Effect.succeed<RevokeStep>('unreachable'))),
      ),
      Effect.catchTag('ConnectionNotFound', () =>
        Effect.fail(new NotYourConnection({ message: 'Not your connection' })),
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

export async function refreshConnectionHandler(
  data: ConnectionIdInput,
  providers: ProviderEndpoints = PROVIDERS,
): Promise<ConnectionCustodyRow> {
  const user = await requireUser()
  return effectFn(refreshConnectionProgram)(
    user.id,
    data.connectionId,
    providers,
  )
}

export async function revokeConnectionHandler(
  data: ConnectionIdInput,
  providers: ProviderEndpoints = PROVIDERS,
): Promise<ConnectionRevokeResult> {
  const user = await requireUser()
  return effectFn(revokeConnectionProgram)(
    user.id,
    data.connectionId,
    providers,
  )
}

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
