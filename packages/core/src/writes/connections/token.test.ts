import { Effect, Redacted } from 'effect'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import * as schema from '@spaces/db/schema'
import { accountConnection } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { storeCredential } from '../vault/index'
import { decryptBundle, encryptBundle } from './bundle'
import { startFakeIdp } from './fake-idp'
import type { FakeIdp } from './fake-idp'
import { accessTokenFor } from './token'
import type { ConnectionDb, ProviderEndpoints } from './token'

/**
 * The accessor against the fake IdP, with a second db client on its own
 * pool so the row lock is proven across connections, as web and worker
 * would hold them.
 */

let idp: FakeIdp
let providers: ProviderEndpoints
let pool: pg.Pool
let second: ConnectionDb

const HOUR = 3_600_000

beforeAll(async () => {
  idp = await startFakeIdp()
  providers = {
    google: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
    box: { tokenUrl: idp.tokenUrl, revokeUrl: idp.revokeUrl },
  }
  const url = db.$client.options.connectionString
  if (url === undefined) throw new Error('db has no connection string')
  pool = new pg.Pool({ connectionString: url, max: 5 })
  second = drizzle(pool, { schema })
  for (const provider of ['google', 'box'])
    await storeCredential({
      scope: 'workspace',
      provider,
      kind: 'oauth_client',
      secret: `${provider}-client-secret`,
      meta: { clientId: `${provider}-client-id` },
      createdBy: FIXTURE_ACTOR.id,
    })
})

afterAll(async () => {
  await pool.end()
  await idp.close()
})

beforeEach(() => {
  idp.reset()
})

/** A connection whose tokens the fake IdP issued, lapsing at `expiresAt`. */
async function connection(
  expiresAt: Date | null,
  over: { provider?: 'google' | 'box'; email?: string } = {},
) {
  const provider = over.provider ?? 'google'
  const pair = idp.mint()
  const owner = { userId: FIXTURE_ACTOR.id, provider }
  const [row] = await db
    .insert(accountConnection)
    .values({
      userId: FIXTURE_ACTOR.id,
      provider,
      product: provider === 'google' ? 'drive' : 'box',
      externalEmail: over.email ?? `${crypto.randomUUID()}@fund.example`,
      tokensEnc: encryptBundle({ ...pair, tokenType: 'Bearer' }, owner),
      scopes: ['openid', 'email', 'drive.file'],
      expiresAt,
    })
    .returning()
  return { row, pair }
}

const readRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(accountConnection)
    .where(eq(accountConnection.id, id))
  return row
}

const bundleOf = (row: typeof accountConnection.$inferSelect) =>
  decryptBundle(row.tokensEnc, { userId: row.userId, provider: row.provider })

const token = (
  id: string,
  options: { db?: ConnectionDb; force?: boolean } = {},
) => accessTokenFor(id, { providers, ...options })

describe('accessTokenFor', () => {
  it('hands back the stored token while it has more than a minute left', async () => {
    const { row, pair } = await connection(new Date(Date.now() + HOUR))
    const value = await Effect.runPromise(token(row.id))
    expect(Redacted.value(value)).toBe(pair.accessToken)
    expect(String(value)).not.toContain(pair.accessToken)
    expect(idp.tokenRequests).toHaveLength(0)
  })

  it('refreshes a lapsed token on first use and persists the new bundle', async () => {
    const lapsed = new Date(Date.now() - HOUR)
    const { row, pair } = await connection(lapsed)
    const value = Redacted.value(await Effect.runPromise(token(row.id)))

    expect(idp.tokenRequests).toHaveLength(1)
    const sent = idp.tokenRequests[0]
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe(pair.refreshToken)
    expect(sent.get('client_id')).toBe('google-client-id')
    expect(sent.get('client_secret')).toBe('google-client-secret')

    const after = await readRow(row.id)
    const bundle = bundleOf(after)
    expect(value).toBe(bundle.accessToken)
    expect(bundle.accessToken).not.toBe(pair.accessToken)
    expect(bundle.refreshToken).not.toBe(pair.refreshToken)
    expect(idp.liveRefreshTokens()).toContain(bundle.refreshToken)
    expect(after.expiresAt?.getTime()).toBeGreaterThan(Date.now() + HOUR / 2)
    expect(after.status).toBe('active')

    // Fresh now: the next call is served from the row.
    await Effect.runPromise(token(row.id))
    expect(idp.tokenRequests).toHaveLength(1)
  })

  it('refreshes inside the last minute', async () => {
    const { row } = await connection(new Date(Date.now() + 30_000))
    await Effect.runPromise(token(row.id))
    expect(idp.tokenRequests).toHaveLength(1)
  })

  it('ten concurrent calls across two db clients make one token request', async () => {
    const { row, pair } = await connection(new Date(Date.now() - HOUR))
    idp.mode.tokenDelayMs = 150
    const values = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Effect.runPromise(token(row.id, { db: i % 2 === 0 ? db : second })),
      ),
    )

    expect(idp.tokenRequests).toHaveLength(1)
    const tokens = new Set(values.map((v) => Redacted.value(v)))
    expect(tokens.size).toBe(1)

    const bundle = bundleOf(await readRow(row.id))
    expect([...tokens]).toEqual([bundle.accessToken])
    // The rotation left one live refresh token, and it is the stored one.
    const live = idp
      .liveRefreshTokens()
      .filter((t) => t === pair.refreshToken || t === bundle.refreshToken)
    expect(live).toEqual([bundle.refreshToken])
  })

  it('stores the refresh token lapse when the provider sends one (Box)', async () => {
    idp.mode.refreshTokenExpiresIn = 60 * 24 * 3600
    const { row } = await connection(new Date(Date.now() - HOUR), {
      provider: 'box',
    })
    await Effect.runPromise(token(row.id))
    const after = await readRow(row.id)
    expect(after.refreshTokenExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 59 * 24 * HOUR,
    )
    expect(idp.tokenRequests[0].get('client_id')).toBe('box-client-id')
  })

  it('force refreshes a token that is still fresh', async () => {
    const { row, pair } = await connection(new Date(Date.now() + HOUR))
    const value = await Effect.runPromise(token(row.id, { force: true }))
    expect(idp.tokenRequests).toHaveLength(1)
    expect(Redacted.value(value)).not.toBe(pair.accessToken)
  })

  it('invalid_grant marks the row error with the reason and keeps its scopes and bundle', async () => {
    const { row } = await connection(new Date(Date.now() - HOUR))
    idp.mode.refuseRefresh = 'invalid_grant'
    const error = await Effect.runPromise(Effect.flip(token(row.id)))
    expect(error._tag).toBe('AuthExpired')

    const after = await readRow(row.id)
    expect(after.status).toBe('error')
    expect(after.errorReason).toBe(
      'invalid_grant: Token has been expired or revoked.',
    )
    expect(after.scopes).toEqual(row.scopes)
    expect(Buffer.compare(after.tokensEnc, row.tokensEnc)).toBe(0)
    expect(after.expiresAt).toEqual(row.expiresAt)
  })

  it('never returns a token for an error or revoked row, and never asks the provider', async () => {
    for (const status of ['error', 'revoked'] as const) {
      const { row } = await connection(new Date(Date.now() + HOUR))
      await db
        .update(accountConnection)
        .set({
          status,
          errorReason: status === 'error' ? 'invalid_grant' : null,
        })
        .where(eq(accountConnection.id, row.id))
      const error = await Effect.runPromise(Effect.flip(token(row.id)))
      expect(error._tag).toBe('AuthExpired')
    }
    expect(idp.tokenRequests).toHaveLength(0)
  })

  it('a provider outage is ProviderUnavailable and changes nothing', async () => {
    const { row } = await connection(new Date(Date.now() - HOUR))
    idp.mode.outage = true
    const error = await Effect.runPromise(Effect.flip(token(row.id)))
    expect(error).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 })
    const after = await readRow(row.id)
    expect(after.status).toBe('active')
    expect(Buffer.compare(after.tokensEnc, row.tokensEnc)).toBe(0)
    expect(after.expiresAt).toEqual(row.expiresAt)
  })

  it('a provider that never answers is ProviderUnavailable', async () => {
    const { row } = await connection(new Date(Date.now() - HOUR))
    const error = await Effect.runPromise(
      Effect.flip(
        accessTokenFor(row.id, {
          providers: {
            ...providers,
            google: { tokenUrl: 'http://127.0.0.1:9/token', revokeUrl: '' },
          },
        }),
      ),
    )
    expect(error).toMatchObject({ _tag: 'ProviderUnavailable', status: null })
    expect((await readRow(row.id)).status).toBe('active')
  })

  it('fails ConnectionNotFound for a row that is not there', async () => {
    const error = await Effect.runPromise(
      Effect.flip(token(crypto.randomUUID())),
    )
    expect(error._tag).toBe('ConnectionNotFound')
  })

  it('returns a pasted key unchanged, with no expiry and no refresh call (D78)', async () => {
    const owner = { userId: FIXTURE_ACTOR.id, provider: 'granola' }
    const [row] = await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'granola',
        product: 'notes',
        externalEmail: 'anish@fund.example',
        tokensEnc: encryptBundle(
          { type: 'api_key', key: 'grn_live_key' },
          owner,
        ),
        expiresAt: null,
      })
      .returning()
    const value = await Effect.runPromise(token(row.id, { force: true }))
    expect(Redacted.value(value)).toBe('grn_live_key')
    expect(idp.tokenRequests).toHaveLength(0)
    expect((await readRow(row.id)).status).toBe('active')
  })
})
