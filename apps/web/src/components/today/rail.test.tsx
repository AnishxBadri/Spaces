import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TodayHeadlines } from '#/lib/server-fns'
import { WhatsMoving } from './rail'
import type { MovingState } from './rail'

/**
 * Today's What's moving card with the day's headlines line: first in the
 * card, opening Feeds, and absent at zero.
 */

const TODAY = '2026-11-16'

async function render(
  signals: MovingState,
  headlines: TodayHeadlines | null,
): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <WhatsMoving
          signals={signals}
          headlines={headlines}
          team={[]}
          today={TODAY}
          onRetry={() => {}}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

const signal = {
  id: 's1',
  companyId: '00000000-0000-4000-8000-000000000001',
  companyName: 'Exponent',
  kind: 'hire',
  title: 'Exponent hires a CFO',
  url: null,
  source: 'exa',
  observedAt: '2026-11-15T09:00:00.000Z',
}

describe("Today's headlines line", () => {
  it('leads the card: the count over the feeds, dated Today, opening Feeds', async () => {
    const html = await render([signal], {
      count: 14,
      feeds: [
        'SpaceNews',
        'Inc42',
        'TechCrunch',
        'Orbit Notes',
        'Rest of World',
      ],
    })
    const line = html.indexOf('data-headlines-line')
    expect(line).toBeGreaterThan(-1)
    expect(line).toBeLessThan(html.indexOf('Exponent hires a CFO'))
    expect(html).toContain('href="/feeds"')
    expect(html).toContain('14 new headlines')
    expect(html).toContain('Feeds · SpaceNews, Inc42 and 3 more')
    expect(html).toContain('>Today<')
  })

  it('is absent at zero and while unread', async () => {
    for (const headlines of [{ count: 0, feeds: [] }, null]) {
      const html = await render([signal], headlines)
      expect(html).not.toContain('data-headlines-line')
      expect(html).not.toContain('href="/feeds"')
    }
  })

  it('stands in for Nothing new. on a day with headlines and no signals', async () => {
    const html = await render([], { count: 1, feeds: ['SpaceNews'] })
    expect(html).toContain('1 new headline<')
    expect(html).toContain('Feeds · SpaceNews')
    expect(html).not.toContain('Nothing new.')
    expect(await render([], null)).toContain('Nothing new.')
  })
})
