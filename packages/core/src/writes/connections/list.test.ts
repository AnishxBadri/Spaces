import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  integration,
  user,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptBundle } from './bundle'
import { forgetConnection, listConnectionsFor } from './list'

/** A user's connections: listed without tokens, forgotten only by their owner. */

const TEAMMATE = {
  id: 'spa234-teammate',
  name: 'Teammate',
  email: 'spa234-teammate@spaces.test',
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
})

async function connectionOf(
  userId: string,
  product = 'drive',
  extra: Partial<typeof accountConnection.$inferInsert> = {},
) {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId,
        provider: 'google',
        product,
        externalEmail: `${crypto.randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          {
            accessToken: 'secret-access',
            refreshToken: 'secret-refresh',
            tokenType: 'Bearer',
          },
          { userId, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file'],
        ...extra,
      })
      .returning()
  ).at(0)
  if (row === undefined) throw new Error('no connection row')
  return row
}

describe('listConnectionsFor', () => {
  it("returns the user's rows only, with no token bytes", async () => {
    const mine = await connectionOf(FIXTURE_ACTOR.id, 'drive', {
      status: 'error',
      errorReason: 'invalid_grant: Token has been expired or revoked.',
    })
    const theirs = await connectionOf(TEAMMATE.id)

    const rows = await listConnectionsFor(FIXTURE_ACTOR.id)
    expect(rows.map((r) => r.id)).toEqual([mine.id])
    expect(rows[0]).toEqual({
      id: mine.id,
      provider: 'google',
      product: 'drive',
      externalEmail: mine.externalEmail,
      scopes: ['openid', 'email', 'drive.file'],
      status: 'error',
      errorReason: 'invalid_grant: Token has been expired or revoked.',
      lastSyncAt: null,
      refreshTokenExpiresAt: null,
      createdAt: expect.any(Date),
    })
    expect(Object.keys(rows[0])).not.toContain('tokensEnc')
    expect((await listConnectionsFor(TEAMMATE.id)).map((r) => r.id)).toEqual([
      theirs.id,
    ])
  })
})

describe('forgetConnection', () => {
  it('deletes the row and unlinks documents and integrations that pointed at it', async () => {
    const row = await connectionOf(FIXTURE_ACTOR.id)
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'Bound deck' })
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
    const bound = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'google-drive',
          version: '1.0.0',
          connectionId: row.id,
        })
        .returning({ id: integration.id })
    ).at(0)
    if (bound === undefined) throw new Error('no integration')

    await expect(forgetConnection(FIXTURE_ACTOR.id, row.id)).resolves.toBe(true)

    expect(
      await db
        .select()
        .from(accountConnection)
        .where(eq(accountConnection.id, row.id)),
    ).toEqual([])
    const doc = (
      await db.select().from(document).where(eq(document.entityId, ent.id))
    ).at(0)
    expect(doc?.connectionId).toBeNull()
    expect(doc?.filename).toBe('deck.pdf')
    const plugin = (
      await db.select().from(integration).where(eq(integration.id, bound.id))
    ).at(0)
    expect(plugin?.connectionId).toBeNull()
  })

  it("leaves another user's connection where it is", async () => {
    const theirs = await connectionOf(TEAMMATE.id)
    await expect(forgetConnection(FIXTURE_ACTOR.id, theirs.id)).resolves.toBe(
      false,
    )
    expect(
      await db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(eq(accountConnection.id, theirs.id)),
    ).toEqual([{ id: theirs.id }])
  })
})
