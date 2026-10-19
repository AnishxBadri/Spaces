import { Schema } from 'effect'
import { decryptSecret, encryptSecret } from '../vault/crypto'

/**
 * A connection's secret as one encrypted JSON bundle in
 * `account_connection.tokens_enc`, through the vault's AES-256-GCM.
 * - AAD `connection:<userId>:<provider>`: a bundle copied onto another
 *   user's row fails the GCM tag instead of decrypting.
 * - Never the credential AAD (`scope:provider`), never a second crypto.
 * - Two shapes, told apart by `type`: an OAuth grant, or a key a member
 *   pasted (`api_key`, D78) that never expires and never refreshes. A stored
 *   bundle with no `type` is an OAuth grant.
 */

/** An OAuth grant's tokens. */
export type TokenBundle = {
  readonly accessToken: string
  /** Null when the provider sent none. */
  readonly refreshToken: string | null
  readonly tokenType: string
}

/** A key a member pasted for their own account (D78). */
export type KeyBundle = { readonly type: 'api_key'; readonly key: string }

/** What a row's `tokens_enc` holds, decrypted. */
export type ConnectionBundle =
  ({ readonly type: 'oauth' } & TokenBundle) | KeyBundle

export type BundleOwner = {
  readonly userId: string
  readonly provider: string
}

const Stored = Schema.Union([
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal('oauth')),
    accessToken: Schema.String,
    refreshToken: Schema.NullOr(Schema.String),
    tokenType: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal('api_key'), key: Schema.String }),
])

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Stored))

export function connectionAad(owner: BundleOwner): string {
  return `connection:${owner.userId}:${owner.provider}`
}

export function encryptBundle(
  bundle: TokenBundle | KeyBundle,
  owner: BundleOwner,
): Buffer {
  const stored =
    'key' in bundle
      ? { type: 'api_key', key: bundle.key }
      : {
          type: 'oauth',
          accessToken: bundle.accessToken,
          refreshToken: bundle.refreshToken,
          tokenType: bundle.tokenType,
        }
  return encryptSecret(JSON.stringify(stored), connectionAad(owner))
}

/** Either shape. Throws when the AAD is not the row's owner: the GCM tag fails first. */
export function decryptConnectionBundle(
  blob: Buffer,
  owner: BundleOwner,
): ConnectionBundle {
  const stored = decodeStored(decryptSecret(blob, connectionAad(owner)))
  if (stored.type === 'api_key') return stored
  return {
    type: 'oauth',
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    tokenType: stored.tokenType,
  }
}

/** An OAuth grant's tokens; throws on a pasted key, which has none to refresh or revoke. */
export function decryptBundle(blob: Buffer, owner: BundleOwner): TokenBundle {
  const bundle = decryptConnectionBundle(blob, owner)
  if (bundle.type === 'api_key')
    throw new Error('the connection holds a pasted key, not an OAuth grant')
  return {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    tokenType: bundle.tokenType,
  }
}
