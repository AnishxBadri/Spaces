import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * An in-repo OAuth identity provider for tests: a node http server on an
 * ephemeral loopback port, no container, no network beyond the loopback.
 * - `GET /authorize` records the query and answers 302 to `redirect_uri`
 *   with a `code` and the `state` it was given.
 * - `POST /token` trades a code once, only with the `code_verifier` whose
 *   S256 challenge `/authorize` recorded — otherwise 400 `invalid_grant`.
 * - `POST /token` with `grant_type=refresh_token` rotates the refresh token
 *   on every use, as Box does: a spent one answers 400 `invalid_grant`, so
 *   a double spend shows.
 * - `POST /revoke` forgets a token it issued (200); an unknown one is 400.
 * - `GET /userinfo` (Google's shape, `sub`/`email`) and `GET /2.0/users/me`
 *   (Box's, `id`/`login`) answer a bearer token `/token` issued.
 * - Point a provider's URLs at it through a program's `providers` argument.
 */

export type FakeIdpMode = {
  /** Wire scopes `/token` leaves out of its grant: a partial consent. */
  withheldScopes: Array<string>
  /** Answer `/token` with no `scope` field, as Box does. */
  omitScope: boolean
  /** Seconds, sent as `refresh_token_expires_in` when set. */
  refreshTokenExpiresIn: number | null
  /** An OAuth error code every refresh answers with (400), e.g. `invalid_grant`. */
  refuseRefresh: string | null
  /** `/token` and `/revoke` answer 503. */
  outage: boolean
  /** Milliseconds `/token` waits before answering, to widen a race. */
  tokenDelayMs: number
}

export type FakeIdpAccount = { sub: string; email: string }

export type FakeIdp = {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string
  readonly authUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  /** Google's shape. */
  readonly userinfoUrl: string
  /** Box's shape. */
  readonly boxUserUrl: string
  /** Every `/authorize` query, in arrival order. */
  readonly authorizeRequests: Array<URLSearchParams>
  /** Every `/token` form body, in arrival order. */
  readonly tokenRequests: Array<URLSearchParams>
  /** Every `/revoke` form body, in arrival order. */
  readonly revokeRequests: Array<URLSearchParams>
  /** The codes handed out, in the order they were issued. */
  readonly issuedCodes: Array<string>
  /** The refresh tokens still good, in the order they were issued. */
  readonly liveRefreshTokens: () => Array<string>
  /** Issues a token pair as a finished dance would, skipping the dance. */
  readonly mint: (scope?: string) => {
    accessToken: string
    refreshToken: string
  }
  /** Switches a test flips; `reset()` puts them back. */
  readonly mode: FakeIdpMode
  /** Whose account the userinfo endpoints describe. */
  account: FakeIdpAccount
  readonly reset: () => void
  readonly close: () => Promise<void>
}

type Pending = { challenge: string | null; scope: string }

const FRESH_ACCOUNT: FakeIdpAccount = {
  sub: '109876543210987654321',
  email: 'anish@fund.example',
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const s256 = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

export async function startFakeIdp(): Promise<FakeIdp> {
  const authorizeRequests: Array<URLSearchParams> = []
  const tokenRequests: Array<URLSearchParams> = []
  const issuedCodes: Array<string> = []
  const pending = new Map<string, Pending>()
  const revokeRequests: Array<URLSearchParams> = []
  const accessTokens = new Set<string>()
  /** Live refresh token → the scope it was granted. */
  const refreshTokens = new Map<string, string>()
  let rotations = 0
  let minted = 0
  const mode: FakeIdpMode = {
    withheldScopes: [],
    omitScope: false,
    refreshTokenExpiresIn: null,
    refuseRefresh: null,
    outage: false,
    tokenDelayMs: 0,
  }
  const idp = { account: { ...FRESH_ACCOUNT } }

  const json = (
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ) => {
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(body))
  }

  const authorize = (url: URL, res: ServerResponse) => {
    authorizeRequests.push(url.searchParams)
    const redirect = url.searchParams.get('redirect_uri')
    if (redirect === null) {
      res.writeHead(400).end('redirect_uri is required')
      return
    }
    const code = `fake-code-${String(issuedCodes.length + 1)}`
    issuedCodes.push(code)
    pending.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      scope: url.searchParams.get('scope') ?? '',
    })
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    const state = url.searchParams.get('state')
    if (state !== null) back.searchParams.set('state', state)
    res.writeHead(302, { location: back.toString() }).end()
  }

  const issue = (
    res: ServerResponse,
    accessToken: string,
    refreshToken: string,
    scope: string,
  ) => {
    accessTokens.add(accessToken)
    refreshTokens.set(refreshToken, scope)
    json(res, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3599,
      ...(mode.omitScope ? {} : { scope }),
      ...(mode.refreshTokenExpiresIn === null
        ? {}
        : { refresh_token_expires_in: mode.refreshTokenExpiresIn }),
    })
  }

  const invalid = (res: ServerResponse, description: string) =>
    json(res, 400, { error: 'invalid_grant', error_description: description })

  const exchange = (form: URLSearchParams, res: ServerResponse) => {
    const code = form.get('code') ?? ''
    const grant = pending.get(code)
    if (grant === undefined) return invalid(res, 'Unknown or used code')
    const verifier = form.get('code_verifier')
    if (verifier === null || verifier === '')
      return invalid(res, 'Missing code verifier')
    if (grant.challenge === null || s256(verifier) !== grant.challenge)
      return invalid(res, 'Invalid code verifier')
    pending.delete(code)
    const granted = grant.scope
      .split(' ')
      .filter((s) => s !== '' && !mode.withheldScopes.includes(s))
    issue(res, `fake-access-${code}`, `fake-refresh-${code}`, granted.join(' '))
  }

  const refresh = (form: URLSearchParams, res: ServerResponse) => {
    if (mode.refuseRefresh !== null)
      return json(res, 400, {
        error: mode.refuseRefresh,
        error_description: 'Token has been expired or revoked.',
      })
    const spent = form.get('refresh_token') ?? ''
    const scope = refreshTokens.get(spent)
    if (scope === undefined)
      return invalid(res, 'Unknown or spent refresh token')
    refreshTokens.delete(spent)
    rotations += 1
    const n = String(rotations)
    issue(res, `fake-access-r${n}`, `fake-refresh-r${n}`, scope)
  }

  const token = (form: URLSearchParams, res: ServerResponse) => {
    tokenRequests.push(form)
    if (mode.outage) return json(res, 503, { error: 'temporarily_unavailable' })
    switch (form.get('grant_type')) {
      case 'authorization_code':
        return exchange(form, res)
      case 'refresh_token':
        return refresh(form, res)
      default:
        return json(res, 400, { error: 'unsupported_grant_type' })
    }
  }

  const revoke = (form: URLSearchParams, res: ServerResponse) => {
    revokeRequests.push(form)
    if (mode.outage) return json(res, 503, { error: 'temporarily_unavailable' })
    const value = form.get('token') ?? ''
    const known = refreshTokens.delete(value) || accessTokens.delete(value)
    if (!known) return json(res, 400, { error: 'invalid_token' })
    res.writeHead(200).end()
  }

  const later = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })

  const bearer = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? ''
    return (
      header.startsWith('Bearer ') && accessTokens.has(header.slice(7).trim())
    )
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-idp.invalid')
    const route = `${req.method ?? ''} ${url.pathname}`
    switch (route) {
      case 'GET /authorize':
        return authorize(url, res)
      case 'POST /token':
        readBody(req)
          .then(async (body) => {
            if (mode.tokenDelayMs > 0) await later(mode.tokenDelayMs)
            token(new URLSearchParams(body), res)
          })
          .catch(() => res.writeHead(400).end())
        return
      case 'POST /revoke':
        readBody(req).then(
          (body) => revoke(new URLSearchParams(body), res),
          () => res.writeHead(400).end(),
        )
        return
      case 'GET /userinfo':
        if (!bearer(req)) return json(res, 401, { error: 'invalid_token' })
        return json(res, 200, {
          sub: idp.account.sub,
          email: idp.account.email,
        })
      case 'GET /2.0/users/me':
        if (!bearer(req)) return json(res, 401, { error: 'invalid_token' })
        return json(res, 200, {
          type: 'user',
          id: idp.account.sub,
          login: idp.account.email,
        })
      default:
        res.writeHead(404).end('Not found')
    }
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
    tokenUrl: `${origin}/token`,
    revokeUrl: `${origin}/revoke`,
    userinfoUrl: `${origin}/userinfo`,
    boxUserUrl: `${origin}/2.0/users/me`,
    authorizeRequests,
    tokenRequests,
    revokeRequests,
    issuedCodes,
    liveRefreshTokens: () => [...refreshTokens.keys()],
    mint: (scope = 'openid email') => {
      minted += 1
      const n = String(minted)
      const pair = {
        accessToken: `fake-access-m${n}`,
        refreshToken: `fake-refresh-m${n}`,
      }
      accessTokens.add(pair.accessToken)
      refreshTokens.set(pair.refreshToken, scope)
      return pair
    },
    mode,
    get account() {
      return idp.account
    },
    set account(next: FakeIdpAccount) {
      idp.account = next
    },
    reset: () => {
      authorizeRequests.length = 0
      tokenRequests.length = 0
      revokeRequests.length = 0
      mode.withheldScopes = []
      mode.omitScope = false
      mode.refreshTokenExpiresIn = null
      mode.refuseRefresh = null
      mode.outage = false
      mode.tokenDelayMs = 0
      idp.account = { ...FRESH_ACCOUNT }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
