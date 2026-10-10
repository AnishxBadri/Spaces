import { and, count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, credential } from '@spaces/db/schema'
import {
  redact,
  resolveSecret,
  storeCredential,
} from '@spaces/core/writes/vault'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  getConfiguredProvidersHandler,
  getProviderAppsHandler,
  setProviderAppHandler,
} from './provider-apps'

/**
 * Settings → Connections, the OAuth-client block, driven through the
 * handlers the two server fns delegate to. Only the request is stubbed:
 * `requireAdmin`, the vault and the database are real.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/settings/connections'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const asMember = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
}
const asAdmin = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'admin' }
}

const CLIENT_ID = '48213-abc.apps.googleusercontent.com'
const SECRET = 'GOCSPX-the-real-client-secret-9f3c'

/** Isolation is per file, so a count names its provider. */
async function clientRows(provider: string) {
  const [{ value }] = await db
    .select({ value: count() })
    .from(credential)
    .where(
      and(
        eq(credential.kind, 'oauth_client'),
        eq(credential.provider, provider),
      ),
    )
  return value
}

beforeEach(() => {
  session.current = null
  vi.stubEnv('APP_URL', 'https://deals.fund.example/')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a member reads the clients redacted, and the write refuses them', () => {
  it("answers a member's save 'Admins only' before writing", async () => {
    asMember()
    await expect(
      setProviderAppHandler({
        provider: 'google',
        clientId: CLIENT_ID,
        clientSecret: SECRET,
      }),
    ).rejects.toThrow('Admins only')
    expect(await clientRows('google')).toBe(0)
  })

  it("reads a member the client with the secret's display redacted", async () => {
    asAdmin()
    await setProviderAppHandler({
      provider: 'google',
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    })
    asMember()
    const apps = await getProviderAppsHandler()
    const google = apps.find((a) => a.provider === 'google')
    expect(google?.configured).toBe(true)
    expect(google?.clientId).toBe(CLIENT_ID)
    expect(google?.secretDisplay).toBe('set')
    expect(JSON.stringify(apps)).not.toContain('9f3c')
    expect(apps.find((a) => a.provider === 'box')?.secretDisplay).toBeNull()
    // The admin's tests below start from no client.
    await db.delete(credential).where(eq(credential.kind, 'oauth_client'))
  })

  it('refuses a request with no session', async () => {
    await expect(getProviderAppsHandler()).rejects.toThrow('Unauthorized')
  })
})

describe('an admin registering the Google OAuth app', () => {
  it('reads not configured, then configured with only the redacted secret', async () => {
    asAdmin()
    const before = await getProviderAppsHandler()
    expect(before).toEqual([
      {
        provider: 'google',
        label: 'Google',
        configured: false,
        clientId: null,
        secretDisplay: null,
        secretSetAt: null,
        redirectUri:
          'https://deals.fund.example/api/connections/google/callback',
        membersConnected: 0,
      },
      {
        provider: 'box',
        label: 'Box',
        configured: false,
        clientId: null,
        secretDisplay: null,
        secretSetAt: null,
        redirectUri: 'https://deals.fund.example/api/connections/box/callback',
        membersConnected: 0,
      },
    ])

    const saved = await setProviderAppHandler({
      provider: 'google',
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    })
    expect(saved).toMatchObject({
      provider: 'google',
      configured: true,
      clientId: CLIENT_ID,
      secretDisplay: redact(SECRET),
    })
    const after = await getProviderAppsHandler()
    expect(after.find((r) => r.provider === 'google')).toEqual(saved)

    // The plaintext secret is in no response the section is ever handed.
    for (const response of [before, saved, after])
      expect(JSON.stringify(response)).not.toContain(SECRET)
    await expect(resolveSecret('google', 'oauth_client')).resolves.toBe(SECRET)
  })

  it('leaves a Gemini key on provider google readable', async () => {
    await storeCredential({
      scope: 'workspace',
      provider: 'google',
      kind: 'llm',
      secret: 'AIzaSyD-gemini-key-7a1b',
      createdBy: FIXTURE_ACTOR.id,
    })
    asAdmin()
    await setProviderAppHandler({
      provider: 'google',
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    })
    await expect(resolveSecret('google', 'llm')).resolves.toBe(
      'AIzaSyD-gemini-key-7a1b',
    )
    await expect(resolveSecret('google', 'oauth_client')).resolves.toBe(SECRET)
  })

  it('changes the client id alone and keeps the secret; a first save needs one', async () => {
    asAdmin()
    await expect(
      setProviderAppHandler({
        provider: 'box',
        clientId: 'box-client',
        clientSecret: '',
      }),
    ).rejects.toThrow('Paste the Box client secret')
    expect(await clientRows('box')).toBe(0)

    await setProviderAppHandler({
      provider: 'box',
      clientId: 'box-client',
      clientSecret: 'box-secret-0001',
    })
    const renamed = await setProviderAppHandler({
      provider: 'box',
      clientId: 'box-client-2',
      clientSecret: '',
    })
    expect(renamed).toMatchObject({
      configured: true,
      clientId: 'box-client-2',
      secretDisplay: redact('box-secret-0001'),
    })
    await expect(resolveSecret('box', 'oauth_client')).resolves.toBe(
      'box-secret-0001',
    )
  })
})

describe('the redirect URI', () => {
  it('follows APP_URL with no code edit', async () => {
    asAdmin()
    vi.stubEnv('APP_URL', 'http://localhost:3000')
    const local = await getProviderAppsHandler()
    expect(local.map((r) => r.redirectUri)).toEqual([
      'http://localhost:3000/api/connections/google/callback',
      'http://localhost:3000/api/connections/box/callback',
    ])
    vi.stubEnv('APP_URL', 'https://example.com/spaces/')
    const moved = await getProviderAppsHandler()
    expect(moved.at(0)?.redirectUri).toBe(
      'https://example.com/spaces/api/connections/google/callback',
    )
  })
})

describe('the members connected through a client', () => {
  it('counts each member once across products, and no revoked grant', async () => {
    const grant = (product: string, status: 'active' | 'revoked') => ({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product,
      externalEmail: 'anish@fund.example',
      tokensEnc: Buffer.from('sealed'),
      status,
    })
    await db
      .insert(accountConnection)
      .values([
        grant('gmail', 'active'),
        grant('calendar', 'active'),
        grant('drive', 'revoked'),
      ])
    asAdmin()
    const apps = await getProviderAppsHandler()
    expect(apps.map((a) => [a.provider, a.membersConnected])).toEqual([
      ['google', 1],
      ['box', 0],
    ])
    await db
      .delete(accountConnection)
      .where(eq(accountConnection.provider, 'google'))
  })
})

describe('which providers a member can connect to', () => {
  it('lists only providers with an active client, to a member, ids only', async () => {
    await db.delete(credential).where(eq(credential.kind, 'oauth_client'))
    asMember()
    expect(await getConfiguredProvidersHandler()).toEqual([])
    asAdmin()
    await setProviderAppHandler({
      provider: 'google',
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    })
    asMember()
    expect(await getConfiguredProvidersHandler()).toEqual(['google'])
  })

  it('refuses no session', async () => {
    await expect(getConfiguredProvidersHandler()).rejects.toThrow(
      'Unauthorized',
    )
  })
})
