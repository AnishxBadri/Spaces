import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationRow } from '#/lib/server-fns'
import { IntegrationLedger } from './integration-ledger'

/**
 * The Installed ledger, rendered the way the server renders it: degraded,
 * tripped and operator-off read as three different rows, a missing key reads
 * as not yet rather than as an error, and each state offers its own action.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => <a className={className}>{children}</a>,
}))

const base: IntegrationRow = {
  id: '00000000-0000-4000-8000-000000000001',
  pluginId: 'apollo',
  name: 'Apollo',
  version: '0.1.0',
  enabled: true,
  state: 'enabled',
  reason: null,
  summary: '6 fields filled on Ohmium',
  lastRun: { ago: '4m ago', failed: false },
  credits: { used: 12, cap: 100 },
  errorCount: 0,
  update: null,
}

const rows: Array<IntegrationRow> = [
  base,
  {
    ...base,
    id: '00000000-0000-4000-8000-000000000002',
    pluginId: 'old-sdk',
    name: 'old-sdk',
    state: 'degraded',
    reason: 'requires sdk ^2.0, host provides 1.1.0',
    lastRun: null,
    credits: { used: 0, cap: null },
  },
  {
    ...base,
    id: '00000000-0000-4000-8000-000000000003',
    pluginId: 'throws',
    name: 'throws',
    state: 'tripped',
    reason: '5 failures in an hour',
    errorCount: 5,
  },
  {
    ...base,
    id: '00000000-0000-4000-8000-000000000004',
    pluginId: 'echo',
    name: 'echo',
    enabled: false,
    state: 'off',
  },
  {
    ...base,
    id: '00000000-0000-4000-8000-000000000005',
    pluginId: 'apollo-eu',
    name: 'Apollo EU',
    state: 'needs-key',
    reason: 'missing credential',
  },
]

const render = () =>
  renderToStaticMarkup(
    <IntegrationLedger
      rows={rows}
      actions={{
        onToggle: () => undefined,
        onReset: () => undefined,
        onUpdate: () => undefined,
        pending: null,
      }}
    />,
  )

/** The `<li>` for one state, as markup. */
const rowFor = (html: string, state: string): string => {
  const match = new RegExp(`<li data-state="${state}"[^>]*>.*?</li>`).exec(html)
  if (!match) throw new Error(`no ${state} row`)
  return match[0]
}

describe('IntegrationLedger', () => {
  it('lists every row with version, last run, credits and state', () => {
    const html = render()
    expect(html).toContain('Installed')
    expect(html.match(/<li/g)).toHaveLength(5)
    const apollo = rowFor(html, 'enabled')
    expect(apollo).toContain('Apollo')
    expect(apollo).toContain('0.1.0')
    expect(apollo).toContain('6 fields filled on Ohmium')
    expect(apollo).toContain('12 / 100 cr')
    expect(apollo).toContain('ran 4m ago')
    expect(apollo).toContain('>enabled<')
    expect(apollo).toContain('Configure')
  })

  it('reads degraded, tripped and off as three different rows', () => {
    const html = render()
    const degraded = rowFor(html, 'degraded')
    const tripped = rowFor(html, 'tripped')
    const off = rowFor(html, 'off')

    // Degraded: amber, the loader's reason, Fix.
    expect(degraded).toContain('bg-[var(--badge-amber)]')
    expect(degraded).toContain('requires sdk ^2.0, host provides 1.1.0')
    expect(degraded).toContain('>degraded<')
    expect(degraded).toContain('>Fix<')
    expect(degraded).toContain('never ran')

    // Tripped: rose, the breaker's reason and count, Reset.
    expect(tripped).toContain('bg-[var(--badge-rose)]')
    expect(tripped).toContain('5 failures in an hour · 5 failed')
    expect(tripped).toContain('>tripped<')
    expect(tripped).toContain('>Reset</button>')

    // Off: no tint, the switch off, nothing wrong said.
    expect(off).not.toContain('badge-')
    expect(off).toContain('aria-checked="false"')
    expect(off).toContain('>off<')
    expect(off).not.toContain('text-destructive')

    for (const row of [degraded, tripped])
      expect(row).toContain('aria-checked="true"')
  })

  it('reads a missing key as not yet, not as an error', () => {
    const needsKey = rowFor(render(), 'needs-key')
    expect(needsKey).toContain('No key yet')
    expect(needsKey).toContain('>not yet<')
    expect(needsKey).toContain('Add key')
    expect(needsKey).not.toContain('badge-')
    expect(needsKey).not.toContain('text-destructive')
    expect(needsKey).not.toContain('missing credential')
  })

  it('reads a required setting with no value as not yet, with Set up', () => {
    const html = renderToStaticMarkup(
      <IntegrationLedger
        rows={[
          {
            ...base,
            pluginId: 'rss',
            name: 'RSS',
            state: 'needs-setup',
            reason: 'missing settings',
            lastRun: null,
            credits: { used: 0, cap: null },
          },
        ]}
        actions={{
          onToggle: () => undefined,
          onReset: () => undefined,
          onUpdate: () => undefined,
          pending: null,
        }}
      />,
    )
    const needsSetup = rowFor(html, 'needs-setup')
    expect(needsSetup).toContain('Not set up yet')
    expect(needsSetup).toContain('>not yet<')
    expect(needsSetup).toContain('>Set up<')
    expect(needsSetup).not.toContain('badge-')
    expect(needsSetup).not.toContain('text-destructive')
    expect(needsSetup).not.toContain('missing settings')
    expect(needsSetup).not.toContain('>Fix<')
  })

  it('shows a newer registry version and offers Update on a running row', () => {
    const html = renderToStaticMarkup(
      <IntegrationLedger
        rows={[{ ...base, update: '0.2.0' }]}
        actions={{
          onToggle: () => undefined,
          onReset: () => undefined,
          onUpdate: () => undefined,
          pending: null,
        }}
      />,
    )
    const row = rowFor(html, 'enabled')
    expect(row).toContain('→ 0.2.0')
    expect(row).toContain('>Update</button>')
    expect(row).not.toContain('Configure')
  })

  it('says so in one line when nothing is installed', () => {
    const html = renderToStaticMarkup(
      <IntegrationLedger
        rows={[]}
        actions={{
          onToggle: () => undefined,
          onReset: () => undefined,
          onUpdate: () => undefined,
          pending: null,
        }}
      />,
    )
    expect(html).toContain('No plugins installed.')
    expect(html).not.toContain('<li')
  })
})
