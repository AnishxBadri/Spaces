import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Effect, Redacted } from 'effect'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { eq, isNotNull } from 'drizzle-orm'
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
import { db } from '@spaces/db'
import * as schema from '@spaces/db/schema'
import { accountConnection } from '@spaces/db/schema'
import { PROVIDERS } from '@spaces/core/providers/registry'
import { storeCredential } from '@spaces/core/writes/vault'
import { decryptBundle } from '@spaces/core/writes/connections/bundle'
import { accessTokenFor } from '@spaces/core/writes/connections/token'
import type {
  ConnectionDb,
  ProviderEndpoints,
} from '@spaces/core/writes/connections/token'
import {
  BOX_API,
  BOX_AUTHORIZE_URL,
  BOX_OAUTH,
  FAKE_BOX_CREDENTIALS,
  makeFakeBoxApi,
} from '@spaces/sdk/testing'
import type { FakeBoxApi } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { handleConnectCallback } from './callback'
import { handleConnectStart } from './start'
import type { ProviderTable } from './start'

/**
 * Box's single-use refresh token, against the SDK's fake Box: the connect
 * dance (start → Box's authorize → callback) stores the grant, every
 * refresh rotates the refresh token and spends the old one, and two
 * concurrent `accessTokenFor` calls leave a connection Box still honours.
 * The fake is served on a loopback port, since core reaches the token
 * endpoint with plain `fetch`.
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

/** Loopback paths → the Box URLs the fake answers. */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['/api/oauth2/authorize', BOX_AUTHORIZE_URL],
  ['/oauth2/', `${BOX_OAUTH}/`],
  ['/2.0/', `${BOX_API}/`],
]

let box: FakeBoxApi
let server: Server
let origin: string
let providers: ProviderTable
let endpoints: ProviderEndpoints
let pool: pg.Pool
let second: ConnectionDb
/** Milliseconds the token endpoint waits before answering, to widen a race. */
let tokenDelayMs = 0

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/** The fake Box's `fetch`, served over http on an ephemeral port. */
const serve = () =>
  createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '/'
      const route = ROUTES.find(([prefix]) => path.startsWith(prefix))
      if (route === undefined) {
        res.writeHead(404).end()
        return
      }
      const body = await readBody(req)
      if (path.startsWith('/oauth2/token') && tokenDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, tokenDelayMs))
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === 'string') headers[name] = value
      const answer = await box.fetch(
        `${route[1]}${path.slice(route[0].length)}`,
        {
          method: req.method ?? 'GET',
          headers,
          ...(body === '' ? {} : { body }),
        },
      )
      const out: Record<string, string> = {}
      answer.headers.forEach((value, name) => {
        out[name] = value
      })
      res
        .writeHead(answer.status, out)
        .end(Buffer.from(await answer.arrayBuffer()))
    })()
  })

beforeAll(async () => {
  server = serve()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('the fake Box did not bind a port')
  const { port }: AddressInfo = address
  origin = `http://127.0.0.1:${String(port)}`
  providers = {
    google: PROVIDERS.google,
    box: {
      ...PROVIDERS.box,
      authUrl: `${origin}/api/oauth2/authorize`,
      tokenUrl: `${origin}/oauth2/token`,
      revokeUrl: `${origin}/oauth2/revoke`,
      userinfoUrl: `${origin}/2.0/users/me`,
    },
  }
  endpoints = {
    google: PROVIDERS.google,
    box: {
      tokenUrl: providers.box.tokenUrl,
      revokeUrl: providers.box.revokeUrl,
    },
  }
  const url = db.$client.options.connectionString
  if (url === undefined) throw new Error('db has no connection string')
  pool = new pg.Pool({ connectionString: url, max: 3 })
  second = drizzle(pool, { schema })
  await storeCredential({
    scope: 'workspace',
    provider: 'box',
    kind: 'oauth_client',
    secret: FAKE_BOX_CREDENTIALS.clientSecret,
    meta: { clientId: FAKE_BOX_CREDENTIALS.clientId },
    createdBy: FIXTURE_ACTOR.id,
  })
})

afterAll(async () => {
  await pool.end()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

beforeEach(async () => {
  box = makeFakeBoxApi()
  tokenDelayMs = 0
  session.current = { id: FIXTURE_ACTOR.id }
  vi.stubEnv('APP_URL', `${APP}/`)
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const owner = { userId: FIXTURE_ACTOR.id, provider: 'box' }

const readRow = async (id: string) => {
  const row = (
    await db
      .select()
      .from(accountConnection)
      .where(eq(accountConnection.id, id))
  ).at(0)
  if (row === undefined) throw new Error(`no connection ${id}`)
  return row
}

const bundle = async (id: string) =>
  decryptBundle((await readRow(id)).tokensEnc, owner)

/** start → Box's authorize → callback, as a browser would; the stored row. */
async function connect() {
  const started = await handleConnectStart(
    new Request(`${APP}/api/connections/box/start?product=box`),
    'box',
    providers,
  )
  expect(started.status).toBe(302)
  const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]
  const authorized = await fetch(started.headers.get('location') ?? '', {
    redirect: 'manual',
  })
  expect(authorized.status).toBe(302)
  const back = authorized.headers.get('location') ?? ''
  const done = await handleConnectCallback(
    new Request(back, { headers: { cookie } }),
    'box',
    providers,
  )
  expect(done.status).toBe(302)
  const row = (await db.select().from(accountConnection)).at(0)
  if (row === undefined) throw new Error('the dance stored no connection')
  return row
}

const token = (
  id: string,
  options: { readonly force?: boolean; readonly db?: ConnectionDb } = {},
) => accessTokenFor(id, { providers: endpoints, ...options })

/** What Box says to a refresh token sent straight to its token endpoint. */
const spend = async (refreshToken: string) => {
  const answer = await fetch(`${origin}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: FAKE_BOX_CREDENTIALS.clientId,
      client_secret: FAKE_BOX_CREDENTIALS.clientSecret,
    }),
  })
  return { status: answer.status, body: await answer.text() }
}

/** Whether Box's content API accepts the token. */
const accepted = async (accessToken: string) =>
  (
    await fetch(`${origin}/2.0/folders/0?fields=id`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  ).status === 200

describe('connecting Box', () => {
  it('stores the grant the dance returned', async () => {
    const row = await connect()
    expect(row).toMatchObject({
      provider: 'box',
      product: 'box',
      externalAccountId: FAKE_BOX_CREDENTIALS.userId,
      externalEmail: FAKE_BOX_CREDENTIALS.login,
      scopes: ['root_readonly'],
      status: 'active',
    })
    const stored = decryptBundle(row.tokensEnc, owner)
    expect(box.oauth.liveRefreshTokens()).toContain(stored.refreshToken)
    expect(await accepted(stored.accessToken)).toBe(true)
  })

  it('rotates the refresh token on every refresh, and a spent one is refused', async () => {
    const row = await connect()
    const spent: Array<string> = []
    for (let round = 0; round < 2; round++) {
      const before = await bundle(row.id)
      await Effect.runPromise(token(row.id, { force: true }))
      const after = await bundle(row.id)
      expect(after.refreshToken).not.toBe(before.refreshToken)
      expect(box.oauth.liveRefreshTokens()).toContain(after.refreshToken)
      if (before.refreshToken !== null) spent.push(before.refreshToken)
    }
    for (const old of spent) {
      expect(box.oauth.liveRefreshTokens()).not.toContain(old)
      expect(await spend(old)).toMatchObject({
        status: 400,
        body: expect.stringContaining('invalid_grant'),
      })
    }
  })

  it('two concurrent accessTokenFor calls spend the refresh token once and leave a working connection', async () => {
    const row = await connect()
    const before = await bundle(row.id)
    await db
      .update(accountConnection)
      .set({ expiresAt: new Date(Date.now() - 3_600_000) })
      .where(eq(accountConnection.id, row.id))
    tokenDelayMs = 150
    const refreshes = () =>
      box.oauth.tokenRequests.filter(
        (f) => f.get('grant_type') === 'refresh_token',
      ).length
    const values = await Promise.all([
      Effect.runPromise(token(row.id)),
      Effect.runPromise(token(row.id, { db: second })),
    ])
    expect(refreshes()).toBe(1)
    const [first, other] = values.map((v) => Redacted.value(v))
    expect(other).toBe(first)

    const after = await bundle(row.id)
    expect((await readRow(row.id)).status).toBe('active')
    expect(after.accessToken).toBe(first)
    expect(after.refreshToken).not.toBe(before.refreshToken)
    // One live refresh token is left of the two, and it is the stored one.
    expect(
      box.oauth
        .liveRefreshTokens()
        .filter((t) => t === before.refreshToken || t === after.refreshToken),
    ).toEqual([after.refreshToken])
    expect(await accepted(first)).toBe(true)
    // Still working: the next refresh goes through.
    tokenDelayMs = 0
    const next = Redacted.value(
      await Effect.runPromise(token(row.id, { force: true })),
    )
    expect(await accepted(next)).toBe(true)
    expect(refreshes()).toBe(2)
  })

  it('a grant lapsed by 60 days unused marks the connection error', async () => {
    const row = await connect()
    box.oauth.lapse()
    const error = await Effect.runPromise(
      Effect.flip(token(row.id, { force: true })),
    )
    expect(error._tag).toBe('AuthExpired')
    expect(await readRow(row.id)).toMatchObject({
      status: 'error',
      errorReason: 'invalid_grant: Refresh token has expired',
    })
  })
})
