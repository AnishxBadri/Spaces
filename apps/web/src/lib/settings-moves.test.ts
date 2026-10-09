import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route as AiRoute } from '#/routes/_app/settings/ai'
import { Route as ArrivalRoute } from '#/routes/_app/settings/arrival'
import { Route as EmbeddingsRoute } from '#/routes/_app/settings/embeddings'
import { Route as IntegrationRoute } from '#/routes/_app/settings/integrations_.$integrationId'
import { Route as IntegrationsRoute } from '#/routes/_app/settings/integrations'
import { Route as WorkspaceRoute } from '#/routes/_app/settings/workspace'
import {
  toEmailForwarding,
  toGeneral,
  toModels,
  toPlugin,
  toPlugins,
  toSearch,
} from './settings-moves'

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

describe('the blocks that moved between sections', () => {
  it('Base currency left Currency & FX for General', () => {
    expect(source('general')).toContain('label="Base currency"')
    expect(source('general')).toContain('setBaseCurrency')
    expect(source('currency')).not.toContain('Base currency"')
    expect(source('currency')).not.toContain('setBaseCurrency')
    expect(source('currency')).toContain('title="Rates"')
  })

  it('Models holds Providers and Routing; Caps moved to Usage & limits', () => {
    expect(source('models')).toContain('title="Providers"')
    expect(source('models')).toContain('title="Routing"')
    expect(source('models')).not.toMatch(/CapsSection|setAiCaps|getAiCaps/)
    expect(source('usage')).toContain('<CapsSection')
    expect(source('usage')).toContain('title="Usage & limits"')
  })

  it('Connection apps holds the OAuth clients; Connections no longer loads them', () => {
    expect(source('connection-apps')).toContain('getProviderApps')
    expect(source('connections')).not.toContain('getProviderApps')
  })
})
