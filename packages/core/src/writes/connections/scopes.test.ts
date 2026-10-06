import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptBundle } from './bundle'
import { hasScopes, holdsConnection, unionScopes } from './scopes'

/** What a connection holds, asked by id with no user. */

/** Isolation is per file; each case starts with no connection. */
beforeEach(async () => {
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
})

async function connection(product: string, scopes: Array<string>) {
  const rows = await db
    .insert(accountConnection)
    .values({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product,
      externalEmail: 'anish@fund.example',
      tokensEnc: encryptBundle(
        { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
        { userId: FIXTURE_ACTOR.id, provider: 'google' },
      ),
      scopes,
    })
    .returning({ id: accountConnection.id })
  const row = rows.at(0)
  if (row === undefined) throw new Error('no connection written')
  return row.id
}

const check = (id: string, scopes: ReadonlyArray<string>) =>
  Effect.runPromise(hasScopes(id, scopes))

describe('hasScopes', () => {
  it('answers granted when the row holds every scope asked', async () => {
    const id = await connection('drive', ['openid', 'email', 'drive.file'])
    expect(await check(id, ['drive.file'])).toEqual({ _tag: 'granted' })
    expect(await check(id, [])).toEqual({ _tag: 'granted' })
  })

  it('lists exactly the scopes the row lacks', async () => {
    const id = await connection('drive', ['openid', 'email', 'drive.file'])
    expect(
      await check(id, ['drive.file', 'drive.readonly', 'drive.readonly']),
    ).toEqual({ _tag: 'missing', scopes: ['drive.readonly'] })
  })

  it('fails ConnectionNotFound for an unknown or malformed id', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const error = await Effect.runPromise(
        Effect.flip(hasScopes(id, ['drive.file'])),
      )
      expect(error).toMatchObject({
        _tag: 'ConnectionNotFound',
        connectionId: id,
      })
    }
  })
})

describe('holdsConnection', () => {
  it('answers per product', async () => {
    await connection('drive', ['drive.file'])
    const key = { userId: FIXTURE_ACTOR.id, provider: 'google' }
    expect(
      await Effect.runPromise(holdsConnection({ ...key, product: 'drive' })),
    ).toBe(true)
    expect(
      await Effect.runPromise(holdsConnection({ ...key, product: 'calendar' })),
    ).toBe(false)
  })
})

describe('unionScopes', () => {
  it('orders by the registry and keeps unknown values after', () => {
    expect(
      unionScopes('google', ['drive.readonly', 'zz'], ['email', 'openid']),
    ).toEqual(['openid', 'email', 'drive.readonly', 'zz'])
    expect(unionScopes('dropbox', ['b'], ['a', 'b'])).toEqual(['b', 'a'])
  })
})
