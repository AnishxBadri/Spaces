import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ParkedSource, WaitingExport } from '#/lib/server-fns'
import { NoticesBand } from './notices'

/**
 * The notices band's auto-enrich line: one per source at its daily cap, with
 * the records waiting and when they resume; and the write-through line, one
 * per provider with uploads not yet in their bound folder. (D76, D79, §6)
 */

async function render(
  parked: ReadonlyArray<ParkedSource>,
  waiting: ReadonlyArray<WaitingExport> = [],
) {
  const root = createRootRoute({
    component: () => (
      <NoticesBand stopped={[]} broken={[]} parked={parked} waiting={waiting} />
    ),
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('NoticesBand — parked auto-enrich', () => {
  it('reads paused, the source, the count and the reset', async () => {
    const html = await render([
      {
        integrationId: '00000000-0000-4000-8000-0000000000a1',
        source: 'Apollo',
        waiting: 14,
        resumesAt: '2026-10-11T00:00:00.000Z',
      },
    ])
    expect(html).toContain('Auto-enrich paused · Apollo cap reached')
    expect(html).toContain('14 waiting · resumes 00:00 UTC')
    expect(html).toContain(
      'href="/settings/plugins/00000000-0000-4000-8000-0000000000a1"',
    )
  })

  it('renders nothing when nothing is parked or stopped', async () => {
    expect(await render([])).not.toContain('Notices')
  })
})

describe('NoticesBand — uploads waiting to write through', () => {
  it('reads the count and the provider, and links to the files connections', async () => {
    const html = await render(
      [],
      [
        {
          provider: 'google',
          label: 'Drive',
          count: 3,
          fixTo: '/settings/files',
        },
      ],
    )
    expect(html).toContain('3 files waiting for a Drive connection')
    expect(html).toContain('href="/settings/files"')
    expect(html).toContain('reconnect ›')
  })

  it('says one file in the singular', async () => {
    const html = await render(
      [],
      [{ provider: 'box', label: 'Box', count: 1, fixTo: '/settings/files' }],
    )
    expect(html).toContain('1 file waiting for a Box connection')
  })
})
