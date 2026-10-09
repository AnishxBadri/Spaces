import { createFileRoute } from '@tanstack/react-router'

/**
 * The workspace logo, drawn by the sidebar head and General.
 * - The handler is imported inside the request, so neither it nor the pg
 *   client can reach the client bundle.
 */
export const Route = createFileRoute('/api/workspace-logo/$sha')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { logoResponse } =
          await import('#/lib/members/workspace-logo-response')
        return logoResponse(request, params.sha)
      },
    },
  },
})
