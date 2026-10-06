import { Schema } from 'effect'
import { decryptSecret, encryptSecret } from '../vault/crypto'

/**
 * A connection's tokens as one encrypted JSON bundle in
 * `account_connection.tokens_enc`, through the vault's AES-256-GCM.
 * - AAD `connection:<userId>:<provider>`: a bundle copied onto another
 *   user's row fails the GCM tag instead of decrypting.
 * - Never the credential AAD (`scope:provider`), never a second crypto.
 */

export type TokenBundle = {
  readonly accessToken: string
  /** Null when the provider sent none. */
  readonly refreshToken: string | null
  readonly tokenType: string
}

export type BundleOwner = {
  readonly userId: string
  readonly provider: string
}

const Bundle = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
})

const decodeBundle = Schema.decodeUnknownSync(Schema.fromJsonString(Bundle))

export function connectionAad(owner: BundleOwner): string {
  return `connection:${owner.userId}:${owner.provider}`
}

export function encryptBundle(bundle: TokenBundle, owner: BundleOwner): Buffer {
  return encryptSecret(
    JSON.stringify({
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      tokenType: bundle.tokenType,
    }),
    connectionAad(owner),
  )
}

/** Throws when the AAD is not the row's owner: the GCM tag fails first. */
export function decryptBundle(blob: Buffer, owner: BundleOwner): TokenBundle {
  return decodeBundle(decryptSecret(blob, connectionAad(owner)))
}
