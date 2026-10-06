import { Effect, Schema } from 'effect'
import { PROVIDERS } from '@spaces/core/providers/registry'
import {
  accessTokenFor,
  connectionState,
} from '@spaces/core/writes/connections/token'
import type { ProviderEndpoints } from '@spaces/core/writes/connections/token'
import { revokeConnection as revokeAtProvider } from '@spaces/core/writes/connections/revoke'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type {
  ConnectionCustodyRow,
  ConnectionIdInput,
  ConnectionRevokeResult,
} from './input'

/**
 * The session user's hand on their own connections: force a refresh, and
 * revoke at the provider (Disconnect, which then deletes the row).
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
