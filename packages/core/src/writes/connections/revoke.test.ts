import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { storeCredential } from '../vault/index'
import { encryptBundle } from './bundle'
import { startFakeIdp } from './fake-idp'
import type { FakeIdp } from './fake-idp'
import { revokeConnection } from './revoke'
import type { ProviderEndpoints } from './token'

/** Revocation against the fake IdP's `/revoke`. */

let idp: FakeIdp
let providers: ProviderEndpoints

beforeAll(async () => {
  idp = await startFakeIdp()
  providers = {
    google: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
    box: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
  }
  await storeCredential({
    scope: 'workspace',
    provider: 'box',
    kind: 'oauth_client',
    secret: 'box-client-secret',
    meta: { clientId: 'box-client-id' },
    createdBy: FIXTURE_ACTOR.id,
  })
})

afterAll(async () => {
  await idp.close()
})

beforeEach(() => {
  idp.reset()
})

async function connection(provider: 'google' | 'box' = 'google') {
  const pair = idp.mint()
  const [row] = await db
    .insert(accountConnection)
    .values({
      userId: FIXTURE_ACTOR.id,
      provider,
      product: provider === 'google' ? 'drive' : 'box',
      externalEmail: `${crypto.randomUUID()}@fund.example`,
      tokensEnc: encryptBundle(
        { ...pair, tokenType: 'Bearer' },
        { userId: FIXTURE_ACTOR.id, provider },
      ),
      scopes: ['openid', 'email'],
    })
    .returning()
  return { row, pair }
}

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: accountConnection.status })
      .from(accountConnection)
      .where(eq(accountConnection.id, id))
  ).at(0)?.status

const revoke = (id: string) => revokeConnection(id, { providers })

describe('revokeConnection', () => {
  it('posts the refresh token to the revoke URL and marks the row revoked', async () => {
    const { row, pair } = await connection()
    await expect(Effect.runPromise(revoke(row.id))).resolves.toBe('revoked')

    expect(idp.revokeRequests).toHaveLength(1)
    const sent = idp.revokeRequests[0]
    expect(sent.get('token')).toBe(pair.refreshToken)
    expect(sent.has('client_secret')).toBe(false)
    expect(idp.liveRefreshTokens()).not.toContain(pair.refreshToken)
    expect(await statusOf(row.id)).toBe('revoked')
  })

  it('sends Box the client id and secret beside the token', async () => {
    const { row, pair } = await connection('box')
    await expect(Effect.runPromise(revoke(row.id))).resolves.toBe('revoked')
    const sent = idp.revokeRequests[0]
    expect(sent.get('token')).toBe(pair.refreshToken)
    expect(sent.get('client_id')).toBe('box-client-id')
    expect(sent.get('client_secret')).toBe('box-client-secret')
  })

  it('takes a 4xx as already revoked, not as a failure', async () => {
    const { row } = await connection()
    await Effect.runPromise(revoke(row.id))
    // The provider has forgotten the token: the second POST answers 400.
    await expect(Effect.runPromise(revoke(row.id))).resolves.toBe(
      'already-revoked',
    )
    expect(idp.revokeRequests).toHaveLength(2)
    expect(await statusOf(row.id)).toBe('revoked')
  })

  it('a provider outage fails ProviderUnavailable and leaves the row', async () => {
    const { row } = await connection()
    idp.mode.outage = true
    const error = await Effect.runPromise(Effect.flip(revoke(row.id)))
    expect(error).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 })
    expect(await statusOf(row.id)).toBe('active')
  })

  it('fails ConnectionNotFound for a row that is not there', async () => {
    const error = await Effect.runPromise(
      Effect.flip(revoke(crypto.randomUUID())),
    )
    expect(error._tag).toBe('ConnectionNotFound')
  })
})
