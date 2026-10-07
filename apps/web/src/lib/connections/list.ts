import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type { ConnectionListRow } from './input'

/**
 * The session user's own connections for Settings → Connections.
 * - The user is the session's, never an argument: a member sees only their
 *   rows, an admin too.
 * - A row under a provider the registry no longer lists is left out.
 */

export class ConnectionsReadFailed extends Schema.TaggedError<ConnectionsReadFailed>()(
  'ConnectionsReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const listConnectionsProgram = Effect.fn('listConnections')(function* (
  userId: string,
): Effect.fn.Return<ConnectionListRow[], ConnectionsReadFailed> {
  const rows = yield* Effect.tryPromise({
    try: () => listConnectionsFor(userId),
    catch: (cause) =>
      new ConnectionsReadFailed({
        message: 'Could not read your connections',
        cause,
      }),
  })
  const listed: ConnectionListRow[] = []
  for (const row of rows) {
    const provider = row.provider
    if (!isProviderId(provider)) continue
    listed.push({
      connectionId: row.id,
      provider,
      product: row.product,
      externalEmail: row.externalEmail,
      scopes: [...row.scopes],
      status: row.status,
      errorReason: row.errorReason,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    })
  }
  return listed
})

/** The server fn's body. `requireUser()` first, always. */
export async function listConnectionsHandler(): Promise<ConnectionListRow[]> {
  const user = await requireUser()
  return effectFn(listConnectionsProgram)(user.id)
}
