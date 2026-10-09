import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationDetail } from '#/lib/server-fns'
import { PLUGIN_BLOCKS, PluginTemplate } from './plugin-template'

/**
 * The plugin page's template, rendered the way the server renders it: every
 * plugin — an enrichment source with a key, a feed with no key, a plugin
 * the worker has not read — gets the same seven blocks in the same order;
 * what it switches on only links to the owning page; recent runs print the
 * provider's error text.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: ReactNode
    to: string
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

const apollo: IntegrationDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  pluginId: 'apollo',
  name: 'Apollo',
  version: '0.1.0',
  roles: ['enrichment'],
  enabled: true,
  state: 'enabled',
  reason: null,
  summary: null,
  lastRun: { ago: '4m ago', failed: false },
  credits: { used: 12, cap: 100 },
  figure: '12 / 100 credits',
  autoEnrich: 'deal',
  errorCount: 0,
  update: null,
  held: null,
  rollback: null,
  description: 'Fills blank company and person fields from Apollo.io.',
  fix: null,
  form: { ok: true, fields: [] },
  values: {},
  secrets: [{ slot: 'credential', label: 'Apollo key', display: '••••4f2a' }],
  webhookUrl: null,
  autoEnrichForm: null,
  sends: ['domain', 'email', 'LinkedIn URL'],
  capabilities: [{ what: 'Fills company fields', owner: 'enrichment' }],
  runs: [
    {
      id: 'r2',
      job: 'enrichCompany',
      status: 'failed',
      ago: '2m ago',
      duration: '1.2s',
      line: 'permanent: Apollo said 422: domain is not valid',
    },
    {
      id: 'r1',
      job: 'enrichCompany',
      status: 'succeeded',
      ago: '1h ago',
      duration: '340ms',
      line: '6 fields filled',
    },
  ],
}

const rss: IntegrationDetail = {
  ...apollo,
  id: '00000000-0000-4000-8000-000000000002',
  pluginId: 'rss',
  name: 'RSS',
  roles: ['feeds'],
  figure: '5 signals',
  secrets: [],
  sends: ['only the addresses its settings name'],
  capabilities: [{ what: 'Adds feed items as signals', owner: 'watching' }],
  runs: [],
}

const unread: IntegrationDetail = {
  ...rss,
  id: '00000000-0000-4000-8000-000000000003',
  pluginId: 'unread',
  name: 'unread',
  roles: [],
  state: 'starting',
  figure: '—',
  form: { ok: false, reason: 'not read yet' },
  sends: [],
  capabilities: [],
}

const render = (
  detail: IntegrationDetail,
  slots: { keyBlock?: ReactNode; settingsBlock?: ReactNode } = {},
) =>
  renderToStaticMarkup(
    <PluginTemplate
      detail={detail}
      keyBlock={slots.keyBlock ?? null}
      settingsBlock={slots.settingsBlock ?? null}
      pending={false}
      onToggle={() => undefined}
      onUninstall={() => undefined}
    />,
  )

const blocksOf = (html: string) =>
  [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1])

/** One block's markup, up to the next block. */
const block = (html: string, id: string): string => {
  const start = html.indexOf(`data-block="${id}"`)
  const next = html.indexOf('data-block="', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

describe('PluginTemplate', () => {
  it('renders the same seven blocks, in order, for every plugin', () => {
    expect(PLUGIN_BLOCKS).toHaveLength(7)
    for (const detail of [apollo, rss, unread])
      expect(blocksOf(render(detail))).toEqual([...PLUGIN_BLOCKS])
    expect(
      blocksOf(
        render(apollo, {
          keyBlock: <div>key rows</div>,
          settingsBlock: <div>settings form</div>,
        }),
      ),
    ).toEqual([...PLUGIN_BLOCKS])
  })

  it('reads status, version, the one number and what it sends', () => {
    const html = render(apollo)
    expect(block(html, 'status')).toContain('v0.1.0')
    expect(block(html, 'status')).toContain('ran 4m ago')
    expect(block(html, 'status')).toContain('12 / 100 credits')
    expect(block(html, 'sends')).toContain('domain · email · LinkedIn URL')
    expect(block(render(unread), 'sends')).toContain('Not read yet.')
  })

  it('holds the caller key and settings rows, or says there are none', () => {
    const html = render(apollo, {
      keyBlock: <div>key rows</div>,
      settingsBlock: <div>settings form</div>,
    })
    expect(block(html, 'key')).toContain('key rows')
    expect(block(html, 'key')).toContain('saved')
    expect(block(html, 'settings')).toContain('settings form')
    const plain = render(rss)
    expect(block(plain, 'key')).toContain('No workspace key.')
    expect(block(plain, 'settings')).toContain('No settings.')
  })

  it('links each capability to its owning page and holds no control of its own', () => {
    const on = block(render(apollo), 'switches-on')
    expect(on).toContain('Fills company fields')
    expect(on).toContain('href="/settings/plugins"')
    expect(on).toContain('Enrichment · coming ›')
    expect(on).not.toMatch(/<(input|button|select)/)
    expect(block(render(rss), 'switches-on')).toContain('href="/spaces"')
    expect(block(render(unread), 'switches-on')).toContain('Nothing elsewhere.')
  })

  it('lists recent runs newest first with the provider error text', () => {
    const runs = block(render(apollo), 'runs')
    expect(runs.indexOf('2m ago')).toBeLessThan(runs.indexOf('1h ago'))
    expect(runs).toContain('permanent: Apollo said 422: domain is not valid')
    expect(runs).toContain('data-run="failed"')
    expect(block(render(rss), 'runs')).toContain('No runs yet.')
  })

  it('ends with Disable, or Enable when off, and Uninstall', () => {
    expect(block(render(apollo), 'remove')).toContain('>Disable</button>')
    expect(block(render(apollo), 'remove')).toContain('>Uninstall…</button>')
    expect(
      block(render({ ...apollo, enabled: false, state: 'off' }), 'remove'),
    ).toContain('>Enable</button>')
  })
})
