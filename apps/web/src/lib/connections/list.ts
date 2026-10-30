import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { bundledUseRows } from './providers'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type { AccountsView, ConnectionListRow } from './input'
import { getConfiguredProvidersProgram } from './provider-apps'

/**
 * The session user's own connections for the accounts pages under You.
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
      connectedAt: row.createdAt.toISOString(),
      refreshExpiresAt: row.refreshTokenExpiresAt?.toISOString() ?? null,
    })
  }
  return listed
})

/**
 * What the accounts pages draw: the reader's connections, the providers with
 * an OAuth client, and which bundled plugins are installed and switched on.
 * Those decide between Connect, Configure ›, Ask an admin and "Not available
 * yet".
 */
export const listAccountsProgram = Effect.fn('listAccounts')(function* (
  userId: string,
) {
  const connections = yield* listConnectionsProgram(userId)
  const configured = yield* getConfiguredProvidersProgram()
  const uses = yield* Effect.tryPromise({
    try: () => bundledUseRows(),
    catch: (cause) =>
      new ConnectionsReadFailed({
        message: 'Could not read the installed plugins',
        cause,
      }),
  })
  const view: AccountsView = {
    connections,
    configured,
    installed: uses.map((r) => r.capabilityId),
    enabled: uses.filter((r) => r.enabled).map((r) => r.capabilityId),
  }
  return view
})

/** The server fn's body. `requireUser()` first, always. */
export async function listAccountsHandler(): Promise<AccountsView> {
  const user = await requireUser()
  return effectFn(listAccountsProgram)(user.id)
}
