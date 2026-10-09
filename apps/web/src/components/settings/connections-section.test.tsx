import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionListRow, ProviderAppRow } from '#/lib/server-fns'
import { ConnectionAppsSection } from './connection-apps-section'
import { ConnectionsSection } from './connections-section'

/**
 * The section as the server renders it: a band per provider, the reader's
 * rows under it, Connect for a product they hold none of, and the
 * not-configured band for a provider with no OAuth client.
 */

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<object>('@tanstack/react-router')),
  useRouter: () => ({ invalidate: async () => {} }),
}))

const row = (over: Partial<ConnectionListRow> = {}): ConnectionListRow => ({
  connectionId: '7a3c1b52-0f7e-4f53-9d43-3c3a8f0d2e11',
  provider: 'google',
  product: 'drive',
  externalEmail: 'anish@fund.example',
  scopes: ['openid', 'email', 'drive.file', 'drive.readonly'],
  status: 'active',
  errorReason: null,
  lastSyncAt: null,
  ...over,
})

const googleApp: ProviderAppRow = {
  provider: 'google',
  label: 'Google',
  configured: false,
  clientId: null,
  secretDisplay: null,
  secretSetAt: null,
  redirectUri: 'http://localhost:3000/api/connections/google/callback',
}

describe('ConnectionsSection', () => {
  it('offers Connect for a configured provider, leaving through the start route', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection
        isAdmin={false}
        configured={['google']}
        connections={[]}
      />,
    )
    expect(html).toContain('href="/api/connections/google/start?product=drive"')
    expect(html).toContain('aria-label="Connect Google Drive"')
    expect(html).toContain('>Connect</a>')
    expect(html).toContain('drive.file')
    expect(html).not.toContain('/api/connections/box/')
  })

  it('tells a member to ask an admin when a provider has no OAuth client', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection isAdmin={false} configured={[]} connections={[]} />,
    )
    expect(html).toContain('Ask an admin to configure Google')
    expect(html).toContain('Ask an admin to configure Box')
    expect(html).not.toContain('/api/connections/')
    expect(html).not.toContain('#oauth-client-')
  })

  it('points an admin at the OAuth client under Connection apps, and draws no client itself', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection isAdmin configured={[]} connections={[]} />,
    )
    expect(html).toContain(
      'href="/settings/connection-apps#oauth-client-google"',
    )
    expect(html).toContain('Configure Google')
    expect(html).not.toContain('id="oauth-client-google"')
    expect(html).not.toContain('OAuth client')
    expect(html).not.toContain('Redirect URI')
    expect(html).not.toContain('Ask an admin')
  })

  it('leaves the OAuth clients to Connection apps, at the anchor Connections links to', () => {
    const html = renderToStaticMarkup(
      <ConnectionAppsSection
        apps={[
          googleApp,
          {
            ...googleApp,
            provider: 'box',
            label: 'Box',
            configured: true,
            clientId: 'box-client',
            secretDisplay: '••••a1b2',
            redirectUri: 'http://localhost:3000/api/connections/box/callback',
          },
        ]}
      />,
    )
    expect(html).toContain('Settings · Integrations')
    expect(html).toContain('>Connection apps</h1>')
    expect(html).toContain('id="oauth-client-google"')
    expect(html).toContain('Google OAuth client')
    expect(html).toContain('id="oauth-client-box"')
    expect(html).toContain('box-client')
    expect(html).toContain(
      'http://localhost:3000/api/connections/google/callback',
    )
  })

  it('draws a held connection: account, product scopes as chips, last sync, status, actions', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection
        isAdmin={false}
        configured={['google']}
        connections={[row()]}
      />,
    )
    expect(html).toContain('anish@fund.example')
    expect(html).toContain('>drive.file</span>')
    expect(html).toContain('>drive.readonly</span>')
    expect(html).not.toContain('>openid</span>')
    expect(html).toContain('never synced')
    expect(html).toContain('>active</span>')
    expect(html).toContain(
      'aria-label="Refresh Google Drive anish@fund.example"',
    )
    expect(html).toContain(
      'aria-label="Disconnect Google Drive anish@fund.example"',
    )
    expect(html).not.toContain('aria-label="Connect Google Drive"')
  })

  it("prints an error row's stored provider reason inline, and offers Reconnect", () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection
        isAdmin={false}
        configured={['google']}
        connections={[
          row({
            status: 'error',
            errorReason: 'invalid_grant: Token has been expired or revoked.',
            lastSyncAt: '2026-09-29T08:00:00.000Z',
          }),
        ]}
      />,
    )
    expect(html).toContain('invalid_grant: Token has been expired or revoked.')
    expect(html).toContain('>error</span>')
    expect(html).toContain('synced 09-29')
    expect(html).toContain('href="/api/connections/google/start?product=drive"')
    expect(html).toContain('>Reconnect</a>')
    expect(html).not.toContain('>Refresh</button>')
  })

  it('draws one row per account under the same product', () => {
    const html = renderToStaticMarkup(
      <ConnectionsSection
        isAdmin={false}
        configured={['google']}
        connections={[
          row(),
          row({
            connectionId: '9b1d7d0e-5a43-4a8e-8c71-0d5b2f4e6a90',
            externalEmail: 'deals@fund.example',
          }),
        ]}
      />,
    )
    expect(html).toContain('anish@fund.example')
    expect(html).toContain('deals@fund.example')
  })
})
