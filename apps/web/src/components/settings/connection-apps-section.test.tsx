import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderAppRow } from '#/lib/server-fns'
import { ConnectionAppsSection } from './connection-apps-section'

/** Connection apps as the server renders it: one OAuth client group per provider. */

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<object>('@tanstack/react-router')),
  useRouter: () => ({ invalidate: async () => {} }),
}))

const googleApp: ProviderAppRow = {
  provider: 'google',
  label: 'Google',
  configured: false,
  clientId: null,
  secretDisplay: null,
  secretSetAt: null,
  redirectUri: 'http://localhost:3000/api/connections/google/callback',
  membersConnected: 0,
}

describe('ConnectionAppsSection', () => {
  it('draws each OAuth client at the anchor the accounts pages link to', () => {
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
            secretSetAt: '2026-10-07T09:00:00.000Z',
            redirectUri: 'http://localhost:3000/api/connections/box/callback',
            membersConnected: 2,
          },
        ]}
      />,
    )
    expect(html).toContain('Settings · Integrations')
    expect(html).toContain('>Connection apps</h1>')
    expect(html).toContain('id="oauth-client-google"')
    expect(html).toContain('id="oauth-client-box"')
    expect(html).toContain('box-client')
    expect(html).toContain(
      'title="http://localhost:3000/api/connections/google/callback"',
    )
    expect(html).toContain('…/api/connections/google/callback')
  })

  it('reads by sheet 08: sentence-case labels, the stored secret with Replace, members connected', () => {
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
            secretSetAt: '2026-10-07T09:00:00.000Z',
            redirectUri: 'http://localhost:3000/api/connections/box/callback',
            membersConnected: 2,
          },
        ]}
      />,
    )
    for (const label of ['Redirect address', 'Client ID', 'Client secret'])
      expect(html).toContain(`>${label}</span>`)
    expect(html).not.toContain('OAuth client')
    expect(html).toContain('not set up')
    expect(html).toContain('2 members connected')
    expect(html).toContain('●●●●</span> set 10-07')
    expect(html).toContain('>Replace</button>')
    expect(html).toContain('>Edit</button>')
    // The unset client asks for both fields.
    expect(html).toContain('placeholder="Paste the client ID"')
    expect(html).toContain('placeholder="Paste the client secret"')
  })
})
