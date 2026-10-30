import { describe, expect, it } from 'vitest'
import type { ConnectionListRow } from './input'
import {
  accountOf,
  accountsFor,
  defaultMailAccount,
  offerFor,
  providersFor,
  syncStateOf,
  mailRowOf,
  wordsOf,
} from './accounts'

/** The accounts pages' grouping: product rows in, accounts by job out. */

let n = 0
const row = (over: Partial<ConnectionListRow> = {}): ConnectionListRow => ({
  connectionId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  provider: 'google',
  product: 'gmail',
  externalEmail: 'anish@fund.example',
  scopes: [],
  status: 'active',
  errorReason: null,
  lastSyncAt: null,
  connectedAt: '2026-10-01T09:00:00.000Z',
  refreshExpiresAt: null,
  ...over,
})

describe('accountsFor', () => {
  it('shows a Google account with Mail and Calendar once on Email & calendar, and its Drive on Files', () => {
    const rows = [
      row({ product: 'drive' }),
      row({ product: 'calendar' }),
      row({ product: 'gmail' }),
    ]
    const mail = accountsFor('email-calendar', rows)
    expect(mail).toHaveLength(1)
    expect(mail[0].email).toBe('anish@fund.example')
    expect(wordsOf(mail[0].held)).toBe('Mail · Calendar')
    expect(mail[0].rows).toHaveLength(3)

    const files = accountsFor('files', rows)
    expect(files).toHaveLength(1)
    expect(files[0].email).toBe('anish@fund.example')
    expect(wordsOf(files[0].held)).toBe('Drive')
  })

  it('keeps two addresses apart, earliest connected first, and providers mixed', () => {
    const rows = [
      row({
        externalEmail: 'deals@fund.example',
        connectedAt: '2026-10-05T00:00:00.000Z',
        product: 'drive',
      }),
      row({ product: 'drive', connectedAt: '2026-10-02T00:00:00.000Z' }),
      row({
        provider: 'box',
        product: 'box',
        externalEmail: 'anish@fund.example',
        connectedAt: '2026-10-03T00:00:00.000Z',
      }),
    ]
    expect(
      accountsFor('files', rows).map((a) => `${a.provider}:${a.email}`),
    ).toEqual([
      'google:anish@fund.example',
      'box:anish@fund.example',
      'google:deals@fund.example',
    ])
    expect(accountsFor('email-calendar', rows)).toEqual([])
  })

  it('sees the whole account from one of its rows', () => {
    const drive = row({ product: 'drive' })
    const rows = [
      drive,
      row({ product: 'gmail' }),
      row({ product: 'calendar' }),
    ]
    const account = accountOf(drive, 'files', rows)
    expect(account.rows.map((r) => r.product)).toEqual([
      'gmail',
      'calendar',
      'drive',
    ])
    expect(account.held.map((r) => r.product)).toEqual(['drive'])
  })
})

describe('defaultMailAccount', () => {
  it('is the earliest-connected live mail account', () => {
    const rows = [
      row({
        externalEmail: 'late@fund.example',
        connectedAt: '2026-10-04T00:00:00.000Z',
      }),
      row({
        externalEmail: 'gone@fund.example',
        connectedAt: '2026-09-01T00:00:00.000Z',
        status: 'revoked',
      }),
      row({
        externalEmail: 'first@fund.example',
        connectedAt: '2026-10-02T00:00:00.000Z',
      }),
      row({
        product: 'calendar',
        externalEmail: 'cal@fund.example',
        connectedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]
    expect(defaultMailAccount(rows)).toEqual({
      provider: 'google',
      email: 'first@fund.example',
    })
    expect(defaultMailAccount([row({ product: 'calendar' })])).toBeNull()
  })
})

describe('syncStateOf', () => {
  const TODAY = '2026-10-26'
  it('reads an error first, then revoked, then the latest sync', () => {
    expect(
      syncStateOf(
        [
          row({ lastSyncAt: '2026-10-09T08:00:00.000Z' }),
          row({ status: 'error', errorReason: 'invalid_grant' }),
        ],
        TODAY,
      ),
    ).toEqual({ tone: 'error', text: 'invalid_grant' })
    expect(syncStateOf([row({ status: 'revoked' })], TODAY)).toEqual({
      tone: 'revoked',
      text: 'Revoked',
    })
    expect(
      syncStateOf(
        [
          row({ lastSyncAt: '2026-10-02T08:00:00.000Z' }),
          row({ lastSyncAt: '2026-10-09T08:00:00.000Z' }),
        ],
        TODAY,
      ),
    ).toEqual({ tone: 'ok', text: 'In sync · 9 Oct' })
    expect(syncStateOf([row()], TODAY)).toEqual({
      tone: 'ok',
      text: 'Never synced',
    })
  })
})

describe('offerFor', () => {
  const none = { configured: [], installed: [], enabled: [] }
  const google = ['google' as const]
  const all = ['gmail', 'google-calendar', 'google-drive', 'box']

  /** Every reader, every state a provider and its use can be in, and the one offer. */
  it.each([
    // provider set up, use on → Connect, for admin and member alike
    [
      'set up, on',
      google,
      all,
      all,
      true,
      { kind: 'connect', product: 'gmail' },
    ],
    [
      'set up, on',
      google,
      all,
      all,
      false,
      { kind: 'connect', product: 'gmail' },
    ],
    // set up, but the workspace switched the use off → the provider's page
    ['set up, off', google, all, [], true, { kind: 'configure' }],
    ['set up, off', google, all, [], false, { kind: 'ask' }],
    // installed and on, but the provider has no client yet
    ['not set up', [], all, all, true, { kind: 'configure' }],
    ['not set up', [], all, all, false, { kind: 'ask' }],
    // the image shipped no plugin for it
    ['not shipped', google, [], [], true, { kind: 'unavailable' }],
    ['not shipped', google, [], [], false, { kind: 'unavailable' }],
  ] as const)(
    '%s, admin %s → %j',
    (_state, configured, installed, enabled, isAdmin, offer) => {
      expect(
        offerFor(
          'google',
          ['gmail', 'calendar'],
          {
            configured: [...configured],
            installed: [...installed],
            enabled: [...enabled],
          },
          isAdmin,
        ),
      ).toEqual(offer)
    },
  )

  it('offers the first product that is on, keyed by its plugin id', () => {
    expect(
      offerFor(
        'google',
        ['gmail', 'calendar'],
        {
          ...none,
          configured: google,
          installed: all,
          enabled: ['google-calendar'],
        },
        false,
      ),
    ).toEqual({ kind: 'connect', product: 'calendar' })
  })
})

describe('providersFor', () => {
  it('lists the providers with a product of the job, and no Microsoft while the registry has none', () => {
    expect(providersFor('email-calendar')).toEqual([
      { provider: 'google', products: ['gmail', 'calendar'] },
    ])
    expect(providersFor('files')).toEqual([
      { provider: 'google', products: ['drive'] },
      { provider: 'box', products: ['box'] },
    ])
    expect(providersFor('meeting-notes')).toEqual([])
  })
})

describe('mailRowOf', () => {
  it('finds the account’s mail row, where a mail sync’s settings hang', () => {
    const mail = row()
    const account = accountOf(mail, 'email-calendar', [mail])
    expect(mailRowOf(account)).toBe(mail)
    const drive = row({ product: 'drive' })
    expect(mailRowOf(accountOf(drive, 'files', [drive]))).toBeNull()
  })
})
