import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  FailingBinding,
  ParkedSource,
  WaitingExport,
} from '#/lib/server-fns'
import { NoticesBand } from './notices'

/**
 * The notices band's auto-enrich line: one per source at its daily cap, with
 * the records waiting and when they resume; the write-through line, one per
 * provider with uploads not yet in their bound folder; and one line per bound
 * folder that cannot sync.
 */

async function render(
  parked: ReadonlyArray<ParkedSource>,
  waiting: ReadonlyArray<WaitingExport> = [],
  failing: ReadonlyArray<FailingBinding> = [],
) {
  const root = createRootRoute({
    component: () => (
      <NoticesBand
        stopped={[]}
        broken={[]}
        parked={parked}
        waiting={waiting}
        failing={failing}
      />
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
    expect(html).toContain('Files ›')
  })

  it('says one file in the singular', async () => {
    const html = await render(
      [],
      [{ provider: 'box', label: 'Box', count: 1, fixTo: '/settings/files' }],
    )
    expect(html).toContain('1 file waiting for a Box connection')
  })
})

describe('NoticesBand — bound folders that cannot sync', () => {
  const FAILING: FailingBinding = {
    bindingId: '00000000-0000-4000-8000-0000000000b1',
    title: 'Vayu — Legal',
    error: 'Google said: File not found',
    fixConnectionId: '00000000-0000-4000-8000-0000000000c1',
  }

  it('reads the record and folder, the provider’s words, and Fix to the account page', async () => {
    const html = await render([], [], [FAILING])
    expect(html).toContain('Vayu — Legal can’t sync')
    expect(html).toContain('Google said: File not found')
    expect(html).toContain(
      'href="/settings/files/00000000-0000-4000-8000-0000000000c1"',
    )
    expect(html).toContain('Fix ›')
  })

  it('sends a reader with no account of that provider to Files', async () => {
    const html = await render([], [], [{ ...FAILING, fixConnectionId: null }])
    expect(html).toContain('href="/settings/files"')
  })

  it('one line per failing binding, and none once they are resolved', async () => {
    const two = await render(
      [],
      [],
      [FAILING, { ...FAILING, bindingId: 'b2', title: 'Ohmium — Data room' }],
    )
    expect(two.match(/can’t sync/g)).toHaveLength(2)
    expect(await render([], [], [])).not.toContain('Notices')
  })
})
