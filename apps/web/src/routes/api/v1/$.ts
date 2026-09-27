import { createFileRoute } from '@tanstack/react-router'

/**
 * The external API, `/api/v1/*` (SPA-37; D8, D27). Every verb and every path
 * under the prefix goes to the one HttpApi web handler in `#/lib/rpc/api`,
 * which routes, decodes, runs the procedure and renders any failure as the
 * one error shape. The handler is imported inside the request, so neither it
 * nor Effect can reach the client bundle — and this file imports no `effect`
 * at all, which is the lint rule on `src/routes/**` holding.
 */
const handle = async ({ request }: { request: Request }) => {
  const { handleApiRequest } = await import('#/lib/rpc/api')
  return handleApiRequest(request)
}

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      ANY: handle,
    },
  },
})
