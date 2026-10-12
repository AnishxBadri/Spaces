import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { availableProgram } from '#/lib/integrations/install'
import { integrationLedgerProgram } from '#/lib/integrations/ledger'
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
 * an OAuth client, and which plugins are installed or offered by the
 * registry. The plugin decides between Connect, Install › and
 * "Not available yet".
 */
export const listAccountsProgram = Effect.fn('listAccounts')(function* (
  userId: string,
) {
  const connections = yield* listConnectionsProgram(userId)
  const configured = yield* getConfiguredProvidersProgram()
  const ledger = yield* integrationLedgerProgram()
  const installed = [...new Set(ledger.map((r) => r.pluginId))]
  // An unreadable registry offers nothing: those providers read "Not available yet".
  const { available } = yield* availableProgram()
  const offered = available.map((p) => p.pluginId)
  const view: AccountsView = { connections, configured, installed, offered }
  return view
})

/** The server fn's body. `requireUser()` first, always. */
export async function listAccountsHandler(): Promise<AccountsView> {
  const user = await requireUser()
  return effectFn(listAccountsProgram)(user.id)
}
