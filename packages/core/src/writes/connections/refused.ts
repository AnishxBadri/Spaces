import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import type { ConnectionDb } from './token'

/**
 * The provider refused the grant an integration is bound to: its connection
 * goes to `error` with the provider's reason, which the accounts pages show
 * beside Reconnect, and `accessTokenFor` answers `AuthExpired` from then on
 * without calling the provider. A revoked row stays revoked.
 * Answers whether a connection was marked.
 */
export async function markBoundConnectionRefused(
  integrationId: string,
  reason: string,
  handle: ConnectionDb = db,
): Promise<boolean> {
  const bound = (
    await handle
      .select({ connectionId: integration.connectionId })
      .from(integration)
      .where(
        and(
          eq(integration.id, integrationId),
          isNotNull(integration.connectionId),
        ),
      )
  ).at(0)
  const connectionId = bound?.connectionId ?? null
  if (connectionId === null) return false
  return markConnectionRefused(connectionId, reason, handle)
}

/** One connection refused by its provider — a member's key a keyed run was refused on. */
export async function markConnectionRefused(
  connectionId: string,
  reason: string,
  handle: ConnectionDb = db,
): Promise<boolean> {
  const marked = await handle
    .update(accountConnection)
    .set({ status: 'error', errorReason: reason })
    .where(
      and(
        eq(accountConnection.id, connectionId),
        eq(accountConnection.status, 'active'),
      ),
    )
    .returning({ id: accountConnection.id })
  return marked.length > 0
}
