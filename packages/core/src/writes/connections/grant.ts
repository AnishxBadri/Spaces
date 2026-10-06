import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { encryptBundle } from './bundle'
import type { TokenBundle } from './bundle'

/**
 * Writes the grant a finished dance returned: one `account_connection` row
 * per (user, provider, product, provider account), upserted.
 * - A repeat dance replaces the tokens, scopes and lapse times and makes
 *   the row `active` again; nothing else about it changes.
 * - `scopes` is what the provider granted, never what was asked for.
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
}

export const upsertConnection = Effect.fn('upsertConnection')(function* (
  grant: ConnectionGrant,
): Effect.fn.Return<{ id: string }, GrantWriteFailed> {
  const tokensEnc = encryptBundle(grant.bundle, {
    userId: grant.userId,
    provider: grant.provider,
  })
  const scopes = [...grant.scopes]
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .insert(accountConnection)
        .values({
          userId: grant.userId,
          provider: grant.provider,
          product: grant.product,
          externalEmail: grant.externalEmail,
          externalAccountId: grant.externalAccountId,
          tokensEnc,
          scopes,
          expiresAt: grant.expiresAt,
          refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [
            accountConnection.userId,
            accountConnection.provider,
            accountConnection.product,
            accountConnection.externalEmail,
          ],
          set: {
            tokensEnc,
            scopes,
            externalAccountId: grant.externalAccountId,
            expiresAt: grant.expiresAt,
            refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
            status: 'active',
            errorReason: null,
          },
        })
        .returning({ id: accountConnection.id }),
    catch: (cause) =>
      new GrantWriteFailed({ message: 'Could not save the connection', cause }),
  })
  const row = rows.at(0)
  if (row === undefined)
    return yield* new GrantWriteFailed({
      message: 'Could not save the connection',
      cause: null,
    })
  return row
})
