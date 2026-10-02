import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PluginStatusSection } from './plugin-status-section.tsx'

/**
 * One line per stopped plugin on Today and Review, naming it, how it stopped
 * and why; no section at all once every row is reset. Rendered the way the
 * app's server render does.
 */

const stopped = [
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
    pluginId: 'flaky',
    state: 'tripped' as const,
    lastError: '5 failures in an hour',
  },
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000002',
    pluginId: 'throws',
    state: 'tripped' as const,
    lastError: null,
  },
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000003',
    pluginId: 'apollo',
    state: 'degraded' as const,
    lastError: 'sdk ^0.1 does not include 1.0.0',
  },
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000004',
    pluginId: 'needs-key',
    state: 'degraded' as const,
    lastError: null,
  },
]

describe('PluginStatusSection', () => {
  it('renders one line per stopped plugin with its id, state and reason', () => {
    const html = renderToStaticMarkup(<PluginStatusSection stopped={stopped} />)
    expect(html.match(/<li/g)).toHaveLength(4)
    expect(html).toContain('Plugins')
    expect(html).toContain('4 · not running')
    expect(html).toContain('flaky')
    expect(html).toContain('5 failures in an hour')
    expect(html).toContain('throws')
    expect(html).toContain('stopped by the breaker')
    expect(html).toContain('apollo')
    expect(html).toContain('sdk ^0.1 does not include 1.0.0')
    expect(html).toContain('the worker could not load it')
    expect(html.match(/>off</g)).toHaveLength(2)
    expect(html.match(/>degraded</g)).toHaveLength(2)
  })

  it('renders nothing when every plugin runs', () => {
    expect(renderToStaticMarkup(<PluginStatusSection stopped={[]} />)).toBe('')
  })
})

describe('PluginStatusSection, a plugin at its credit cap', () => {
  const capped = {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000005',
    pluginId: 'apollo',
    state: 'capped' as const,
    reason: 'daily credit cap (2) reached',
    refused: 3,
  }

  it('renders one line naming the cap and today’s refusals', () => {
    const html = renderToStaticMarkup(
      <PluginStatusSection stopped={[capped]} />,
    )
    expect(html.match(/<li/g)).toHaveLength(1)
    expect(html).toContain('1 · at their credit cap')
    expect(html).toContain('apollo')
    expect(html).toContain('daily credit cap (2) reached')
    expect(html).toContain('3 refused today')
  })

  it('counts a capped line beside stopped ones', () => {
    const html = renderToStaticMarkup(
      <PluginStatusSection stopped={[...stopped, capped]} />,
    )
    expect(html.match(/<li/g)).toHaveLength(5)
    expect(html).toContain('5 · not running or capped')
  })
})
