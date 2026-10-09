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
})
