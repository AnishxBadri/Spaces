import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import type { ConnectionListing } from '@spaces/core/writes/connections/list'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storeCredential } from '@spaces/core/writes/vault'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { connectionNoticesProgram, expiringOf, inviteOf } from './attention'

/**
 * Today's two connection lines that are not breakages: the invitation to
 * connect Google once it is set up, and a personal Gmail grant about to
 * lapse. The pure halves by table, then the program against the test
 * database.
 */

const NOW = Date.parse('2026-10-29T09:00:00.000Z')
const HOUR = 3_600_000

let n = 0
const listing = (over: Partial<ConnectionListing> = {}): ConnectionListing => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  provider: 'google',
  product: 'gmail',
  externalEmail: 'anish@gmail.com',
  scopes: [],
  status: 'active',
  errorReason: null,
  lastSyncAt: null,
  refreshTokenExpiresAt: null,
  createdAt: new Date(NOW - 6 * 24 * HOUR),
  ...over,
})

const ALL = ['gmail', 'google-calendar', 'google-drive', 'box']

describe('inviteOf — Bring in your email and meetings · Connect Google ›', () => {
  it('invites a reader with nothing connected once Google is set up, to the first use that is on', () => {
    expect(inviteOf([], ['google'], ALL)).toEqual({
      provider: 'google',
      label: 'Google',
      href: '/api/connections/google/start?product=gmail&return=%2Ftoday',
    })
    expect(inviteOf([], ['google'], ['google-calendar'])?.href).toBe(
      '/api/connections/google/start?product=calendar&return=%2Ftoday',
    )
  })

  it.each([
    ['Google is not set up', [], [], ALL],
    ['the reader already holds a Google account', [listing()], ['google'], ALL],
    [
      'an errored account is still held',
      [listing({ status: 'error' })],
      ['google'],
      ALL,
    ],
    ['every Google use is off', [], ['google'], ['box']],
  ] as const)('says nothing when %s', (_why, rows, configured, enabled) => {
    expect(inviteOf(rows, configured, enabled)).toBeNull()
  })

  it('still invites when the only Google account was revoked', () => {
    expect(
      inviteOf([listing({ status: 'revoked' })], ['google'], ALL),
    ).not.toBeNull()
  })
})

describe('expiringOf — Google expires in 2 days · Reconnect ›', () => {
  it('names a grant lapsing within 48h, in whole days, with the same account’s dance', () => {
    const soon = listing({
      refreshTokenExpiresAt: new Date(NOW + 30 * HOUR),
    })
    expect(expiringOf([soon], NOW)).toEqual([
      {
        connectionId: soon.id,
        label: 'Google',
        days: 2,
        href: '/api/connections/google/start?product=gmail&return=%2Ftoday&account=anish%40gmail.com',
      },
    ])
    expect(
      expiringOf(
        [listing({ refreshTokenExpiresAt: new Date(NOW + 3 * HOUR) })],
        NOW,
      ).map((e) => e.days),
    ).toEqual([1])
  })

  it('says one line per account, the soonest product first', () => {
    const mail = listing({ refreshTokenExpiresAt: new Date(NOW + 40 * HOUR) })
    const calendar = listing({
      product: 'calendar',
      refreshTokenExpiresAt: new Date(NOW + 20 * HOUR),
    })
    const other = listing({
      externalEmail: 'ines@gmail.com',
      refreshTokenExpiresAt: new Date(NOW + 10 * HOUR),
    })
    expect(
      expiringOf([mail, calendar, other], NOW).map((e) => e.connectionId),
    ).toEqual([other.id, calendar.id])
  })

  it.each([
    ['no lapse time (a Workspace client)', listing()],
    [
      'a lapse beyond 48h',
      listing({ refreshTokenExpiresAt: new Date(NOW + 49 * HOUR) }),
    ],
    [
      'a lapse already past',
      listing({ refreshTokenExpiresAt: new Date(NOW - HOUR) }),
    ],
    [
      'an account already in error, which the broken line names',
      listing({
        status: 'error',
        refreshTokenExpiresAt: new Date(NOW + HOUR),
      }),
    ],
  ])('says nothing for %s', (_why, row) => {
    expect(expiringOf([row], NOW)).toEqual([])
  })
})

describe('connectionNoticesProgram', () => {
  it('reads the client, the switched-on uses and the reader’s own grants', async () => {
    const read = () =>
      Effect.runPromise(connectionNoticesProgram(FIXTURE_ACTOR.id))
    await db.insert(integration).values([
      { capabilityId: 'gmail', version: '0.1.0', enabled: true },
      { capabilityId: 'google-calendar', version: '0.1.0', enabled: true },
    ])

    // No client yet: nothing to connect to.
    expect(await read()).toEqual({ invite: null, expiring: [] })

    await storeCredential({
      scope: 'workspace',
      provider: 'google',
      kind: 'oauth_client',
      secret: 'GOCSPX-client-secret',
      meta: { clientId: 'client.apps.googleusercontent.com' },
      createdBy: FIXTURE_ACTOR.id,
    })
    expect((await read()).invite?.href).toBe(
      '/api/connections/google/start?product=gmail&return=%2Ftoday',
    )

    await db.insert(accountConnection).values({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'gmail',
      externalEmail: 'anish@gmail.com',
      tokensEnc: encryptBundle(
        { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
        { userId: FIXTURE_ACTOR.id, provider: 'google' },
      ),
      scopes: ['openid', 'email', 'gmail.readonly'],
      refreshTokenExpiresAt: new Date(Date.now() + 36 * HOUR),
    })
    const after = await read()
    expect(after.invite).toBeNull()
    expect(after.expiring.map((e) => [e.label, e.days])).toEqual([
      ['Google', 2],
    ])
  })
})
