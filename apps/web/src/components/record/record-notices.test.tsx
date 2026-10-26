import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RecordNotices } from './record-notices'

/**
 * The band under a record head's double rule: a line per possible duplicate
 * and one for a parked enrichment, each with the link that settles it, and
 * nothing at all when neither is there.
 */

const ID = 'f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa'

async function render(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('RecordNotices', () => {
  it('draws the duplicate and the parked lines from the reads', async () => {
    const html = await render(
      <RecordNotices
        recordId={ID}
        duplicates={[
          {
            pairId: 'p1',
            otherId: 'b',
            otherName: 'Flent Inc',
            key: 'flent.com',
          },
        ]}
        parked={{ source: 'Apollo', resumesAt: '2026-10-27T00:00:00.000Z' }}
      />,
    )
    expect(html).toContain('data-record-notices')
    expect(html).toContain('bg-bone')
    expect(html).toContain('data-notice="duplicate"')
    expect(html).toContain('Possibly the same as Flent Inc · flent.com on both')
    expect(html).toContain(`href="/review?record=${ID}&amp;lane=duplicates"`)
    expect(html).toContain('Compare ›')
    expect(html).toContain('data-notice="parked"')
    expect(html).toContain(
      'Enrich parked · Apollo limit reached · runs at 00:00 UTC',
    )
    expect(html).toContain('href="/settings/enrichment"')
    expect(html).toContain('Enrichment ›')
    expect(html.match(/size-1\.5 shrink-0 bg-warning/g)).toHaveLength(2)
  })

  it('renders nothing when nothing needs saying', () => {
    expect(renderToStaticMarkup(<RecordNotices recordId={ID} />)).toBe('')
    expect(
      renderToStaticMarkup(
        <RecordNotices recordId={ID} duplicates={[]} parked={null} />,
      ),
    ).toBe('')
  })
})
