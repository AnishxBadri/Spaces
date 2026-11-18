import { createFileRoute } from '@tanstack/react-router'
import { getRequestIP } from '@tanstack/react-start/server'
import { auth } from '#/lib/auth'
import { clientIp, trustsProxy, withClientIp } from '#/lib/client-ip'

/**
 * Better Auth reads the client address from a header only, so the socket
 * address (or, behind a trusted proxy, the forwarded one) is handed to it
 * here, where the socket is still in reach.
 */
async function handle(request: Request): Promise<Response> {
  const ip = clientIp({
    forwardedFor: request.headers.get('x-forwarded-for'),
    socket: getRequestIP() ?? null,
    trustProxy: trustsProxy(process.env.TRUST_PROXY),
  })
  return auth.handler(await withClientIp(request, ip))
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
