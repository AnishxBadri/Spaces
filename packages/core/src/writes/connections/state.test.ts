import { createHash, randomBytes } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  challengeFor,
  clearVerifierCookie,
  newVerifier,
  readVerifierCookie,
  verifierCookie,
} from './pkce'
import { STATE_TTL_MS, newNonce, signState, verifyState } from './state'
import type { ConnectState } from './state'

/** The verifier the callback consumes: one round trip and each refusal. */

const master = randomBytes(32)
const issuedAt = Date.UTC(2026, 9, 7, 12, 0, 0)

const state: ConnectState = {
  userId: 'user-anish',
  provider: 'google',
  product: 'drive',
  scopes: ['openid', 'email', 'drive.file'],
  returnTo: '/settings/connections',
  nonce: newNonce(),
  issuedAt,
}

/** `verified` or the refusal's reason. */
const reason = (token: string, expected: { userId: string; now?: number }) =>
  Effect.runSync(
    verifyState(token, expected, master).pipe(
      Effect.match({
        onSuccess: () => 'verified',
        onFailure: (e) => e.reason,
      }),
    ),
  )

describe('signState / verifyState', () => {
  it('round-trips the user, product, scopes and return path', () => {
    const token = signState(state, master)
    const back = Effect.runSync(
      verifyState(
        token,
        { userId: 'user-anish', now: issuedAt + 1000 },
        master,
      ),
    )
    expect(back).toEqual(state)
  })

  it('refuses a payload altered after signing as tampered', () => {
    const [, signature] = signState(state, master).split('.')
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        ...state,
        scopes: ['openid', 'email', 'drive.readonly'],
      }),
    ).toString('base64url')
    expect(
      reason(`${forged}.${signature}`, { userId: 'user-anish', now: issuedAt }),
    ).toBe('tampered')
  })

  it('refuses a state signed under another master key as tampered', () => {
    const token = signState(state, randomBytes(32))
    expect(reason(token, { userId: 'user-anish', now: issuedAt })).toBe(
      'tampered',
    )
  })

  it('refuses garbage as tampered', () => {
    for (const token of ['', 'abc', 'a.b.c', '.sig'])
      expect(reason(token, { userId: 'user-anish', now: issuedAt })).toBe(
        'tampered',
      )
  })

  it('refuses a state past its ten-minute life as expired', () => {
    const token = signState(state, master)
    expect(
      reason(token, { userId: 'user-anish', now: issuedAt + STATE_TTL_MS }),
    ).toBe('verified')
    expect(
      reason(token, { userId: 'user-anish', now: issuedAt + STATE_TTL_MS + 1 }),
    ).toBe('expired')
  })

  it('refuses a state issued to a different user', () => {
    const token = signState(state, master)
    expect(reason(token, { userId: 'user-priya', now: issuedAt + 1 })).toBe(
      'wrong-user',
    )
  })
})

describe('pkce', () => {
  it('derives the S256 challenge from a fresh 43-character verifier', () => {
    const verifier = newVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newVerifier()).not.toBe(verifier)
    expect(challengeFor(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
  })

  it('names the cookie by nonce, path-scoped, httpOnly, Lax, Secure on https', () => {
    const target = {
      nonce: 'n0nce',
      path: '/api/connections/google/callback',
      secure: true,
    }
    expect(verifierCookie({ ...target, verifier: 'v' })).toBe(
      'spaces_pkce_n0nce=v; Path=/api/connections/google/callback; Max-Age=600; HttpOnly; SameSite=Lax; Secure',
    )
    expect(clearVerifierCookie({ ...target, secure: false })).toBe(
      'spaces_pkce_n0nce=; Path=/api/connections/google/callback; Max-Age=0; HttpOnly; SameSite=Lax',
    )
  })

  it('reads back only the cookie its nonce names', () => {
    const header = 'a=1; spaces_pkce_other=x; spaces_pkce_n0nce=the-verifier'
    expect(readVerifierCookie(header, 'n0nce')).toBe('the-verifier')
    expect(readVerifierCookie(header, 'missing')).toBeNull()
    expect(readVerifierCookie(null, 'n0nce')).toBeNull()
  })
})
