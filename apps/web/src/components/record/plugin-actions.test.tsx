import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { RecordAction } from '#/lib/server-fns'
import { PluginActions } from './plugin-actions.tsx'
import type { RecordEnrichView } from './plugin-actions.tsx'

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

/**
 * The host's Enrich (D76, D80): one button asking every source in order,
 * the line beside it naming them, then how the last run went.
 */
describe('the host Enrich', () => {
  const ENTITY = 'f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa'
  const admin = { isAdmin: true, admins: ['Anish'] }
  const view = (over: Partial<RecordEnrichView>): RecordEnrichView => ({
    sources: ['Website'],
    onlyFree: true,
    sensitive: false,
    last: null,
    whereFrom: {},
    audience: admin,
    kind: 'company',
    ...over,
  })

  async function render(
    enrichView: RecordEnrichView,
    actions: ReadonlyArray<RecordAction> = [],
  ) {
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => (
          <PluginActions
            entityId={ENTITY}
            actions={actions}
            enrich={enrichView}
          />
        ),
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()
    return renderToStaticMarkup(<RouterProvider router={router} />)
  }

  it('asks the Website and offers more sources in place when only it is on', async () => {
    const html = await render(view({}))
    expect(html).toContain('>Enrich</button>')
    expect(html).toContain('>Website</span>')
    expect(html).toContain('href="/settings/enrichment"')
    expect(html).toContain('More sources ›')

    const member = await render(
      view({ audience: { isAdmin: false, admins: ['Anish'] } }),
    )
    expect(member).toContain('>Enrich</button>')
    expect(member).toContain('Ask Anish to set up more enrichment sources')
  })

  it('asks for a model when a company has no source at all', async () => {
    const html = await render(view({ sources: [] }))
    expect(html).not.toContain('<button')
    expect(html).toContain('Enrich needs a model · ')
    expect(html).toContain('href="/settings/models"')
  })

  it('draws one Enrich naming every source in order, in place of a source’s own', async () => {
    const html = await render(
      view({ sources: ['Website', 'Apollo'], onlyFree: false }),
      [enrich],
    )
    expect(html.match(/>Enrich<\/button>/g)).toHaveLength(1)
    expect(html).toContain('Website, then Apollo')
    expect(html).not.toContain('More sources')
  })

  it('shows how the last run went: counts with Review, a limit with its reset, sensitive', async () => {
    const done = await render(
      view({
        sources: ['Website', 'Apollo'],
        onlyFree: false,
        last: { words: '6 fields · 1 to Review', tone: 'done', review: true },
      }),
    )
    expect(done).toContain('6 fields · 1 to Review')
    expect(done).toContain('data-enrich-line="done"')
    expect(done).toContain('href="/review"')

    const capped = await render(
      view({
        onlyFree: false,
        last: {
          words: 'Apollo limit reached · runs at 00:00 UTC',
          tone: 'warn',
          review: false,
        },
      }),
    )
    expect(capped).toContain('Apollo limit reached · runs at 00:00 UTC')

    const sensitive = await render(view({ sensitive: true }))
    expect(sensitive).toContain('sensitive · Website only')
  })
})
