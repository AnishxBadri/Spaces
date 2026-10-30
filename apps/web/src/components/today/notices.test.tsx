import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  BrokenConnection,
  ConnectInvite,
  ExpiringConnection,
  FailingBinding,
  ParkedSource,
  StoppedPlugin,
  WaitingExport,
} from '#/lib/server-fns'
import { NoticesBand } from './notices'

/**
 * The notices band: bone, one 34px line per thing that stops the machine —
 * an amber or rose square, the sentence, and a sentence-case fix link in
 * mono ink. The auto-enrich line, one per source at its daily cap; the
 * write-through line, one per provider with uploads not yet in their bound
 * folder; one line per bound folder that cannot sync; a broken connection;
 * a plugin that stopped.
 */

async function render(
  parked: ReadonlyArray<ParkedSource>,
  waiting: ReadonlyArray<WaitingExport> = [],
  failing: ReadonlyArray<FailingBinding> = [],
  stopped: ReadonlyArray<StoppedPlugin> = [],
  broken: ReadonlyArray<BrokenConnection> = [],
  invite: ConnectInvite | null = null,
  expiring: ReadonlyArray<ExpiringConnection> = [],
) {
  const root = createRootRoute({
    component: () => (
      <NoticesBand
        stopped={stopped}
        broken={broken}
        parked={parked}
        waiting={waiting}
        failing={failing}
        invite={invite}
        expiring={expiring}
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
  it('reads paused, the source, the count and the UTC reset, with Enrichment', async () => {
    const html = await render([
      {
        integrationId: '00000000-0000-4000-8000-0000000000a1',
        source: 'Apollo',
        waiting: 14,
        resumesAt: '2026-10-11T00:00:00.000Z',
      },
    ])
    expect(html).toContain(
      'Auto-enrich paused · Apollo limit reached · 14 waiting · runs at 00:00 UTC',
    )
    expect(html).toContain('href="/settings/enrichment"')
    expect(html).toContain('>Enrichment ›<')
    expect(html).toContain('data-notice="warn"')
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

describe('NoticesBand — the line', () => {
  const BROKEN: BrokenConnection = {
    connectionId: '00000000-0000-4000-8000-0000000000d1',
    label: 'Gmail',
    externalEmail: 'anish@fund.example',
    errorReason: 'Google said: token expired',
    provider: 'google',
  }
  const TRIPPED: StoppedPlugin = {
    integrationId: '00000000-0000-4000-8000-0000000000e1',
    pluginId: 'apollo',
    state: 'tripped',
    lastError: null,
  }

  it('says a broken connection in one sentence, rose, with Reconnect to the provider’s page', async () => {
    const html = await render([], [], [], [], [BROKEN])
    expect(html).toContain('Gmail stopped syncing · Google said: token expired')
    expect(html).toContain('data-notice="bad"')
    expect(html).toContain('>Reconnect ›<')
    expect(html).toContain('href="/settings/connections/google"')
  })

  it('invites a member with nothing connected to connect Google, amber', async () => {
    const html = await render([], [], [], [], [], {
      provider: 'google',
      label: 'Google',
      href: '/api/connections/google/start?product=gmail&return=%2Ftoday',
    })
    expect(html).toContain('Bring in your email and meetings')
    expect(html).toContain('data-notice="warn"')
    expect(html).toContain('>Connect Google ›<')
    expect(html).toContain(
      'href="/api/connections/google/start?product=gmail&amp;return=%2Ftoday"',
    )
  })

  it('warns of a grant about to lapse, with Reconnect to the same account', async () => {
    const html = await render([], [], [], [], [], null, [
      {
        connectionId: '00000000-0000-4000-8000-0000000000d2',
        label: 'Google',
        days: 2,
        href: '/api/connections/google/start?product=gmail&return=%2Ftoday&account=anish%40gmail.com',
      },
    ])
    expect(html).toContain(
      'Google expires in 2 days · personal Gmail reconnects weekly',
    )
    expect(html).toContain('data-notice="warn"')
    expect(html).toContain('>Reconnect ›<')
    expect(html).toContain('account=anish%40gmail.com')
  })

  it('names a stopped plugin in sentence case, rose, with Fix', async () => {
    const html = await render([], [], [], [TRIPPED])
    expect(html).toContain('Plugin apollo stopped · stopped by the breaker')
    expect(html).toContain('data-notice="bad"')
    expect(html).toContain('>Fix ›<')
  })

  it('draws a square on bone, never a lowercase lane or a pine link', async () => {
    const html = await render(
      [
        {
          integrationId: 'i1',
          source: 'Apollo',
          waiting: 1,
          resumesAt: '2026-10-11T00:00:00.000Z',
        },
      ],
      [],
      [],
      [TRIPPED],
      [BROKEN],
    )
    expect(html).toContain('bg-bone')
    expect(html.match(/size-1\.5/g)).toHaveLength(3)
    expect(html).not.toContain('text-primary')
    expect(html).not.toMatch(/>(account|plugin|enrich|files)</)
    // Every fix link starts uppercase.
    const links = [...html.matchAll(/<a [^>]*>([^<]*)</g)].map((m) => m[1])
    expect(links).toEqual(['Reconnect ›', 'Enrichment ›', 'Fix ›'])
  })
})
