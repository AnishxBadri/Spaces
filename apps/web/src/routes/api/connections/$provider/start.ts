import { createFileRoute } from '@tanstack/react-router'

/**
 * The outbound leg of a connect dance: builds the provider's authorize URL
 * (PKCE S256, signed state) and redirects the browser to its consent screen.
 * `?product=` (required), `?scopes=` (comma-separated registry values,
 * default the product's base set), `?return=` (a path, default
 * `/settings/connections`).
 */
export const Route = createFileRoute('/api/connections/$provider/start')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { handleConnectStart } = await import('#/lib/connections/start')
        return handleConnectStart(request, params.provider)
      },
    },
  },
})
