import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { RecordAction } from '#/lib/server-fns'
import { EnrichAction, PluginActions } from './plugin-actions.tsx'
import type { EnrichSetupView } from './plugin-actions.tsx'

/**
 * The record head's plugin controls: one outline button per action the loader
 * handed it, labelled as the manifest declares, and nothing at all when no
 * runnable plugin declares one on this kind. (D63)
 */

const enrich: RecordAction = {
  integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
  pluginId: 'apollo',
  pluginName: 'Apollo',
  actionId: 'enrich-company',
  label: 'Enrich',
  queue: 'plugin.apollo.enrichCompany',
}

describe('PluginActions', () => {
  it('renders the declared action as a record-head button', () => {
    const html = renderToStaticMarkup(
      <PluginActions
        entityId="f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa"
        actions={[enrich]}
      />,
    )
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('>Enrich</button>')
    expect(html).toContain('data-variant="outline"')
    expect(html).toContain('title="Enrich with Apollo"')
  })

  it('renders nothing when no plugin offers an action', () => {
    expect(
      renderToStaticMarkup(
        <PluginActions
          entityId="f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa"
          actions={[]}
        />,
      ),
    ).toBe('')
  })
})

describe('EnrichAction', () => {
  const ENTITY = 'f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa'
  const admin = { isAdmin: true, admins: ['Anish'] }

  async function render(setup: EnrichSetupView) {
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => <EnrichAction entityId={ENTITY} setup={setup} />,
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()
    return renderToStaticMarkup(<RouterProvider router={router} />)
  }

  it('asks the Website and offers more sources in place when only it is on', async () => {
    const html = await render({ website: true, sources: 0, audience: admin })
    expect(html).toContain('>Enrich</button>')
    expect(html).toContain('Website · ')
    expect(html).toContain('href="/settings/plugins"')
    expect(html).toContain('More sources ›')

    const member = await render({
      website: true,
      sources: 0,
      audience: { isAdmin: false, admins: ['Anish'] },
    })
    expect(member).toContain('>Enrich</button>')
    expect(member).toContain('Ask Anish to set up more enrichment sources')
  })

  it('asks for a model when the Website cannot read', async () => {
    const html = await render({ website: false, sources: 0, audience: admin })
    expect(html).not.toContain('<button')
    expect(html).toContain('Enrich needs a model · ')
    expect(html).toContain('href="/settings/models"')
  })

  it('draws nothing when a plugin source carries its own action', async () => {
    expect(
      await render({ website: true, sources: 1, audience: admin }),
    ).not.toContain('Enrich')
  })
})
