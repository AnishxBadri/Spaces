import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Effect } from 'effect'
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
import { accountConnection, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { PROVIDERS } from '@spaces/core/providers/registry'
import { storeCredential } from '@spaces/core/writes/vault'
import { markBoundConnectionRefused } from '@spaces/core/writes/connections/refused'
import type { ProviderEndpoints } from '@spaces/core/writes/connections/token'
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
import { disconnectConnectionProgram } from './custody'
import { handleConnectStart } from './start'
import type { ProviderTable } from './start'

/**
 * The connect dance binds the product's plugin row: after Box's callback the
 * `box` integration reads this grant, so the readers that join
 * `integration.connection_id` (the mailbox, the queues, `refused`) find it,
 * and Disconnect lets go of it. Run against the SDK's fake Box on loopback.
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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

beforeEach(async () => {
  box = makeFakeBoxApi()
  tokenDelayMs = 0
  session.current = { id: FIXTURE_ACTOR.id }
  vi.stubEnv('APP_URL', `${APP}/`)
  await db.delete(integration).where(isNotNull(integration.id))
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

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
  const row = (
    await db
      .select()
      .from(accountConnection)
      .where(eq(accountConnection.userId, FIXTURE_ACTOR.id))
  ).at(0)
  if (row === undefined) throw new Error('the dance stored no connection')
  return row
}

const installed = async (
  capabilityId: string,
  connectionId: string | null = null,
) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true, connectionId })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no integration')
  return row.id
}

const boundTo = async (integrationId: string) =>
  (
    await db
      .select({ connectionId: integration.connectionId })
      .from(integration)
      .where(eq(integration.id, integrationId))
  ).at(0)?.connectionId

describe('connecting a product with a wired plugin', () => {
  it('binds that plugin’s row in the callback, and no other plugin’s', async () => {
    const boxPlugin = await installed('box')
    const gmailPlugin = await installed('gmail')
    const row = await connect()
    expect(await boundTo(boxPlugin)).toBe(row.id)
    expect(await boundTo(gmailPlugin)).toBeNull()
  })

  it('lets refused reach the bound row: the connection is marked error', async () => {
    const boxPlugin = await installed('box')
    expect(await markBoundConnectionRefused(boxPlugin, 'before')).toBe(false)
    const row = await connect()
    expect(await markBoundConnectionRefused(boxPlugin, 'invalid_grant')).toBe(
      true,
    )
    const marked = (
      await db
        .select({
          status: accountConnection.status,
          errorReason: accountConnection.errorReason,
        })
        .from(accountConnection)
        .where(eq(accountConnection.id, row.id))
    ).at(0)
    expect(marked).toEqual({ status: 'error', errorReason: 'invalid_grant' })
  })

  it('nulls the binding on disconnect, and refused has nothing to mark', async () => {
    const boxPlugin = await installed('box')
    const row = await connect()
    await Effect.runPromise(
      disconnectConnectionProgram(FIXTURE_ACTOR.id, row.id, endpoints),
    )
    expect(await boundTo(boxPlugin)).toBeNull()
    expect(await markBoundConnectionRefused(boxPlugin, 'gone')).toBe(false)
  })

  it('never takes a row another member’s connection holds', async () => {
    await db.insert(user).values({
      id: 'bind-other-member',
      name: 'Sam',
      email: 'sam@bind.test',
      emailVerified: true,
    })
    const theirs = (
      await db
        .insert(accountConnection)
        .values({
          userId: 'bind-other-member',
          provider: 'box',
          product: 'box',
          externalEmail: 'sam@box.example',
          tokensEnc: Buffer.from('never read'),
          scopes: ['root_readonly'],
        })
        .returning({ id: accountConnection.id })
    ).at(0)
    if (theirs === undefined) throw new Error('no connection')
    const boxPlugin = await installed('box', theirs.id)
    await connect()
    expect(await boundTo(boxPlugin)).toBe(theirs.id)
  })

  it('nulls the binding when the connection row goes by any path (on delete set null)', async () => {
    const boxPlugin = await installed('box')
    const row = await connect()
    await db.delete(accountConnection).where(eq(accountConnection.id, row.id))
    expect(await boundTo(boxPlugin)).toBeNull()
  })
})
