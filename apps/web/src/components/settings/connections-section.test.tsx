import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConnectionsSection } from './connections-section'

/**
 * The Connect control, rendered as the server renders it for a member: a
 * provider with an OAuth client gets one outlined link to the start route;
 * one without draws nothing to click.
 */

describe('ConnectionsSection', () => {
  it('offers Connect for a configured provider, leaving through the start route', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection apps={null} configured={['google']} />,
    )
    expect(html).toContain('href="/api/connections/google/start?product=drive"')
    expect(html).toContain('aria-label="Connect Google Drive"')
    expect(html).toContain('>Connect</a>')
    expect(html).toContain('drive.file')
    expect(html).not.toContain('No connections.')
    expect(html).not.toContain('/api/connections/box/')
  })

  it('draws nothing clickable when no provider has a client', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection apps={null} configured={[]} />,
    )
    expect(html).toContain('No connections.')
    expect(html).not.toContain('/api/connections/')
  })
})
