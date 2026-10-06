import { and, eq, ne } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { credential, integration } from '@spaces/db/schema'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Deletes the vault row an integration held, unless another integration
 * still holds it. The caller has already unbound it from `integrationId` in
 * the same transaction. Removing a key and uninstalling both end here.
 */
export const releaseCredential = async (
  tx: Tx,
  integrationId: string,
  credentialId: string,
): Promise<void> => {
  const holders = await tx
    .select({ id: integration.id })
    .from(integration)
    .where(
      and(
        eq(integration.credentialId, credentialId),
        ne(integration.id, integrationId),
      ),
    )
  if (holders.length === 0)
    await tx.delete(credential).where(eq(credential.id, credentialId))
}
