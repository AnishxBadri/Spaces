/**
 * The client address the auth rate limiter counts against.
 * - Whether a forwarded header is believed is the operator's setup
 *   (`TRUST_PROXY`), never the request's say: a client that reaches the app
 *   directly can write any `X-Forwarded-For` it likes.
 * - Trusted, the address is the rightmost `X-Forwarded-For` entry, the one
 *   the nearest proxy saw; entries to its left are whatever the client sent.
 *   Untrusted, it is the socket address.
 */

/** The one header Better Auth reads the client address from. */
export const CLIENT_IP_HEADER = 'x-spaces-client-ip'

/** `TRUST_PROXY=true` (or `1`): every request reaches the app through a proxy. */
export function trustsProxy(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1'
}

export function clientIp(input: {
  forwardedFor: string | null
  socket: string | null
  trustProxy: boolean
}): string | null {
  if (input.trustProxy && input.forwardedFor) {
    const nearest = input.forwardedFor
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1)
    if (nearest) return nearest
  }
  return input.socket
}

/**
 * The request as Better Auth should see it: the client address in
 * `CLIENT_IP_HEADER`, replacing any value the client sent for it.
 */
export async function withClientIp(
  request: Request,
  ip: string | null,
): Promise<Request> {
  const headers = new Headers(request.headers)
  headers.delete(CLIENT_IP_HEADER)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  const bodyless = request.method === 'GET' || request.method === 'HEAD'
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyless ? null : await request.arrayBuffer(),
    signal: request.signal,
  })
}
