import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PluginStatusSection } from './plugin-status-section.tsx'

/**
 * One Today line per tripped plugin, naming it and its reason; no section at
 * all once every row is reset. Rendered the way the app's server render does.
 */

const tripped = [
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
    pluginId: 'flaky',
    lastError: '5 failures in an hour',
  },
  {
    integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000002',
    pluginId: 'throws',
    lastError: null,
  },
]

describe('PluginStatusSection', () => {
  it('renders one line per tripped plugin with its id and last error', () => {
    const html = renderToStaticMarkup(<PluginStatusSection tripped={tripped} />)
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html).toContain('Plugins')
    expect(html).toContain('2 · disabled')
    expect(html).toContain('flaky')
    expect(html).toContain('5 failures in an hour')
    expect(html).toContain('throws')
    expect(html).toContain('stopped by the breaker')
  })

  it('renders nothing when no plugin is tripped', () => {
    expect(renderToStaticMarkup(<PluginStatusSection tripped={[]} />)).toBe('')
  })
})
