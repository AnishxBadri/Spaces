import { eq } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, document, entity, user } from '@spaces/db/schema'
import { storeCredential } from '@spaces/core/writes/vault'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { startFakeIdp } from '@spaces/core/writes/connections/fake-idp'
import type { FakeIdp } from '@spaces/core/writes/connections/fake-idp'
import type { ProviderEndpoints } from '@spaces/core/writes/connections/token'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  disconnectConnectionHandler,
  refreshConnectionHandler,
  revokeConnectionHandler,
} from './custody'

/**
 * The two server fns over the token accessor and revocation, driven through
 * their handlers. Only the request is stubbed; the session check, the vault,
 * the database and the fake IdP are real.
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

const TEAMMATE = {
  id: 'spa228-teammate',
  name: 'Teammate',
  email: 'spa228-teammate@spaces.test',
}

let idp: FakeIdp
let providers: ProviderEndpoints

beforeAll(async () => {
  idp = await startFakeIdp()
  providers = {
    google: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
    box: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
  }
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
  await storeCredential({
    scope: 'workspace',
    provider: 'google',
    kind: 'oauth_client',
    secret: 'google-client-secret',
    meta: { clientId: 'google-client-id' },
    createdBy: FIXTURE_ACTOR.id,
  })
})

afterAll(async () => {
  await idp.close()
})

beforeEach(() => {
  idp.reset()
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
})

/** `forgotten`: tokens the IdP never issued, so its `/revoke` answers 400. */
async function connectionOf(userId: string, { forgotten = false } = {}) {
  const pair = forgotten
    ? { accessToken: 'never-issued', refreshToken: 'never-issued-refresh' }
    : idp.mint()
  const [row] = await db
    .insert(accountConnection)
    .values({
      userId,
      provider: 'google',
      product: 'drive',
      externalEmail: `${crypto.randomUUID()}@fund.example`,
      tokensEnc: encryptBundle(
        { ...pair, tokenType: 'Bearer' },
        { userId, provider: 'google' },
      ),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning()
  return row
}

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: accountConnection.status })
      .from(accountConnection)
      .where(eq(accountConnection.id, id))
  ).at(0)?.status

describe('refreshConnection', () => {
  it('refreshes the session user’s connection and returns no token', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    const result = await refreshConnectionHandler(
      { connectionId: row.id },
      providers,
    )
    expect(idp.tokenRequests).toHaveLength(1)
    expect(result).toEqual({
      connectionId: row.id,
      status: 'active',
      expiresAt: expect.any(String),
    })
    expect(JSON.stringify(result)).not.toContain('fake-access')
  })

  it("answers 'Not your connection' for a teammate's, before any provider call", async () => {
    const row = await connectionOf(TEAMMATE.id)
    await expect(
      refreshConnectionHandler({ connectionId: row.id }, providers),
    ).rejects.toThrow('Not your connection')
    await expect(
      refreshConnectionHandler(
        { connectionId: crypto.randomUUID() },
        providers,
      ),
    ).rejects.toThrow('Not your connection')
    expect(idp.tokenRequests).toHaveLength(0)
  })

  it('refuses without a session', async () => {
    session.current = null
    const row = await connectionOf(FIXTURE_ACTOR.id)
    await expect(
      refreshConnectionHandler({ connectionId: row.id }, providers),
    ).rejects.toThrow('Unauthorized')
  })
})

describe('revokeConnection', () => {
  it('revokes the session user’s connection at the provider', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    await expect(
      revokeConnectionHandler({ connectionId: row.id }, providers),
    ).resolves.toEqual({ connectionId: row.id, outcome: 'revoked' })
    expect(idp.revokeRequests).toHaveLength(1)
    expect(await statusOf(row.id)).toBe('revoked')
  })

  it("answers 'Not your connection' for a teammate's and leaves it", async () => {
    const row = await connectionOf(TEAMMATE.id)
    await expect(
      revokeConnectionHandler({ connectionId: row.id }, providers),
    ).rejects.toThrow('Not your connection')
    expect(idp.revokeRequests).toHaveLength(0)
    expect(await statusOf(row.id)).toBe('active')
  })
})

/** Every line the Effect logger printed while `run` ran. */
async function logged(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => JSON.stringify(a)).join(' '))
  }
  const log = vi.spyOn(console, 'log').mockImplementation(capture)
  const error = vi.spyOn(console, 'error').mockImplementation(capture)
  try {
    await run()
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
  return lines.join('\n')
}

describe('disconnectConnection', () => {
  it('revokes at the provider, then deletes the row', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    await expect(
      disconnectConnectionHandler({ connectionId: row.id }, providers),
    ).resolves.toEqual({ connectionId: row.id, revoke: 'revoked' })
    expect(idp.revokeRequests).toHaveLength(1)
    expect(await statusOf(row.id)).toBeUndefined()
  })

  it('still deletes, and logs, when the provider answers 4xx', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id, { forgotten: true })
    let result: unknown
    const lines = await logged(async () => {
      result = await disconnectConnectionHandler(
        { connectionId: row.id },
        providers,
      )
    })
    expect(result).toEqual({ connectionId: row.id, revoke: 'already-revoked' })
    expect(idp.revokeRequests).toHaveLength(1)
    expect(lines).toContain('taking it as already revoked')
    expect(await statusOf(row.id)).toBeUndefined()
  })

  it('still deletes, and logs, when the provider is unreachable', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    idp.mode.outage = true
    let result: unknown
    const lines = await logged(async () => {
      result = await disconnectConnectionHandler(
        { connectionId: row.id },
        providers,
      )
    })
    expect(result).toEqual({ connectionId: row.id, revoke: 'unreachable' })
    expect(lines).toContain('deleting the row anyway')
    expect(await statusOf(row.id)).toBeUndefined()
  })

  it('keeps the files that came through it, unlinked', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'Drive deck' })
        .returning({ id: entity.id })
    ).at(0)
    if (ent === undefined) throw new Error('no entity')
    // A fixture row: a file that arrived through the connection.
    await db.insert(document).values({
      entityId: ent.id,
      filename: 'deck.pdf',
      connectionId: row.id,
      externalId: 'drive-file-1',
    })

    await disconnectConnectionHandler({ connectionId: row.id }, providers)

    const doc = (
      await db.select().from(document).where(eq(document.entityId, ent.id))
    ).at(0)
    expect(doc?.filename).toBe('deck.pdf')
    expect(doc?.connectionId).toBeNull()
  })

  it("answers 'Not your connection' for a teammate's, revoking and deleting nothing", async () => {
    const row = await connectionOf(TEAMMATE.id)
    await expect(
      disconnectConnectionHandler({ connectionId: row.id }, providers),
    ).rejects.toThrow('Not your connection')
    expect(idp.revokeRequests).toHaveLength(0)
    expect(await statusOf(row.id)).toBe('active')
  })
})
