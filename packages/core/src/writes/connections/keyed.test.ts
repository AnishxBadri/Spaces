import { Effect, Exit, Redacted } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, user } from '@spaces/db/schema'
import {
  FAKE_GRANOLA_KEY,
  FAKE_GRANOLA_OWNER,
  makeFakeGranolaApi,
} from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { decryptConnectionBundle } from './bundle'
import {
  connectKeyProgram,
  disconnectKeyedProgram,
  recorderAccountProgram,
  saveRecorderSettingsProgram,
} from './keyed'
import { accessTokenFor } from './token'

/**
 * A member's Granola key on You → Meeting notes, against the fake
 * Granola: one `account_connection` row with an `api_key` bundle, the
 * member's folders listed with their key, ticks written to `settings`.
 */

const member = async () => {
  const id = `member-${crypto.randomUUID()}`
  await db.insert(user).values({
    id,
    name: 'Member',
    email: `${id}@fund.example`,
    emailVerified: true,
  })
  return id
}

const connect = (userId: string, key: string, api = makeFakeGranolaApi()) =>
  Effect.runPromiseExit(
    connectKeyProgram(
      { userId, provider: 'granola', key },
      { fetch: api.fetch },
    ),
  )

const valueOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>): TValue => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`failed: ${String(exit.cause)}`)
}

describe('pasting a Granola key', () => {
  it('writes one connection row holding an api_key bundle, and accessTokenFor returns the key', async () => {
    const userId = await member()
    const api = makeFakeGranolaApi()
    const { connectionId, email } = valueOf(
      await connect(userId, ` ${FAKE_GRANOLA_KEY} `, api),
    )
    expect(email).toBe(FAKE_GRANOLA_OWNER)
    expect(api.requests.map((r) => r.path)).toEqual(['/me'])
    const row = (
      await db
        .select()
        .from(accountConnection)
        .where(eq(accountConnection.id, connectionId))
    ).at(0)
    expect(row).toMatchObject({
      provider: 'granola',
      product: 'notes',
      externalEmail: FAKE_GRANOLA_OWNER,
      scopes: [],
      expiresAt: null,
      status: 'active',
    })
    if (row === undefined) throw new Error('no row')
    expect(
      decryptConnectionBundle(row.tokensEnc, { userId, provider: 'granola' }),
    ).toEqual({ type: 'api_key', key: FAKE_GRANOLA_KEY })
    const key = await Effect.runPromise(accessTokenFor(connectionId))
    expect(Redacted.value(key)).toBe(FAKE_GRANOLA_KEY)
  })

  it('a second paste for the same account is the same row with the new key', async () => {
    const userId = await member()
    const first = valueOf(await connect(userId, FAKE_GRANOLA_KEY))
    const api = makeFakeGranolaApi({ accessToken: 'grn_rotated' })
    const again = valueOf(await connect(userId, 'grn_rotated', api))
    expect(again.connectionId).toBe(first.connectionId)
    expect(
      Redacted.value(
        await Effect.runPromise(accessTokenFor(first.connectionId)),
      ),
    ).toBe('grn_rotated')
  })

  it('a key Granola refuses writes nothing', async () => {
    const userId = await member()
    const exit = await connect(userId, 'grn_wrong')
    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      await db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(eq(accountConnection.userId, userId)),
    ).toEqual([])
  })
})

describe("the member's folders", () => {
  it('are listed from Granola with their key, and two ticks land in settings', async () => {
    const userId = await member()
    const api = makeFakeGranolaApi()
    const { connectionId } = valueOf(
      await connect(userId, FAKE_GRANOLA_KEY, api),
    )
    const before = valueOf(
      await Effect.runPromiseExit(
        recorderAccountProgram(userId, connectionId, { fetch: api.fetch }),
      ),
    )
    expect(before.folders).toEqual([
      { id: 'fld_deals', name: 'Deals', ticked: false },
      { id: 'fld_portfolio', name: 'Portfolio', ticked: false },
      { id: 'fld_personal', name: 'Personal', ticked: false },
    ])
    expect(before.settings).toEqual({
      folderIds: [],
      typedNotes: false,
      transcript: false,
    })
    valueOf(
      await Effect.runPromiseExit(
        saveRecorderSettingsProgram(userId, connectionId, {
          folderIds: ['fld_deals', 'fld_portfolio'],
          typedNotes: false,
          transcript: false,
        }),
      ),
    )
    const stored = (
      await db
        .select({ settings: accountConnection.settings })
        .from(accountConnection)
        .where(eq(accountConnection.id, connectionId))
    ).at(0)?.settings
    expect(stored).toEqual({
      folder_ids: ['fld_deals', 'fld_portfolio'],
      typed_notes: false,
      transcript: false,
    })
    const after = valueOf(
      await Effect.runPromiseExit(
        recorderAccountProgram(userId, connectionId, { fetch: api.fetch }),
      ),
    )
    expect(after.folders?.filter((f) => f.ticked).map((f) => f.name)).toEqual([
      'Deals',
      'Portfolio',
    ])
  })

  it("are another member's to read and tick, never this one's", async () => {
    const owner = await member()
    const { connectionId } = valueOf(await connect(owner, FAKE_GRANOLA_KEY))
    const exit = await Effect.runPromiseExit(
      saveRecorderSettingsProgram(FIXTURE_ACTOR.id, connectionId, {
        folderIds: ['fld_personal'],
        typedNotes: true,
        transcript: true,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('say why when Granola cannot list them', async () => {
    const userId = await member()
    const api = makeFakeGranolaApi()
    const { connectionId } = valueOf(
      await connect(userId, FAKE_GRANOLA_KEY, api),
    )
    api.revoke()
    const account = valueOf(
      await Effect.runPromiseExit(
        recorderAccountProgram(userId, connectionId, { fetch: api.fetch }),
      ),
    )
    expect(account.folders).toBeNull()
    expect(account.foldersError).toBe('Granola refused the key')
  })
})

describe('Disconnect', () => {
  it('deletes the row, and no provider is asked', async () => {
    const userId = await member()
    const api = makeFakeGranolaApi()
    const { connectionId } = valueOf(
      await connect(userId, FAKE_GRANOLA_KEY, api),
    )
    const asked = api.requests.length
    expect(
      valueOf(
        await Effect.runPromiseExit(
          disconnectKeyedProgram(userId, connectionId),
        ),
      ),
    ).toEqual({ removed: 0 })
    expect(api.requests.length).toBe(asked)
    expect(
      await db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(eq(accountConnection.id, connectionId)),
    ).toEqual([])
  })
})
