import { createFileRoute } from '@tanstack/react-router'

/**
 * The return leg of a connect dance: verifies the signed state, trades the
 * provider's code (with the PKCE verifier from the cookie) for tokens, reads
 * the provider account, upserts one encrypted `account_connection` row and
 * redirects to the state's return path.
 */
export const Route = createFileRoute('/api/connections/$provider/callback')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { handleConnectCallback } =
          await import('#/lib/connections/callback')
        return handleConnectCallback(request, params.provider)
      },
    },
  },
})
