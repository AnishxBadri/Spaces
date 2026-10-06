import { Effect } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { challengeFor, newVerifier } from './pkce'
import { exchangeCode, grantedScopes, readAccount } from './exchange'
import { startFakeIdp } from './fake-idp'
import type { FakeIdp } from './fake-idp'

/** The code exchange and userinfo read against the fake IdP. */

const REDIRECT = 'http://localhost:3000/api/connections/google/callback'
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'

let idp: FakeIdp

beforeAll(async () => {
  idp = await startFakeIdp()
})

afterAll(async () => {
  await idp.close()
})

beforeEach(() => {
  idp.reset()
})

/** Runs `/authorize` and returns the code it issued. */
async function authorize(
  verifier: string,
  scope = `openid email ${DRIVE_FILE}`,
) {
  const url = new URL(idp.authUrl)
  url.searchParams.set('redirect_uri', REDIRECT)
  url.searchParams.set('scope', scope)
  url.searchParams.set('code_challenge', challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  const answer = await fetch(url, { redirect: 'manual' })
  return (
    new URL(answer.headers.get('location') ?? '').searchParams.get('code') ?? ''
  )
}

const exchange = (code: string, verifier: string) =>
  exchangeCode({
    tokenUrl: idp.tokenUrl,
    code,
    verifier,
    redirectUri: REDIRECT,
    clientId: 'client-id',
    clientSecret: 'client-secret',
  })

describe('the fake IdP token endpoint', () => {
  it('rejects an exchange that carries no code_verifier', async () => {
    const code = await authorize(newVerifier())
    const response = await fetch(idp.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('rejects a verifier that does not match the challenge', async () => {
    const code = await authorize(newVerifier())
    const error = await Effect.runPromise(
      Effect.flip(exchange(code, newVerifier())),
    )
    expect(error).toMatchObject({
      _tag: 'ExchangeFailed',
      step: 'token',
      status: 400,
    })
    expect(error.message).toContain('invalid_grant')
  })

  it('trades a code once, sending the verifier and the client', async () => {
    const verifier = newVerifier()
    const code = await authorize(verifier)
    const grant = await Effect.runPromise(exchange(code, verifier))
    expect(grant.bundle.accessToken).toBe(`fake-access-${code}`)
    expect(grant.bundle.refreshToken).toBe(`fake-refresh-${code}`)
    expect(grant.grantedWire).toEqual(['openid', 'email', DRIVE_FILE])
    expect(grant.expiresIn).toBe(3599)
    expect(grant.refreshTokenExpiresIn).toBeNull()

    const sent = idp.tokenRequests.at(-1)
    expect(sent?.get('code_verifier')).toBe(verifier)
    expect(sent?.get('client_id')).toBe('client-id')
    expect(sent?.get('client_secret')).toBe('client-secret')
    expect(sent?.get('redirect_uri')).toBe(REDIRECT)

    const again = await Effect.runPromise(Effect.flip(exchange(code, verifier)))
    expect(again.status).toBe(400)
  })

  it('grants fewer scopes than asked in partial-grant mode', async () => {
    idp.mode.withheldScopes = [DRIVE_FILE]
    const verifier = newVerifier()
    const grant = await Effect.runPromise(
      exchange(await authorize(verifier), verifier),
    )
    expect(grant.grantedWire).toEqual(['openid', 'email'])
  })
})

describe('readAccount', () => {
  it('reads Google as sub/email and Box as id/login', async () => {
    const verifier = newVerifier()
    const grant = await Effect.runPromise(
      exchange(await authorize(verifier), verifier),
    )
    const token = grant.bundle.accessToken
    await expect(
      Effect.runPromise(readAccount('google', idp.userinfoUrl, token)),
    ).resolves.toEqual({
      externalAccountId: idp.account.sub,
      externalEmail: idp.account.email,
    })
    await expect(
      Effect.runPromise(readAccount('box', idp.boxUserUrl, token)),
    ).resolves.toEqual({
      externalAccountId: idp.account.sub,
      externalEmail: idp.account.email,
    })
  })

  it('fails on a token the provider did not issue', async () => {
    const error = await Effect.runPromise(
      Effect.flip(readAccount('google', idp.userinfoUrl, 'forged')),
    )
    expect(error).toMatchObject({ step: 'userinfo', status: 401 })
  })
})

describe('grantedScopes', () => {
  it('maps wire strings back to registry values, Google long forms included', () => {
    expect(
      grantedScopes(
        'google',
        [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          DRIVE_FILE,
        ],
        ['openid', 'email', 'drive.file', 'drive.readonly'],
      ),
    ).toEqual(['openid', 'email', 'drive.file'])
  })

  it('drops a wire string the registry does not list', () => {
    expect(
      grantedScopes('google', ['https://www.googleapis.com/auth/drive'], []),
    ).toEqual([])
  })

  it('takes a response with no scope as the request granted whole', () => {
    expect(grantedScopes('box', null, ['root_readonly'])).toEqual([
      'root_readonly',
    ])
  })
})
