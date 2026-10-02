import { createFileRoute } from '@tanstack/react-router'

/**
 * A record's plugin job status, as server-sent events: the record page's
 * pending and outcome without polling. (D64)
 * - The viewer's session decides, never an integration's: a record the
 *   viewer could not open is 403.
 * - The handler is imported inside the request, so neither it, the pg client
 *   nor Effect can reach the client bundle.
 */
export const Route = createFileRoute('/api/job-status/$entityId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { handleJobStatusRequest } =
          await import('#/lib/integrations/job-status-stream')
        return handleJobStatusRequest(request, params.entityId)
      },
    },
  },
})
