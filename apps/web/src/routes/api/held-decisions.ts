import { createFileRoute } from '@tanstack/react-router'

/**
 * The undo hold's beacon: every decision still held when the page goes,
 * run as the signed-in user through the programs the server fns run.
 * - Same-origin POST from `navigator.sendBeacon`; the session cookie rides it.
 * - The handler is imported inside the request, so neither it, the pg client
 *   nor Effect can reach the client bundle.
 */
export const Route = createFileRoute('/api/held-decisions')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleHeldDecisionsRequest } =
          await import('#/lib/inbox/held-commit')
        return handleHeldDecisionsRequest(request)
      },
    },
  },
})
