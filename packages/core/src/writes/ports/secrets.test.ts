import { Effect, Exit, Redacted } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { Secrets } from '@spaces/sdk'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptBundle } from '../connections/bundle'
import { SecretsLive } from './secrets'

/**
 * `Secrets.accessToken()` over the bound row's connection: the token from
 * `accessTokenFor`, and `NotConnected` whenever there is none to give.
 * The tokens here are fresh, so no provider is asked.
 */

const ACCESS = 'ya29.bound-access-token'

async function boundRow(connection: 'none' | 'active' | 'error') {
  let connectionId: string | null = null
  if (connection !== 'none') {
    const [row] = await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'drive',
        externalEmail: `${crypto.randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { accessToken: ACCESS, refreshToken: 'r', tokenType: 'Bearer' },
          { userId: FIXTURE_ACTOR.id, provider: 'google' },
        ),
        expiresAt: new Date(Date.now() + 3_600_000),
        status: connection,
        errorReason: connection === 'error' ? 'invalid_grant' : null,
      })
      .returning()
    connectionId = row.id
  }
  const [row] = await db
    .insert(integration)
    .values({ capabilityId: 'google-drive', version: '1.0.0', connectionId })
    .returning()
  return row
}

const accessToken = async (row: Awaited<ReturnType<typeof boundRow>>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Secrets).accessToken()
    }).pipe(Effect.provide(SecretsLive(row, null))),
  )

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

describe('SecretsLive.accessToken', () => {
  it("hands out the bound connection's token, redacted", async () => {
    const exit = await accessToken(await boundRow('active'))
    if (!Exit.isSuccess(exit)) throw new Error('expected a token')
    expect(Redacted.value(exit.value)).toBe(ACCESS)
    expect(String(exit.value)).not.toContain(ACCESS)
  })

  it('is NotConnected when the row has no connection', async () => {
    const failure = failureOf(await accessToken(await boundRow('none')))
    expect(failure).toMatchObject({ _tag: 'NotConnected' })
  })

  it('is NotConnected, with the reason, when the connection is in error', async () => {
    const row = await boundRow('error')
    const failure = failureOf(await accessToken(row))
    expect(failure._tag).toBe('NotConnected')
    expect(failure.reason).toContain('invalid_grant')
    const [connection] = await db
      .select({ status: accountConnection.status })
      .from(accountConnection)
      .where(eq(accountConnection.id, row.connectionId ?? ''))
    expect(connection.status).toBe('error')
  })
})
