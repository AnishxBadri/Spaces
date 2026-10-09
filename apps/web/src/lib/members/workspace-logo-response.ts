import { auth } from '#/lib/auth'
import { readLogo } from './workspace-logo'

/**
 * The workspace logo as an image response, for a signed-in member only.
 * - Serves only the digest the settings name now, so the route is no way to
 *   read any other blob.
 * - Sandboxed and `nosniff`: even opened directly, an SVG runs nothing.
 */
export async function logoResponse(
  request: Request,
  sha: string,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return new Response('Unauthorized', { status: 401 })
  const logo = await readLogo(sha)
  if (logo === null) return new Response('Not found', { status: 404 })
  return new Response(Buffer.from(logo.bytes), {
    headers: {
      'content-type': logo.type,
      'content-length': String(logo.bytes.length),
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
      // Content-addressed: a new logo is a new URL.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}
