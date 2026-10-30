import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConnectionsListRow, ProviderUse } from './input'
import { BUNDLED_PLUGINS, isBundledPlugin, providerOfPlugin } from './products'
import {
  consentFor,
  defaultTab,
  healthOf,
  listStatusOf,
  syncAge,
  whoLineOf,
} from './provider-view'

/** How Connections and a provider's page word what the server read. */

const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const TODAY = '2026-10-26'

const listRow = (
  over: Partial<ConnectionsListRow> = {},
): ConnectionsListRow => ({
  provider: 'google',
  label: 'Google',
  configured: true,
  membersConnected: 4,
  members: 6,
  testing: false,
  error: null,
  ...over,
})

const use = (over: Partial<ProviderUse> = {}): ProviderUse => ({
  product: 'gmail',
  label: 'Gmail',
  plugin: 'gmail',
  integrationId: 'row-1',
  enabled: true,
  people: 4,
  lastSyncAt: '2026-10-26T11:57:00.000Z',
  failed: 0,
  failedWho: null,
  ...over,
})

describe('the bundled plugins', () => {
  it('are one per product, derived from PRODUCTS, each with its provider', () => {
    expect([...BUNDLED_PLUGINS]).toEqual([
      'gmail',
      'google-calendar',
      'google-drive',
      'box',
    ])
    expect(providerOfPlugin('google-calendar')).toBe('google')
    expect(providerOfPlugin('box')).toBe('box')
    expect(providerOfPlugin('apollo')).toBeNull()
    expect(isBundledPlugin('granola')).toBe(false)
  })

  /** The image packs what boot installs; both lists are BUNDLED_PLUGINS. */
  it('are what the image packs and `pnpm bundle-plugins` packs', () => {
    const root = new URL('../../../../../', import.meta.url)
    const dockerfile = readFileSync(
      fileURLToPath(new URL('docker/Dockerfile', root)),
      'utf8',
    )
    const loop = /for p in ([a-z -]+); do/.exec(dockerfile)?.[1]
    expect(loop?.trim().split(/\s+/)).toEqual([...BUNDLED_PLUGINS])
    const built = [
      ...dockerfile.matchAll(/--filter @spaces\/plugin-([a-z-]+)/g),
    ].map((m) => m[1])
    expect(built).toEqual([...BUNDLED_PLUGINS])
    const script = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(
          readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'),
        ),
      ).scripts['bundle-plugins']
    // By path, never by package name: core bundles the root manifest into
    // web's build, which must carry no plugin package name.
    for (const id of BUNDLED_PLUGINS) {
      expect(script).toContain(`--filter=./plugins/${id}`)
      expect(script).toContain(`--filter ./plugins/${id}`)
    }
  })
})

describe('listStatusOf — a Connections row', () => {
  it.each([
    [
      'set up',
      listRow(),
      'graphite',
      'Set up · 4 of 6 members connected',
      'Open ›',
      'in-use',
    ],
    [
      'not set up',
      listRow({ configured: false, membersConnected: 0 }),
      'ink',
      'Not set up',
      'Set up ›',
      'setup',
    ],
    [
      'in Testing',
      listRow({ testing: true }),
      'graphite',
      'Testing · reconnects weekly',
      'Open ›',
      'in-use',
    ],
    [
      'refused by the provider',
      listRow({ testing: true, error: 'Google said: invalid_client' }),
      'bad',
      'Google said: invalid_client',
      'Fix ›',
      'setup',
    ],
  ] as const)('%s', (_state, row, tone, text, label, tab) => {
    expect(listStatusOf(row)).toEqual({ tone, text, link: { label, tab } })
  })
})

describe('a use on In use', () => {
  it('reads who uses it and when it last synced, or that it is off', () => {
    expect(whoLineOf(use(), NOW, TODAY)).toBe('4 people · last sync 3 min')
    expect(whoLineOf(use({ people: 1, lastSyncAt: null }), NOW, TODAY)).toBe(
      '1 person · never synced',
    )
    expect(whoLineOf(use({ enabled: false }), NOW, TODAY)).toBe(
      'Off for this workspace',
    )
  })

  it('reads its week as failed runs, naming whom it failed for', () => {
    expect(healthOf(use())).toEqual({ tone: 'ok', text: '0 failed · 7 days' })
    expect(healthOf(use({ failed: 1, failedWho: 'Ines' }))).toEqual({
      tone: 'bad',
      text: '1 failed · Ines',
    })
    expect(healthOf(use({ failed: 2 }))).toEqual({
      tone: 'bad',
      text: '2 failed · 7 days',
    })
  })

  it('ages a sync in minutes, hours, then the day', () => {
    expect(syncAge('2026-10-26T11:59:40.000Z', NOW, TODAY)).toBe('just now')
    expect(syncAge('2026-10-26T07:00:00.000Z', NOW, TODAY)).toBe('5 h')
    expect(syncAge('2026-10-20T07:00:00.000Z', NOW, TODAY)).toBe('20 Oct')
  })
})

describe('the provider page', () => {
  it('opens on In use once the client is active, Set up before', () => {
    expect(defaultTab(true)).toBe('in-use')
    expect(defaultTab(false)).toBe('setup')
  })

  it('preselects the consent screen from the audience', () => {
    expect(consentFor('workspace')).toBe('internal')
    expect(consentFor('personal')).toBe('external')
  })
})
