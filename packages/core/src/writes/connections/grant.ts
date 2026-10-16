import { Effect, Schema } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import { decryptBundle, encryptBundle } from './bundle'
import type { TokenBundle } from './bundle'
import { unionScopes } from './scopes'

/**
 * Writes the grant a finished dance returned: one `account_connection` row
 * per (user, provider, product, provider account), upserted.
 * - `scopes` is what the provider granted, never what was asked for. A
 *   repeat dance adds the new grant to the stored set: scopes only grow.
 * - The new token bundle replaces the stored one; a response with no
 *   `refresh_token` keeps the stored refresh token.
 * - A `revoked` row's grant is gone at the provider: nothing carries over.
 * - The lapse times and account id are the new grant's, and the row is
 *   `active` again.
 * - With `plugin`, the product's installed plugin row is bound to the
 *   connection in the same transaction — only when it is bound to none, so
 *   one member's dance never takes another's mailbox.
 */

export class GrantWriteFailed extends Schema.TaggedError<GrantWriteFailed>()(
  'GrantWriteFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type ConnectionGrant = {
  readonly userId: string
  readonly provider: string
  readonly product: string
  readonly externalEmail: string
  readonly externalAccountId: string
  /** Registry `value`s. */
  readonly scopes: ReadonlyArray<string>
  readonly bundle: TokenBundle
  readonly expiresAt: Date | null
  readonly refreshTokenExpiresAt: Date | null
  /** The product's plugin id (`gmail`), whose integration row is bound. */
  readonly plugin?: string
}

type GrantTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type Stored = {
  readonly scopes: ReadonlyArray<string>
  readonly tokensEnc: Buffer
  readonly status: 'active' | 'error' | 'revoked'
}

/** The grant as it lands on a row holding `stored`; throws when that bundle will not decrypt. */
function onto(
  stored: Stored,
  grant: ConnectionGrant,
): { scopes: Array<string>; bundle: TokenBundle } {
  if (stored.status === 'revoked')
    return { scopes: [...grant.scopes], bundle: grant.bundle }
  const owner = { userId: grant.userId, provider: grant.provider }
  const refreshToken =
    grant.bundle.refreshToken ??
    decryptBundle(stored.tokensEnc, owner).refreshToken
  return {
    scopes: unionScopes(grant.provider, stored.scopes, grant.scopes),
    bundle: { ...grant.bundle, refreshToken },
  }
}

export const upsertConnection = Effect.fn('upsertConnection')(function* (
  grant: ConnectionGrant,
): Effect.fn.Return<{ id: string }, GrantWriteFailed> {
  /** The plugin's live, unbound row takes the connection; answers the row. */
  const bind = async (tx: GrantTx, row: { id: string }) => {
    if (grant.plugin !== undefined)
      await tx
        .update(integration)
        .set({ connectionId: row.id })
        .where(
          and(
            eq(integration.capabilityId, grant.plugin),
            isNull(integration.removedAt),
            isNull(integration.connectionId),
          ),
        )
    return row
  }
  const owner = { userId: grant.userId, provider: grant.provider }
  const renewed: {
    externalAccountId: string
    expiresAt: Date | null
    refreshTokenExpiresAt: Date | null
    status: 'active'
  } = {
    externalAccountId: grant.externalAccountId,
    expiresAt: grant.expiresAt,
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    status: 'active',
  }
  const row = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        // Insert first: a concurrent first dance waits on the conflict
        // instead of both reading "no row" and the later one overwriting.
        const inserted = await tx
          .insert(accountConnection)
          .values({
            userId: grant.userId,
            provider: grant.provider,
            product: grant.product,
            externalEmail: grant.externalEmail,
            tokensEnc: encryptBundle(grant.bundle, owner),
            scopes: [...grant.scopes],
            ...renewed,
          })
          .onConflictDoNothing({
            target: [
              accountConnection.userId,
              accountConnection.provider,
              accountConnection.product,
              accountConnection.externalEmail,
            ],
          })
          .returning({ id: accountConnection.id })
        const fresh = inserted.at(0)
        if (fresh !== undefined) return bind(tx, fresh)

        const stored = (
          await tx
            .select({
              id: accountConnection.id,
              scopes: accountConnection.scopes,
              tokensEnc: accountConnection.tokensEnc,
              status: accountConnection.status,
            })
            .from(accountConnection)
            .where(
              and(
                eq(accountConnection.userId, grant.userId),
                eq(accountConnection.provider, grant.provider),
                eq(accountConnection.product, grant.product),
                eq(accountConnection.externalEmail, grant.externalEmail),
              ),
            )
            .for('update')
        ).at(0)
        if (stored === undefined) return undefined
        const next = onto(stored, grant)
        const updated = await tx
          .update(accountConnection)
          .set({
            tokensEnc: encryptBundle(next.bundle, owner),
            scopes: next.scopes,
            ...renewed,
            errorReason: null,
          })
          .where(eq(accountConnection.id, stored.id))
          .returning({ id: accountConnection.id })
        const kept = updated.at(0)
        return kept === undefined ? undefined : bind(tx, kept)
      }),
    catch: (cause) =>
      new GrantWriteFailed({ message: 'Could not save the connection', cause }),
  })
  if (row === undefined)
    return yield* new GrantWriteFailed({
      message: 'Could not save the connection',
      cause: null,
    })
  return row
})
