import { createFileRoute } from '@tanstack/react-router'

/**
 * The MCP endpoint (SPA-23, `docs/spec-ai-substrate.md` §5): Streamable HTTP,
 * stateless, authenticated by a per-user bearer token minted in Settings →
 * API tokens. Every verb goes to the one handler — it checks the token
 * first, then answers GET and DELETE 405 (stateless) — and the handler,
 * the SDK and the token store are imported inside it, so none of them can
 * reach the client bundle.
 */
const handle = async ({ request }: { request: Request }) => {
  const { handleMcpRequest } = await import('#/lib/mcp/server')
  return handleMcpRequest(request)
}

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      POST: handle,
      GET: handle,
      DELETE: handle,
    },
  },
})
