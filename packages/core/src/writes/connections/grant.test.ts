import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { decryptBundle } from './bundle'
import { upsertConnection } from './grant'
import type { ConnectionGrant } from './grant'

/** The callback's write: scopes grow by union, the refresh token survives a grant that omits it. */

const owner = { userId: FIXTURE_ACTOR.id, provider: 'google' }

const grant = (
  n: number,
  scopes: ReadonlyArray<string>,
  refresh: boolean = true,
): ConnectionGrant => ({
  userId: FIXTURE_ACTOR.id,
  provider: 'google',
  product: 'drive',
  externalEmail: 'anish@fund.example',
  externalAccountId: '1098765',
  scopes,
  bundle: {
    accessToken: `access-${String(n)}`,
    refreshToken: refresh ? `refresh-${String(n)}` : null,
    tokenType: 'Bearer',
  },
  expiresAt: new Date(Date.now() + 3600_000),
  refreshTokenExpiresAt: null,
})

const write = (g: ConnectionGrant) => Effect.runPromise(upsertConnection(g))
const rows = () => db.select().from(accountConnection)
const tokens = (blob: Buffer) => decryptBundle(blob, owner)

/** Isolation is per file; each case starts with no connection. */
beforeEach(async () => {
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
})

describe('upsertConnection', () => {
  it('stores a first grant as granted', async () => {
    await write(grant(1, ['openid', 'email', 'drive.file']))
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].scopes).toEqual(['openid', 'email', 'drive.file'])
    expect(tokens(all[0].tokensEnc).refreshToken).toBe('refresh-1')
  })

  it('unions a later grant onto the row in registry order and replaces the tokens', async () => {
    const first = await write(grant(1, ['openid', 'email', 'drive.file']))
    const second = await write(grant(2, ['drive.readonly', 'openid']))
    expect(second.id).toBe(first.id)
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].scopes).toEqual([
      'openid',
      'email',
      'drive.file',
      'drive.readonly',
    ])
    expect(tokens(all[0].tokensEnc)).toEqual({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      tokenType: 'Bearer',
    })
  })

  it('keeps the stored refresh token when the new grant carries none', async () => {
    await write(grant(1, ['openid', 'email', 'drive.file']))
    await write(grant(2, ['drive.readonly'], false))
    const bundle = tokens((await rows())[0].tokensEnc)
    expect(bundle.accessToken).toBe('access-2')
    expect(bundle.refreshToken).toBe('refresh-1')
  })

  it('stores no refresh token on a first grant that carries none', async () => {
    await write(grant(1, ['drive.file'], false))
    expect(tokens((await rows())[0].tokensEnc).refreshToken).toBeNull()
  })

  it('makes an errored row active again and still unions', async () => {
    const { id } = await write(grant(1, ['openid', 'drive.file']))
    await db
      .update(accountConnection)
      .set({ status: 'error', errorReason: 'invalid_grant' })
      .where(eq(accountConnection.id, id))
    await write(grant(2, ['drive.readonly']))
    expect((await rows())[0]).toMatchObject({
      status: 'active',
      errorReason: null,
      scopes: ['openid', 'drive.file', 'drive.readonly'],
    })
  })

  it('carries nothing over from a revoked row', async () => {
    const { id } = await write(grant(1, ['openid', 'email', 'drive.file']))
    await db
      .update(accountConnection)
      .set({ status: 'revoked' })
      .where(eq(accountConnection.id, id))
    await write(grant(2, ['drive.file'], false))
    const row = (await rows())[0]
    expect(row).toMatchObject({ status: 'active', scopes: ['drive.file'] })
    expect(tokens(row.tokensEnc).refreshToken).toBeNull()
  })

  it('keeps another provider account on its own row', async () => {
    await write(grant(1, ['drive.file']))
    await write({ ...grant(2, ['drive.file']), externalEmail: 'a@b.example' })
    expect(await rows()).toHaveLength(2)
  })
})
