import { describe, expect, it } from 'vitest'
import type { ConnectionListRow } from './input'
import {
  accountOf,
  accountsFor,
  defaultMailAccount,
  offerFor,
  providersFor,
  syncStateOf,
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
  it('reads an error first, then revoked, then the latest sync', () => {
    expect(
      syncStateOf([
        row({ lastSyncAt: '2026-10-09T08:00:00.000Z' }),
        row({ status: 'error', errorReason: 'invalid_grant' }),
      ]),
    ).toEqual({ tone: 'error', text: 'invalid_grant' })
    expect(syncStateOf([row({ status: 'revoked' })])).toEqual({
      tone: 'revoked',
      text: 'revoked',
    })
    expect(
      syncStateOf([
        row({ lastSyncAt: '2026-10-02T08:00:00.000Z' }),
        row({ lastSyncAt: '2026-10-09T08:00:00.000Z' }),
      ]),
    ).toEqual({ tone: 'ok', text: 'synced 10-09' })
    expect(syncStateOf([row()])).toEqual({ tone: 'ok', text: 'never synced' })
  })
})

describe('offerFor', () => {
  const none = { configured: [], installed: [], offered: [] }

  it('offers Connect for an installed plugin under a configured provider', () => {
    expect(
      offerFor(
        'google',
        ['gmail', 'calendar'],
        { ...none, configured: ['google'], installed: ['google-calendar'] },
        false,
      ),
    ).toEqual({ kind: 'connect', product: 'calendar' })
  })

  it('shows Install › to an admin and Ask an admin to a member when the registry has the plugin', () => {
    const view = {
      ...none,
      configured: ['google' as const],
      offered: ['gmail'],
    }
    expect(offerFor('google', ['gmail', 'calendar'], view, true)).toEqual({
      kind: 'install',
      plugin: 'gmail',
    })
    expect(offerFor('google', ['gmail', 'calendar'], view, false)).toEqual({
      kind: 'ask',
    })
  })

  it("keys the calendar on its plugin's registry id, google-calendar", () => {
    const view = { ...none, offered: ['google-calendar'] }
    expect(offerFor('google', ['gmail', 'calendar'], view, true)).toEqual({
      kind: 'install',
      plugin: 'google-calendar',
    })
  })

  it('reads Not available yet to everyone when no plugin exists to install', () => {
    expect(offerFor('google', ['gmail'], none, true)).toEqual({
      kind: 'unavailable',
    })
    expect(offerFor('google', ['gmail'], none, false)).toEqual({
      kind: 'unavailable',
    })
  })

  it('sends an admin to the OAuth client when the plugin is installed but the provider is not configured', () => {
    const view = { ...none, installed: ['google-drive'] }
    expect(offerFor('google', ['drive'], view, true)).toEqual({
      kind: 'configure',
    })
    expect(offerFor('google', ['drive'], view, false)).toEqual({ kind: 'ask' })
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
