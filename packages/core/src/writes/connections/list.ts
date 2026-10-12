import { and, asc, countDistinct, eq, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, document, integration } from '@spaces/db/schema'
import type { ConnectionDb } from './token'

/**
 * A user's own connections: the rows Settings → Connections lists, and the
 * local half of Disconnect.
 * - Never selects `tokens_enc`.
 * - Every read and delete is keyed by the user as well as the id, so
 *   another member's row never comes back and never goes.
 */

export type ConnectionListing = {
  readonly id: string
  readonly provider: string
  readonly product: string
  readonly externalEmail: string
  readonly scopes: ReadonlyArray<string>
  readonly status: 'active' | 'error' | 'revoked'
  readonly errorReason: string | null
  readonly lastSyncAt: Date | null
  readonly refreshTokenExpiresAt: Date | null
  readonly createdAt: Date
}

export async function listConnectionsFor(
  userId: string,
  handle: ConnectionDb = db,
): Promise<ConnectionListing[]> {
  return handle
    .select({
      id: accountConnection.id,
      provider: accountConnection.provider,
      product: accountConnection.product,
      externalEmail: accountConnection.externalEmail,
      scopes: accountConnection.scopes,
      status: accountConnection.status,
      errorReason: accountConnection.errorReason,
      lastSyncAt: accountConnection.lastSyncAt,
      refreshTokenExpiresAt: accountConnection.refreshTokenExpiresAt,
      createdAt: accountConnection.createdAt,
    })
    .from(accountConnection)
    .where(eq(accountConnection.userId, userId))
    .orderBy(
      asc(accountConnection.provider),
      asc(accountConnection.product),
      asc(accountConnection.externalEmail),
    )
}

/**
 * How many members hold a connection under a provider, any product; a
 * revoked grant does not count. Connection apps prints it on the client.
 */
export async function countMembersConnected(
  provider: string,
  handle: ConnectionDb = db,
): Promise<number> {
  const row = (
    await handle
      .select({ value: countDistinct(accountConnection.userId) })
      .from(accountConnection)
      .where(
        and(
          eq(accountConnection.provider, provider),
          ne(accountConnection.status, 'revoked'),
        ),
      )
  ).at(0)
  return row?.value ?? 0
}

/**
 * Deletes one of the user's connections and lets go of what pointed at it,
 * in one transaction. False when the user holds no such row.
 * - Documents that came through it keep their file; `connection_id` goes
 *   null, so they read as copies with no live source.
 * - An integration bound to it loses its grant (`connection_id` null) and
 *   answers NotConnected until it is bound again.
 */
export async function forgetConnection(
  userId: string,
  connectionId: string,
  handle: ConnectionDb = db,
): Promise<boolean> {
  return handle.transaction(async (tx) => {
    const owned = (
      await tx
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.id, connectionId),
            eq(accountConnection.userId, userId),
          ),
        )
        .for('update')
    ).at(0)
    if (owned === undefined) return false
    await tx
      .update(document)
      .set({ connectionId: null })
      .where(eq(document.connectionId, connectionId))
    await tx
      .update(integration)
      .set({ connectionId: null })
      .where(eq(integration.connectionId, connectionId))
    await tx
      .delete(accountConnection)
      .where(eq(accountConnection.id, connectionId))
    return true
  })
}
