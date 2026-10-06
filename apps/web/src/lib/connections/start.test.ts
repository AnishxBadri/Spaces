import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { PROVIDERS } from '@spaces/core/providers/registry'
import { storeCredential } from '@spaces/core/writes/vault'
import { startFakeIdp } from '@spaces/core/writes/connections/fake-idp'
import type { FakeIdp } from '@spaces/core/writes/connections/fake-idp'
import {
  readVerifierCookie,
  verifierCookieName,
} from '@spaces/core/writes/connections/pkce'
import { verifyState } from '@spaces/core/writes/connections/state'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { connectStartProgram, handleConnectStart } from './start'
import type { ProviderTable } from './start'

/**
 * The start leg against the fake IdP: the route's handler is called with a
 * real Request, its 302 is followed to the IdP, and what the IdP recorded is
 * what is asserted. Only the session is stubbed; the vault and database are real.
 */

const session: { current: { id: string } | null } = { current: null }

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const CLIENT_ID = '48213-abc.apps.googleusercontent.com'
const CALLBACK = 'https://deals.fund.example/api/connections/google/callback'

let idp: FakeIdp
let providers: ProviderTable

beforeAll(async () => {
  idp = await startFakeIdp()
  providers = {
    ...PROVIDERS,
    google: { ...PROVIDERS.google, authUrl: idp.authUrl },
  }
})

afterAll(async () => {
  await idp.close()
})

beforeEach(() => {
  session.current = { id: FIXTURE_ACTOR.id }
  idp.authorizeRequests.length = 0
  vi.stubEnv('APP_URL', 'https://deals.fund.example/')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function configureGoogle() {
  await storeCredential({
    scope: 'workspace',
    provider: 'google',
    kind: 'oauth_client',
    secret: 'GOCSPX-the-real-client-secret-9f3c',
    meta: { clientId: CLIENT_ID },
    createdBy: FIXTURE_ACTOR.id,
  })
}

/** Isolation is per file: an earlier test's client is still there. */
async function deleteGoogleClient() {
  await db
    .delete(credential)
    .where(
      and(
        eq(credential.provider, 'google'),
        eq(credential.kind, 'oauth_client'),
      ),
    )
}

const start = (provider: string, query: string) =>
  handleConnectStart(
    new Request(
      `http://localhost:3000/api/connections/${provider}/start?${query}`,
    ),
    provider,
    providers,
  )

/** Follows the start leg's 302 to the IdP; returns what the IdP recorded and answered. */
async function throughIdp(response: Response) {
  expect(response.status).toBe(302)
  const location = response.headers.get('location') ?? ''
  expect(location.startsWith(`${idp.authUrl}?`)).toBe(true)
  const answer = await fetch(location, { redirect: 'manual' })
  const recorded = idp.authorizeRequests.at(-1)
  if (recorded === undefined) throw new Error('the IdP recorded nothing')
  return { recorded, answer }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

describe('the authorize request', () => {
  it('carries S256, the exact scopes, the redirect URI and a signed state', async () => {
    await configureGoogle()
    const response = await start('google', 'product=drive')
    const { recorded, answer } = await throughIdp(response)

    expect(recorded.get('client_id')).toBe(CLIENT_ID)
    expect(recorded.get('response_type')).toBe('code')
    expect(recorded.get('redirect_uri')).toBe(CALLBACK)
    expect(recorded.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive.file',
    )
    expect(recorded.get('code_challenge_method')).toBe('S256')
    expect(recorded.get('access_type')).toBe('offline')
    expect(recorded.get('prompt')).toBe('consent')

    const stateToken = recorded.get('state') ?? ''
    const state = await Effect.runPromise(
      verifyState(stateToken, { userId: FIXTURE_ACTOR.id }),
    )
    expect(state).toMatchObject({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'drive',
      scopes: ['openid', 'email', 'drive.file'],
      returnTo: '/settings/connections',
    })

    // The verifier the cookie carries is the one the challenge was made from.
    const setCookie = response.headers.get('set-cookie') ?? ''
    const verifier = readVerifierCookie(setCookie.split(';')[0], state.nonce)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(recorded.get('code_challenge')).toBe(sha256(verifier ?? ''))
    expect(setCookie).toBe(
      `${verifierCookieName(state.nonce)}=${verifier}; Path=/api/connections/google/callback; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    )
    expect(stateToken).not.toContain(verifier)

    // The IdP sends the browser back to the callback with a code and the state.
    expect(answer.status).toBe(302)
    const back = new URL(answer.headers.get('location') ?? '')
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
    expect(back.searchParams.get('code')).toBe(idp.issuedCodes.at(-1))
    expect(back.searchParams.get('state')).toBe(stateToken)
  })

  it('sends exactly the scopes asked for and the return path', async () => {
    await configureGoogle()
    const { recorded } = await throughIdp(
      await start(
        'google',
        'product=drive&scopes=drive.file,drive.readonly&return=%2Frecords%2Fabc%3Ftab%3Dfiles',
      ),
    )
    expect(recorded.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
    )
    const state = await Effect.runPromise(
      verifyState(recorded.get('state') ?? '', { userId: FIXTURE_ACTOR.id }),
    )
    expect(state.scopes).toEqual(['drive.file', 'drive.readonly'])
    expect(state.returnTo).toBe('/records/abc?tab=files')
  })

  it('gives each start a fresh verifier and nonce', async () => {
    await configureGoogle()
    const a = await start('google', 'product=drive')
    const b = await start('google', 'product=drive')
    expect(a.headers.get('set-cookie')).not.toBe(b.headers.get('set-cookie'))
  })

  it('drops Secure from the cookie when APP_URL is plain http', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3000')
    await configureGoogle()
    const response = await start('google', 'product=drive')
    expect(response.headers.get('set-cookie')).not.toContain('Secure')
    const { recorded } = await throughIdp(response)
    expect(recorded.get('redirect_uri')).toBe(
      'http://localhost:3000/api/connections/google/callback',
    )
  })
})

describe('refusals', () => {
  it('answers no session with a 401 and never reaches the IdP', async () => {
    await configureGoogle()
    session.current = null
    const response = await start('google', 'product=drive')
    expect(response.status).toBe(401)
    expect(idp.authorizeRequests).toHaveLength(0)
  })

  it('answers ProviderUnconfigured naming Settings → Connections, never a redirect', async () => {
    await configureGoogle()
    await deleteGoogleClient()
    const response = await start('google', 'product=drive')
    expect(response.status).toBe(409)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('Settings → Connections')
    expect(idp.authorizeRequests).toHaveLength(0)

    const error = await Effect.runPromise(
      Effect.flip(
        connectStartProgram({
          userId: FIXTURE_ACTOR.id,
          provider: 'google',
          params: new URLSearchParams('product=drive'),
          origin: 'https://deals.fund.example',
          secure: true,
          providers,
        }),
      ),
    )
    expect(error._tag).toBe('ProviderUnconfigured')
    expect(error.message).toBe(
      'Google has no OAuth client yet. An admin adds it in Settings → Connections.',
    )
  })

  it('treats a disabled client row as unconfigured', async () => {
    await configureGoogle()
    await db
      .update(credential)
      .set({ status: 'invalid' })
      .where(
        and(
          eq(credential.provider, 'google'),
          eq(credential.kind, 'oauth_client'),
        ),
      )
    expect((await start('google', 'product=drive')).status).toBe(409)
  })

  it('names an unknown provider, product or scope with a 400', async () => {
    await configureGoogle()
    const cases: Array<[string, string, string]> = [
      ['dropbox', 'product=files', 'Unknown provider: dropbox'],
      ['google', 'product=photos', 'Unknown Google product: photos'],
      ['google', '', 'Unknown Google product: (none)'],
      ['google', 'product=drive&scopes=drive', 'Unknown Google scope: drive'],
      [
        'google',
        'product=drive&scopes=drive.file,gmail.readonly',
        'Not a Google Drive scope: gmail.readonly',
      ],
      ['google', 'product=drive&scopes=', 'No scopes asked for'],
    ]
    for (const [provider, query, message] of cases) {
      const response = await start(provider, query)
      expect(response.status, query).toBe(400)
      expect(await response.text(), query).toContain(message)
    }
    expect(idp.authorizeRequests).toHaveLength(0)
  })

  it('refuses a return that leaves the site', async () => {
    await configureGoogle()
    for (const ret of [
      'https://evil.example/x',
      '//evil.example/x',
      '/\\evil.example',
      'settings',
    ]) {
      const response = await start(
        'google',
        `product=drive&return=${encodeURIComponent(ret)}`,
      )
      expect(response.status, ret).toBe(400)
    }
  })
})
