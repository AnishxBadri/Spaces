import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * An in-repo OAuth identity provider for tests: a node http server on an
 * ephemeral loopback port, no container, no network beyond the loopback.
 * - `/authorize` records each request's query and answers 302 to its
 *   `redirect_uri` with a `code` and the `state` it was given.
 * - Point a provider's `authUrl` at `authUrl` through the start program's
 *   `providers` argument.
 */

export type FakeIdp = {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string
  readonly authUrl: string
  /** Every `/authorize` query, in arrival order. */
  readonly authorizeRequests: Array<URLSearchParams>
  /** The codes handed out, in the order they were issued. */
  readonly issuedCodes: Array<string>
  readonly close: () => Promise<void>
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const authorizeRequests: Array<URLSearchParams> = []
  const issuedCodes: Array<string> = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-idp.invalid')
    if (req.method !== 'GET' || url.pathname !== '/authorize') {
      res.writeHead(404).end('Not found')
      return
    }
    authorizeRequests.push(url.searchParams)
    const redirect = url.searchParams.get('redirect_uri')
    if (redirect === null) {
      res.writeHead(400).end('redirect_uri is required')
      return
    }
    const code = `fake-code-${String(issuedCodes.length + 1)}`
    issuedCodes.push(code)
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    const state = url.searchParams.get('state')
    if (state !== null) back.searchParams.set('state', state)
    res.writeHead(302, { location: back.toString() }).end()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('fake IdP did not bind a port')
  const { port }: AddressInfo = address
  const origin = `http://127.0.0.1:${String(port)}`

  return {
    origin,
    authUrl: `${origin}/authorize`,
    authorizeRequests,
    issuedCodes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
