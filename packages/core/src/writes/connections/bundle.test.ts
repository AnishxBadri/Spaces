import { describe, expect, it } from 'vitest'
import {
  connectionAad,
  decryptBundle,
  decryptConnectionBundle,
  encryptBundle,
} from './bundle'
import { encryptSecret } from '../vault/crypto'
import type { TokenBundle } from './bundle'

/** The token bundle under the vault's GCM, bound to its owner. */

const bundle: TokenBundle = {
  accessToken: 'ya29.a0-the-access-token',
  refreshToken: '1//0g-the-refresh-token',
  tokenType: 'Bearer',
}
const anish = { userId: 'user-anish', provider: 'google' }

describe('encryptBundle / decryptBundle', () => {
  it('round-trips for its owner and never stores plaintext', () => {
    const blob = encryptBundle(bundle, anish)
    expect(blob.toString('utf8')).not.toContain(bundle.accessToken)
    expect(blob.toString('utf8')).not.toContain('refresh')
    expect(decryptBundle(blob, anish)).toEqual(bundle)
  })

  it('binds the AAD to user and provider', () => {
    expect(connectionAad(anish)).toBe('connection:user-anish:google')
  })

  it("fails the GCM auth tag under another user's AAD", () => {
    const blob = encryptBundle(bundle, anish)
    const read = () =>
      decryptBundle(blob, { userId: 'user-other', provider: 'google' })
    expect(read).toThrow(/unable to authenticate data/)
    try {
      read()
    } catch (error) {
      expect(String(error)).not.toContain(bundle.accessToken)
    }
  })

  it('fails under the same user on another provider', () => {
    const blob = encryptBundle(bundle, anish)
    expect(() =>
      decryptBundle(blob, { userId: 'user-anish', provider: 'box' }),
    ).toThrow(/unable to authenticate data/)
  })

  it('keeps a missing refresh token as null', () => {
    const blob = encryptBundle({ ...bundle, refreshToken: null }, anish)
    expect(decryptBundle(blob, anish).refreshToken).toBeNull()
  })
})

describe('a pasted key (D78)', () => {
  const granola = { userId: 'user-anish', provider: 'granola' }

  it('round-trips as { type: api_key, key } under the connection AAD', () => {
    const blob = encryptBundle(
      { type: 'api_key', key: 'grn_live_123' },
      granola,
    )
    expect(blob.toString('utf8')).not.toContain('grn_live_123')
    expect(decryptConnectionBundle(blob, granola)).toEqual({
      type: 'api_key',
      key: 'grn_live_123',
    })
    expect(() =>
      decryptConnectionBundle(blob, { ...granola, userId: 'user-other' }),
    ).toThrow(/unable to authenticate data/)
  })

  it('is not an OAuth grant: decryptBundle refuses it', () => {
    const blob = encryptBundle(
      { type: 'api_key', key: 'grn_live_123' },
      granola,
    )
    expect(() => decryptBundle(blob, granola)).toThrow(/pasted key/)
  })

  it('reads a stored bundle with no type as an OAuth grant', () => {
    const legacy = encryptSecret(JSON.stringify(bundle), connectionAad(anish))
    expect(decryptConnectionBundle(legacy, anish)).toEqual({
      type: 'oauth',
      ...bundle,
    })
    expect(decryptBundle(legacy, anish)).toEqual(bundle)
  })
})
