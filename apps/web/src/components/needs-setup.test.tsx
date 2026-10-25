import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SetupAudience } from '#/lib/server-fns'
import { NeedsSetup } from './needs-setup'

/**
 * The in-place setup prompt: an admin reads what is missing and the
 * link that sets it up; a member reads whom to ask, by name, and no link.
 */

async function render(audience: SetupAudience) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NeedsSetup
          needs="No calendar connected"
          action="Connect Google"
          to="/settings/email-calendar"
          thing="Google"
          audience={audience}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('NeedsSetup', () => {
  it('gives an admin the link and a member the admins to ask', async () => {
    const admin = await render({ isAdmin: true, admins: ['Anish'] })
    expect(admin).toContain('data-needs-setup="admin"')
    expect(admin).toContain('No calendar connected · ')
    expect(admin).toContain('href="/settings/email-calendar"')
    expect(admin).toContain('Connect Google ›')

    const member = await render({ isAdmin: false, admins: ['Anish', 'Priya'] })
    expect(member).toContain('data-needs-setup="member"')
    expect(member).toContain('Ask Anish or Priya to set up Google')
    expect(member).not.toContain('href=')
  })
})
