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
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, user } from '@spaces/db/schema'
import { PROVIDERS } from '@spaces/core/providers/registry'
import { storeCredential } from '@spaces/core/writes/vault'
import { startFakeIdp } from '@spaces/core/writes/connections/fake-idp'
import type { FakeIdp } from '@spaces/core/writes/connections/fake-idp'
import { decryptBundle } from '@spaces/core/writes/connections/bundle'
import { hasScopes } from '@spaces/core/writes/connections/scopes'
import {
  newVerifier,
  verifierCookie,
  verifierCookieName,
} from '@spaces/core/writes/connections/pkce'
import {
  STATE_TTL_MS,
  newNonce,
  signState,
} from '@spaces/core/writes/connections/state'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { connectCallbackProgram, handleConnectCallback } from './callback'
import { connectHref } from './products'
import { handleConnectStart } from './start'
import type { ProviderTable } from './start'

/**
 * The whole dance against the fake IdP: start → the IdP's authorize → the
 * callback, each a real Request, the verifier cookie carried by hand the
 * way a browser would. Only the session is stubbed; the vault, the state
 * key and the database are real.
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

const APP = 'https://deals.fund.example'
const CALLBACK_PATH = '/api/connections/google/callback'
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
const TEAMMATE = {
  id: 'spa225-teammate',
  name: 'Teammate',
  email: 'spa225-teammate@spaces.test',
}

let idp: FakeIdp
let providers: ProviderTable

beforeAll(async () => {
  idp = await startFakeIdp()
  providers = {
    google: {
      ...PROVIDERS.google,
      authUrl: idp.authUrl,
      tokenUrl: idp.tokenUrl,
      userinfoUrl: idp.userinfoUrl,
    },
    box: {
      ...PROVIDERS.box,
      authUrl: idp.authUrl,
      tokenUrl: idp.tokenUrl,
      userinfoUrl: idp.boxUserUrl,
    },
  }
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
  for (const provider of ['google', 'box'])
    await storeCredential({
      scope: 'workspace',
      provider,
      kind: 'oauth_client',
      secret: `${provider}-client-secret-9f3c`,
      meta: { clientId: `${provider}-client-id` },
      createdBy: FIXTURE_ACTOR.id,
    })
})

afterAll(async () => {
  await idp.close()
})

beforeEach(async () => {
  session.current = { id: FIXTURE_ACTOR.id }
  idp.reset()
  vi.stubEnv('APP_URL', `${APP}/`)
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const rows = () => db.select().from(accountConnection)

/** `name=value` of a `Set-Cookie`, as the browser sends it back. */
const cookiePair = (setCookie: string | null) => (setCookie ?? '').split(';')[0]

/**
 * Start as the session user, follow the IdP's authorize, and return the
 * callback Request the browser would make with its verifier cookie.
 */
async function toCallback(provider: string, query: string) {
  const started = await handleConnectStart(
    new Request(`${APP}/api/connections/${provider}/start?${query}`),
    provider,
    providers,
  )
  expect(started.status).toBe(302)
  const cookie = cookiePair(started.headers.get('set-cookie'))
  const answer = await fetch(started.headers.get('location') ?? '', {
    redirect: 'manual',
  })
  const back = answer.headers.get('location') ?? ''
  return { back, cookie }
}

const callback = (provider: string, url: string, cookie: string | null) =>
  handleConnectCallback(
    new Request(url, cookie === null ? {} : { headers: { cookie } }),
    provider,
    providers,
  )

async function dance(provider: string, query: string) {
  const { back, cookie } = await toCallback(provider, query)
  return { response: await callback(provider, back, cookie), cookie }
}

const nonceOf = (cookie: string) =>
  cookie.slice('spaces_pkce_'.length, cookie.indexOf('='))

describe('a successful callback', () => {
  it('upserts one encrypted row and redirects to the return path', async () => {
    const before = Date.now()
    const { response, cookie } = await dance(
      'google',
      'product=drive&return=%2Frecords%2Fabc%3Ftab%3Dfiles',
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/records/abc?tab=files')

    // The verifier went to the token endpoint, and the cookie is cleared.
    const sent = idp.tokenRequests.at(-1)
    expect(sent?.get('code_verifier')).toBe(cookie.split('=')[1])
    expect(sent?.get('client_id')).toBe('google-client-id')
    expect(sent?.get('client_secret')).toBe('google-client-secret-9f3c')
    expect(sent?.get('redirect_uri')).toBe(`${APP}${CALLBACK_PATH}`)
    expect(response.headers.get('set-cookie')).toBe(
      `${verifierCookieName(nonceOf(cookie))}=; Path=${CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    )

    const all = await rows()
    expect(all).toHaveLength(1)
    const row = all[0]
    expect(row).toMatchObject({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'drive',
      externalEmail: idp.account.email,
      externalAccountId: idp.account.sub,
      scopes: ['openid', 'email', 'drive.file'],
      refreshTokenExpiresAt: null,
      status: 'active',
      errorReason: null,
    })
    const expiresAt = row.expiresAt?.getTime() ?? 0
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3599_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3599_000)

    const owner = { userId: FIXTURE_ACTOR.id, provider: 'google' }
    const bundle = decryptBundle(row.tokensEnc, owner)
    expect(bundle.accessToken).toMatch(/^fake-access-/)
    expect(bundle.refreshToken).toMatch(/^fake-refresh-/)
    expect(row.tokensEnc.toString('utf8')).not.toContain(bundle.accessToken)
    expect(() =>
      decryptBundle(row.tokensEnc, { userId: TEAMMATE.id, provider: 'google' }),
    ).toThrow(/unable to authenticate data/)
  })

  it('replaces the grant on a repeat dance and makes the row active again', async () => {
    await dance('google', 'product=drive')
    await db
      .update(accountConnection)
      .set({ status: 'error', errorReason: 'invalid_grant' })
      .where(eq(accountConnection.product, 'drive'))
    const first = (await rows())[0]

    const { response } = await dance('google', 'product=drive')
    expect(response.status).toBe(302)
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(first.id)
    expect(all[0]).toMatchObject({ status: 'active', errorReason: null })
    const owner = { userId: FIXTURE_ACTOR.id, provider: 'google' }
    expect(decryptBundle(all[0].tokensEnc, owner).accessToken).not.toBe(
      decryptBundle(first.tokensEnc, owner).accessToken,
    )
  })

  it('keeps one row per product', async () => {
    await dance('google', 'product=drive')
    await dance('google', 'product=calendar')
    const products = (await rows()).map((r) => r.product).sort()
    expect(products).toEqual(['calendar', 'drive'])
  })

  it('stores the scopes granted, not the ones asked for', async () => {
    idp.mode.withheldScopes = [DRIVE_FILE]
    await dance('google', 'product=drive')
    expect((await rows())[0].scopes).toEqual(['openid', 'email'])
  })

  it("reads Box's account and its refresh-token lapse", async () => {
    idp.mode.omitScope = true
    idp.mode.refreshTokenExpiresIn = 60 * 24 * 3600
    idp.account = { sub: '11446498', email: 'partner@fund.example' }
    const before = Date.now()
    const { response } = await dance('box', 'product=box')
    expect(response.status).toBe(302)
    const row = (await rows())[0]
    expect(row).toMatchObject({
      provider: 'box',
      product: 'box',
      externalAccountId: '11446498',
      externalEmail: 'partner@fund.example',
      scopes: ['root_readonly'],
    })
    const lapse = row.refreshTokenExpiresAt?.getTime() ?? 0
    expect(lapse).toBeGreaterThanOrEqual(before + 60 * 24 * 3600 * 1000)
  })
})

describe('refusals write no row', () => {
  it('answers a tampered state with a 400', async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    const url = new URL(back)
    const [payload, signature] = (url.searchParams.get('state') ?? '').split(
      '.',
    )
    const forged = Buffer.from(payload, 'base64url')
      .toString('utf8')
      .replace('/settings/files', '/somewhere-else')
    url.searchParams.set(
      'state',
      `${Buffer.from(forged).toString('base64url')}.${signature}`,
    )
    const response = await callback('google', url.toString(), cookie)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('The connect state was altered')
    expect(idp.tokenRequests).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('answers a state older than ten minutes with a 400', async () => {
    const nonce = newNonce()
    const state = signState({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'drive',
      scopes: ['openid', 'email', 'drive.file'],
      returnTo: '/settings/connections',
      nonce,
      issuedAt: Date.now() - STATE_TTL_MS - 1000,
    })
    const cookie = cookiePair(
      verifierCookie({
        nonce,
        verifier: newVerifier(),
        path: CALLBACK_PATH,
        secure: true,
      }),
    )
    const response = await callback(
      'google',
      `${APP}${CALLBACK_PATH}?code=fake-code-1&state=${state}`,
      cookie,
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('expired')
    // Genuinely signed, so its cookie is cleared even on refusal.
    expect(response.headers.get('set-cookie')).toContain(
      `${verifierCookieName(nonce)}=; Path=${CALLBACK_PATH}; Max-Age=0`,
    )
    expect(idp.tokenRequests).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('answers a state issued to another session user with a 400 wrong-user', async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    session.current = { id: TEAMMATE.id }
    const response = await callback('google', back, cookie)
    expect(response.status).toBe(400)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')

    const error = await Effect.runPromise(
      Effect.flip(
        connectCallbackProgram({
          userId: TEAMMATE.id,
          provider: 'google',
          params: new URL(back).searchParams,
          cookieHeader: cookie,
          origin: APP,
          providers,
        }),
      ),
    )
    expect(error).toMatchObject({ _tag: 'StateInvalid', reason: 'wrong-user' })
    expect(idp.tokenRequests).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('refuses a callback whose verifier cookie is gone, like an expired state', async () => {
    const { back } = await toCallback('google', 'product=drive')
    const response = await callback('google', back, null)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('expired')
    expect(idp.tokenRequests).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('answers an exchange the IdP rejects with a 502', async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    const [name] = cookie.split('=')
    const response = await callback('google', back, `${name}=${newVerifier()}`)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('invalid_grant')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await rows()).toHaveLength(0)
  })

  it("answers the provider's error= with a 400", async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    const url = new URL(back)
    url.searchParams.delete('code')
    url.searchParams.set('error', 'access_denied')
    const response = await callback('google', url.toString(), cookie)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('access_denied')
    expect(idp.tokenRequests).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('answers no session with a 401', async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    session.current = null
    expect((await callback('google', back, cookie)).status).toBe(401)
    expect(await rows()).toHaveLength(0)
  })

  it('refuses a state carried to another provider', async () => {
    const { back, cookie } = await toCallback('google', 'product=drive')
    const url = new URL(back)
    url.pathname = '/api/connections/box/callback'
    const response = await callback('box', url.toString(), cookie)
    expect(response.status).toBe(400)
    expect(await rows()).toHaveLength(0)
  })
})

/**
 * Scope growth stays within a product (D66), so the added scope is Drive's
 * own `drive.readonly` on top of `drive.file`, not Calendar's.
 */
describe('scope growth on a held connection', () => {
  const owner = { userId: FIXTURE_ACTOR.id, provider: 'google' }
  const lastAuthorize = () => idp.authorizeRequests.at(-1)

  it('unions the added scope onto the one row with a fresh refresh token', async () => {
    await dance('google', 'product=drive')
    expect(lastAuthorize()?.get('include_granted_scopes')).toBeNull()
    const first = (await rows())[0]

    const { response } = await dance(
      'google',
      'product=drive&scopes=drive.readonly',
    )
    expect(response.status).toBe(302)
    expect(lastAuthorize()?.get('include_granted_scopes')).toBe('true')
    expect(lastAuthorize()?.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.readonly',
    )

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(first.id)
    expect(all[0].scopes).toEqual([
      'openid',
      'email',
      'drive.file',
      'drive.readonly',
    ])
    const before = decryptBundle(first.tokensEnc, owner)
    const after = decryptBundle(all[0].tokensEnc, owner)
    expect(after.refreshToken).toMatch(/^fake-refresh-/)
    expect(after.refreshToken).not.toBe(before.refreshToken)
  })

  it('answers hasScopes missing, then grows through connectHref back to the return path', async () => {
    await dance('google', 'product=drive')
    const { id } = (await rows())[0]
    const wanted = ['drive.file', 'drive.readonly']
    const check = await Effect.runPromise(hasScopes(id, wanted))
    expect(check).toEqual({ _tag: 'missing', scopes: ['drive.readonly'] })
    if (check._tag !== 'missing') throw new Error('expected missing')

    const href = connectHref(
      'google',
      'drive',
      check.scopes,
      '/records/abc?tab=files',
    )
    const { response } = await dance(
      'google',
      new URL(href, APP).search.slice(1),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/records/abc?tab=files')
    expect(await Effect.runPromise(hasScopes(id, wanted))).toEqual({
      _tag: 'granted',
    })
  })

  it('stores what was granted when the user unticks the added scope', async () => {
    await dance('google', 'product=drive')
    idp.mode.withheldScopes = ['https://www.googleapis.com/auth/drive.readonly']
    await dance('google', 'product=drive&scopes=drive.readonly')
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].scopes).toEqual(['openid', 'email', 'drive.file'])
  })

  it('never makes a second row for the same account on re-consent', async () => {
    await dance('google', 'product=drive')
    await db
      .update(accountConnection)
      .set({ status: 'revoked' })
      .where(eq(accountConnection.product, 'drive'))
    await dance('google', 'product=drive')
    // A held row asks for the earlier grant whatever its status.
    expect(lastAuthorize()?.get('include_granted_scopes')).toBe('true')
    await dance('google', 'product=drive&scopes=drive.file,drive.readonly')
    await dance('google', 'product=drive')
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      status: 'active',
      scopes: ['openid', 'email', 'drive.file', 'drive.readonly'],
    })
  })
})

/**
 * Ticking a product on an account page: that product's own consent, for the
 * same address, while another product's row stands untouched. (D66, D81)
 */
describe('a product added from the account page', () => {
  const lastAuthorize = () => idp.authorizeRequests.at(-1)

  it('asks only for Calendar, preselects the account and leaves the Drive row alone', async () => {
    await dance('google', 'product=drive')
    const drive = (await rows())[0]
    const page = `/settings/files/${drive.id}`

    const href = connectHref(
      'google',
      'calendar',
      [],
      page,
      drive.externalEmail,
    )
    const { response } = await dance(
      'google',
      new URL(href, APP).search.slice(1),
    )

    expect(lastAuthorize()?.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.events.readonly',
    )
    expect(lastAuthorize()?.get('include_granted_scopes')).toBeNull()
    expect(lastAuthorize()?.get('login_hint')).toBe(drive.externalEmail)
    expect(response.headers.get('location')).toBe(page)

    const all = await rows()
    expect(all.map((r) => r.product).sort()).toEqual(['calendar', 'drive'])
    const calendar = all.find((r) => r.product === 'calendar')
    expect(calendar).toMatchObject({
      externalEmail: drive.externalEmail,
      scopes: ['openid', 'email', 'calendar.events.readonly'],
    })
    const after = all.find((r) => r.product === 'drive')
    expect(after?.scopes).toEqual(drive.scopes)
    expect(after?.tokensEnc.equals(drive.tokensEnc)).toBe(true)
  })

  it('refuses an account hint that is not an address', async () => {
    const started = await handleConnectStart(
      new Request(
        `${APP}/api/connections/google/start?product=calendar&account=not-an-address`,
      ),
      'google',
      providers,
    )
    expect(started.status).toBe(400)
    expect(await started.text()).toBe('account must be an email address')
  })
})
