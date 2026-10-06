import { describe, expect, it } from 'vitest'
import { connectionAad, decryptBundle, encryptBundle } from './bundle'
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
