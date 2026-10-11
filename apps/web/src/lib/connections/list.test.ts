import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, integration, user } from '@spaces/db/schema'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { listAccountsHandler } from './list'

/**
 * The accounts server fn's body, driven through its handler. Only the
 * request is stubbed; the session check and the database are real.
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
  id: 'spa234-teammate',
  name: 'Teammate',
  email: 'spa234-teammate@spaces.test',
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
})

beforeEach(() => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
})

async function connectionOf(userId: string, externalEmail: string) {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product: 'drive',
        externalEmail,
        tokensEnc: encryptBundle(
          {
            accessToken: 'secret-access',
            refreshToken: 'secret-refresh',
            tokenType: 'Bearer',
          },
          { userId, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file'],
      })
      .returning()
  ).at(0)
  if (row === undefined) throw new Error('no connection row')
  return row
}

describe('getMyAccounts', () => {
  it("hands the reader's rows, the configured providers and which plugins are installed", async () => {
    const mine = await connectionOf(FIXTURE_ACTOR.id, 'mine@fund.example')
    const theirs = await connectionOf(TEAMMATE.id, 'theirs@fund.example')
    await db.insert(integration).values([
      { capabilityId: 'google-drive', version: '0.1.0' },
      { capabilityId: 'box', version: '0.1.0', removedAt: new Date() },
    ])

    const view = await listAccountsHandler()
    const ids = view.connections.map((r) => r.connectionId)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
    expect(view.configured).toEqual([])
    expect(view.installed).toEqual(['google-drive'])
    expect(view.offered).toEqual([])
  })

  it('refuses without a session', async () => {
    session.current = null
    await expect(listAccountsHandler()).rejects.toThrow('Unauthorized')
  })
})
