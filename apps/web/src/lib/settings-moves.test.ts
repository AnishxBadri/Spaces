import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'

import { Route as AiRoute } from '#/routes/_app/settings/ai'
import { Route as ArrivalRoute } from '#/routes/_app/settings/arrival'
import { Route as EmbeddingsRoute } from '#/routes/_app/settings/embeddings'
import { Route as IntegrationRoute } from '#/routes/_app/settings/integrations_.$integrationId'
import { Route as IntegrationsRoute } from '#/routes/_app/settings/integrations'
import { Route as PluginRoute } from '#/routes/_app/settings/plugins_.$integrationId'
import { Route as WorkspaceRoute } from '#/routes/_app/settings/workspace'
import { Route as ConnectionAppsRoute } from '#/routes/_app/settings/connection-apps'
import {
  toConnections,
  toEmailForwarding,
  toGeneral,
  toModels,
  toPlugin,
  toPlugins,
  loadPluginPage,
  toProviderIfBundled,
  toSearch,
} from './settings-moves'

// The plugin page's loader reads one row; the row is all it needs.
const pluginRow = { pluginId: 'apollo' }
vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIntegration: async () => pluginRow,
}))

const thrownBy = (run: () => unknown) => {
  try {
    run()
  } catch (e) {
    return e
  }
  throw new Error('did not throw')
}

const search = { from: 'bookmark' }

/** Each old path: its route's `beforeLoad`, and where that lands. */
const MOVES = [
  ['/settings/workspace', WorkspaceRoute, toGeneral, '/settings/general'],
  ['/settings/ai', AiRoute, toModels, '/settings/models'],
  ['/settings/embeddings', EmbeddingsRoute, toSearch, '/settings/search'],
  [
    '/settings/arrival',
    ArrivalRoute,
    toEmailForwarding,
    '/settings/email-forwarding',
  ],
  ['/settings/integrations', IntegrationsRoute, toPlugins, '/settings/plugins'],
  [
    '/settings/connection-apps',
    ConnectionAppsRoute,
    toConnections,
    '/settings/connections',
  ],
] as const

describe('the settings paths that moved', () => {
  for (const [from, route, move, to] of MOVES) {
    it(`${from} answers one 301 to ${to}, query intact`, () => {
      expect(route.options.beforeLoad).toBe(move)
      const thrown = thrownBy(() => move({ search }))
      if (!isRedirect(thrown)) throw new Error(`${from} did not redirect`)
      expect(thrown.status).toBe(301)
      expect(thrown.options).toMatchObject({
        to,
        search,
        statusCode: 301,
        replace: true,
      })
    })
  }

  it('/settings/integrations/$id answers one 301 to that plugin’s page', () => {
    expect(IntegrationRoute.options.beforeLoad).toBe(toPlugin)
    const thrown = thrownBy(() =>
      toPlugin({ params: { integrationId: 'row-1' }, search }),
    )
    if (!isRedirect(thrown)) throw new Error('toPlugin did not redirect')
    expect(thrown.status).toBe(301)
    expect(thrown.options).toMatchObject({
      to: '/settings/plugins/$integrationId',
      params: { integrationId: 'row-1' },
      search,
      replace: true,
    })
  })
})

/** A section route's source, read as text. */
const source = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../routes/_app/settings/${name}.tsx`, import.meta.url),
    ),
    'utf8',
  )

describe('a bundled plugin has no plugin page', () => {
  it.each([
    ['gmail', 'google'],
    ['google-calendar', 'google'],
    ['google-drive', 'google'],
    ['box', 'box'],
  ])(
    '/settings/plugins/%s answers one 301 to %s’s In use tab',
    (plugin, provider) => {
      expect(PluginRoute.options.beforeLoad).toBe(toProviderIfBundled)
      const thrown = thrownBy(() =>
        toProviderIfBundled({ params: { integrationId: plugin } }),
      )
      if (!isRedirect(thrown)) throw new Error(`${plugin} did not redirect`)
      expect(thrown.status).toBe(301)
      expect(thrown.options).toMatchObject({
        to: '/settings/connections/$provider',
        params: { provider },
        search: { tab: 'in-use' },
        replace: true,
      })
    },
  )

  it('lets a row id and any other plugin through to the page', async () => {
    expect(
      toProviderIfBundled({
        params: { integrationId: '6f1d3c1e-8a63-4c55-9d3e-1b2a3c4d5e6f' },
      }),
    ).toBeUndefined()
    expect(
      toProviderIfBundled({ params: { integrationId: 'apollo' } }),
    ).toBeUndefined()
    pluginRow.pluginId = 'apollo'
    expect(await loadPluginPage('row-1')).toEqual({ detail: pluginRow })
  })

  it('sends a row the loader reads as bundled to its provider', async () => {
    pluginRow.pluginId = 'google-drive'
    const thrown = await loadPluginPage('row-1').catch((e: unknown) => e)
    if (!isRedirect(thrown)) throw new Error('the loader did not redirect')
    expect(thrown.options).toMatchObject({
      to: '/settings/connections/$provider',
      params: { provider: 'google' },
      search: { tab: 'in-use' },
    })
  })
})

describe('the blocks that moved between sections', () => {
  it('Base currency left Currency & FX for General', () => {
    expect(source('general')).toContain('label="Base currency"')
    expect(source('general')).toContain('setBaseCurrency')
    expect(source('currency')).not.toContain('Base currency"')
    expect(source('currency')).not.toContain('setBaseCurrency')
    expect(source('currency')).toContain('title="Rates"')
  })

  it('Models holds Providers and Who does what; Limits moved to Usage & limits', () => {
    expect(source('models')).toContain('title="Providers"')
    expect(source('models')).toContain('title="Who does what"')
    expect(source('models')).not.toMatch(/LimitsGroup|setAiCaps|getAiCaps/)
    expect(source('usage')).toContain('<LimitsGroup')
    expect(source('usage')).toContain('title="Usage & limits"')
  })

  it('Connections holds the OAuth clients; the accounts pages never load them', () => {
    expect(source('connections_.$provider')).toContain('getProviderPage')
    for (const page of ['email-calendar', 'files', 'meeting-notes'])
      expect(source(page)).not.toMatch(/getProviderPage|getConnections/)
  })
})
