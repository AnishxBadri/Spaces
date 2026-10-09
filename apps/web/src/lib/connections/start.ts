import { Effect, Schema } from 'effect'
import { jsonString } from '@spaces/core/json'
import {
  PROVIDERS,
  isProviderId,
  redirectUri,
  unknownScopes,
} from '@spaces/core/providers/registry'
import type { ProviderEntry, ProviderId } from '@spaces/core/providers/registry'
import { readWorkspaceCredential } from '@spaces/core/writes/vault'
import {
  challengeFor,
  newVerifier,
  verifierCookie,
} from '@spaces/core/writes/connections/pkce'
import { holdsConnection } from '@spaces/core/writes/connections/scopes'
import { newNonce, signState } from '@spaces/core/writes/connections/state'
import { auth } from '#/lib/auth'
import { effectFn } from '#/lib/server/effect'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import { PRODUCTS, productOf, productPage } from './products'

/**
 * The outbound leg of a connect dance: `/api/connections/$provider/start`
 * as a Request → Response. Session, product, scopes and return path in;
 * a 302 to the provider's own consent screen out, with the PKCE verifier
 * left behind in a cookie (`verifierCookie`) and the signed state riding along.
 * - A data grant, never a login: better-auth is not involved past the session.
 * - Outside `lib/server/` so a test drives it without a request context.
 */

export class ProviderUnconfigured extends Schema.TaggedError<ProviderUnconfigured>()(
  'ProviderUnconfigured',
  { provider: Schema.String, message: Schema.String },
) {}

/** A request this route cannot honour as asked: a 400 naming what. */
export class ConnectRefused extends Schema.TaggedError<ConnectRefused>()(
  'ConnectRefused',
  { message: Schema.String },
) {}

export class ConnectUnauthorized extends Schema.TaggedError<ConnectUnauthorized>()(
  'ConnectUnauthorized',
  { message: Schema.String },
) {}

export class ConnectFailed extends Schema.TaggedError<ConnectFailed>()(
  'ConnectFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type ConnectStartError =
  ProviderUnconfigured | ConnectRefused | ConnectUnauthorized | ConnectFailed

/** The registry the start leg builds against; a test swaps an `authUrl`. */
export type ProviderTable = Readonly<Record<ProviderId, ProviderEntry>>

export type ConnectStartInput = {
  readonly userId: string
  readonly provider: string
  readonly params: URLSearchParams
  /** APP_URL as the app decided it. */
  readonly origin: string
  /** Whether cookies carry Secure: APP_URL is https. */
  readonly secure: boolean
  readonly providers: ProviderTable
}

export type ConnectStartRedirect = {
  readonly location: string
  readonly setCookie: string
}

const refuse = (message: string) => new ConnectRefused({ message })

/** An address to hand the provider as a hint: one `@`, no spaces, bounded. */
const ACCOUNT_HINT = /^[^\s@]{1,128}@[^\s@]{1,253}$/

/**
 * A same-origin path, or null: no scheme, no host, no `//` or `/\`.
 * Without one, the dance ends on the settings page that lists the product.
 */
function returnPath(raw: string | null, fallback: string): string | null {
  if (raw === null || raw === '') return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\'))
    return null
  const base = 'http://return.invalid'
  const url = new URL(raw, base)
  if (url.origin !== base) return null
  return `${url.pathname}${url.search}${url.hash}`
}

function requestedScopes(raw: string | null, base: ReadonlyArray<string>) {
  if (raw === null) return [...base]
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ]
}

export const connectStartProgram = Effect.fn('connectStart')(function* (
  input: ConnectStartInput,
): Effect.fn.Return<
  ConnectStartRedirect,
  ProviderUnconfigured | ConnectRefused | ConnectFailed
> {
  const { provider: providerId, params } = input
  if (!isProviderId(providerId))
    return yield* refuse(`Unknown provider: ${providerId}`)
  const provider: ProviderId = providerId
  const entry = input.providers[provider]

  const productId = params.get('product') ?? ''
  const product = productOf(provider, productId)
  if (product === null)
    return yield* refuse(
      `Unknown ${entry.label} product: ${productId || '(none)'}. One of ${Object.keys(PRODUCTS[provider]).join(', ')}`,
    )

  const scopes = requestedScopes(params.get('scopes'), product.base)
  if (scopes.length === 0) return yield* refuse('No scopes asked for')
  const unknown = unknownScopes(provider, scopes)
  if (unknown.length > 0)
    return yield* refuse(
      `Unknown ${entry.label} scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    )
  const known = scopes.flatMap((value) =>
    entry.scopes.filter((s) => s.value === value),
  )
  const foreign = known.filter(
    (s) => s.plugin !== null && s.plugin !== product.plugin,
  )
  if (foreign.length > 0)
    return yield* refuse(
      `Not a ${product.label} scope: ${foreign.map((s) => s.value).join(', ')}`,
    )

  const returnTo = returnPath(
    params.get('return'),
    productPage(provider, productId),
  )
  if (returnTo === null)
    return yield* refuse('return must be a path on this site')

  const account = params.get('account')
  if (account !== null && !ACCOUNT_HINT.test(account))
    return yield* refuse('account must be an email address')

  const client = yield* Effect.tryPromise({
    try: () => readWorkspaceCredential(provider, 'oauth_client'),
    catch: (cause) =>
      new ConnectFailed({ message: 'Could not read the OAuth client', cause }),
  })
  const clientId =
    client?.status === 'active' ? jsonString(client.meta.clientId) : null
  if (clientId === null)
    return yield* new ProviderUnconfigured({
      provider,
      message: `${entry.label} has no OAuth client yet. An admin adds it in Settings → Connection apps.`,
    })

  const held = yield* holdsConnection({
    userId: input.userId,
    provider,
    product: productId,
  }).pipe(
    Effect.mapError(
      (e) => new ConnectFailed({ message: e.message, cause: e.cause }),
    ),
  )

  const redirect = redirectUri(input.origin, provider)
  const callbackPath = yield* Effect.try({
    try: () => new URL(redirect).pathname,
    catch: (cause) =>
      new ConnectFailed({ message: 'APP_URL is not an absolute URL', cause }),
  })
  const verifier = newVerifier()
  const nonce = newNonce()
  const state = signState({
    userId: input.userId,
    provider,
    product: productId,
    scopes,
    returnTo,
    nonce,
    issuedAt: Date.now(),
  })

  const url = new URL(entry.authUrl)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', known.map((s) => s.wire).join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  if (provider === 'google') {
    // A refresh token comes back only with both.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
  }
  // Preselects the account a product is being added to. Box has no hint.
  if (provider === 'google' && account !== null)
    url.searchParams.set('login_hint', account)
  // Scope growth: the new token carries the earlier grant too. Box ignores it.
  if (held) url.searchParams.set('include_granted_scopes', 'true')

  return {
    location: url.toString(),
    setCookie: verifierCookie({
      nonce,
      verifier,
      path: callbackPath,
      secure: input.secure,
    }),
  }
})

/** The session's user, or `ConnectUnauthorized`; both legs read it. */
export const sessionUser = Effect.fn('connectSession')(function* (
  request: Request,
): Effect.fn.Return<{ id: string }, ConnectUnauthorized | ConnectFailed> {
  const session = yield* Effect.tryPromise({
    try: () => auth.api.getSession({ headers: request.headers }),
    catch: (cause) =>
      new ConnectFailed({ message: 'Could not read the session', cause }),
  })
  if (!session)
    return yield* new ConnectUnauthorized({
      message: 'Sign in to connect a provider',
    })
  return { id: session.user.id }
})

/** A plain-text answer no cache keeps. */
export const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const refusal = (error: ConnectStartError): Response => {
  switch (error._tag) {
    case 'ConnectUnauthorized':
      return text(401, error.message)
    case 'ConnectRefused':
      return text(400, error.message)
    case 'ProviderUnconfigured':
      return text(409, error.message)
    case 'ConnectFailed':
      console.error('[connections] could not start a connection', error.cause)
      return text(500, error.message)
  }
}

const startResponse = Effect.fn('connectStartResponse')(
  function* (
    request: Request,
    provider: string,
    providers: ProviderTable,
  ): Effect.fn.Return<ConnectStartRedirect, ConnectStartError> {
    const user = yield* sessionUser(request)
    const { origin, cookieSecure } = describeExternalOrigin(process.env.APP_URL)
    return yield* connectStartProgram({
      userId: user.id,
      provider,
      params: new URL(request.url).searchParams,
      origin,
      secure: cookieSecure,
      providers,
    })
  },
  Effect.match({
    onSuccess: ({ location, setCookie }) =>
      new Response(null, {
        status: 302,
        headers: {
          location,
          'set-cookie': setCookie,
          'cache-control': 'no-store',
        },
      }),
    onFailure: refusal,
  }),
)

/** The route's GET. `providers` is the registry unless a test points it elsewhere. */
export function handleConnectStart(
  request: Request,
  provider: string,
  providers: ProviderTable = PROVIDERS,
): Promise<Response> {
  return effectFn(startResponse)(request, provider, providers)
}
