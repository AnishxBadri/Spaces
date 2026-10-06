import { Effect } from 'effect'
import { jsonString } from '@spaces/core/json'
import {
  PROVIDERS,
  isProviderId,
  redirectUri,
} from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import {
  readWorkspaceCredential,
  resolveSecret,
} from '@spaces/core/writes/vault'
import {
  exchangeCode,
  grantedScopes,
  readAccount,
} from '@spaces/core/writes/connections/exchange'
import type { ExchangeFailed } from '@spaces/core/writes/connections/exchange'
import { upsertConnection } from '@spaces/core/writes/connections/grant'
import {
  clearVerifierCookie,
  readVerifierCookie,
} from '@spaces/core/writes/connections/pkce'
import {
  StateInvalid,
  signedNonce,
  verifyState,
} from '@spaces/core/writes/connections/state'
import { effectFn } from '#/lib/server/effect'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import {
  ConnectFailed,
  ConnectRefused,
  ProviderUnconfigured,
  sessionUser,
  text,
} from './start'
import type { ConnectUnauthorized, ProviderTable } from './start'

/**
 * The return leg of a connect dance: `/api/connections/$provider/callback`
 * as a Request → Response. The signed state, the verifier cookie it names
 * and the provider's code in; one encrypted `account_connection` row and a
 * 302 to the state's return path out.
 * - Order: state, then the provider's `error`, then the cookie, then the
 *   exchange. Nothing is written before the account is known.
 * - The verifier cookie is cleared on every answer, success or refusal.
 */

export type ConnectCallbackError =
  | StateInvalid
  | ConnectRefused
  | ConnectUnauthorized
  | ProviderUnconfigured
  | ExchangeFailed
  | ConnectFailed

export type ConnectCallbackInput = {
  readonly userId: string
  readonly provider: string
  readonly params: URLSearchParams
  readonly cookieHeader: string | null
  /** APP_URL as the app decided it. */
  readonly origin: string
  readonly providers: ProviderTable
}

const refuse = (message: string) => new ConnectRefused({ message })

const failed = (message: string) => (cause: unknown) =>
  new ConnectFailed({ message, cause })

/** The client id and secret the start leg's client was registered with. */
const oauthClient = Effect.fn('oauthClient')(function* (
  provider: ProviderId,
  label: string,
): Effect.fn.Return<
  { clientId: string; clientSecret: string },
  ProviderUnconfigured | ConnectFailed
> {
  const row = yield* Effect.tryPromise({
    try: () => readWorkspaceCredential(provider, 'oauth_client'),
    catch: failed('Could not read the OAuth client'),
  })
  const secret = yield* Effect.tryPromise({
    try: () => resolveSecret(provider, 'oauth_client'),
    catch: failed('Could not read the OAuth client'),
  })
  const clientId =
    row?.status === 'active' ? jsonString(row.meta.clientId) : null
  if (clientId === null || secret === null)
    return yield* new ProviderUnconfigured({
      provider,
      message: `${label} has no OAuth client yet. An admin adds it in Settings → Connections.`,
    })
  return { clientId, clientSecret: secret }
})

export const connectCallbackProgram = Effect.fn('connectCallback')(function* (
  input: ConnectCallbackInput,
): Effect.fn.Return<
  { readonly location: string },
  Exclude<ConnectCallbackError, ConnectUnauthorized>
> {
  const { params, provider: providerId } = input
  if (!isProviderId(providerId))
    return yield* refuse(`Unknown provider: ${providerId}`)
  const provider: ProviderId = providerId
  const entry = input.providers[provider]

  const state = yield* verifyState(params.get('state') ?? '', {
    userId: input.userId,
  })
  if (state.provider !== provider)
    return yield* refuse(`This connect request was for ${state.provider}`)

  const denied = params.get('error')
  if (denied !== null)
    return yield* refuse(`${entry.label} did not grant access (${denied})`)

  const verifier = readVerifierCookie(input.cookieHeader, state.nonce)
  if (verifier === null)
    return yield* new StateInvalid({
      reason: 'expired',
      message:
        'The connect request expired or began in another browser; start again',
    })

  const code = params.get('code')
  if (code === null || code === '')
    return yield* refuse(`${entry.label} sent no authorization code`)

  const client = yield* oauthClient(provider, entry.label)
  const grant = yield* exchangeCode({
    tokenUrl: entry.tokenUrl,
    code,
    verifier,
    redirectUri: redirectUri(input.origin, provider),
    ...client,
  })
  const account = yield* readAccount(
    provider,
    entry.userinfoUrl,
    grant.bundle.accessToken,
  )

  const now = Date.now()
  const after = (seconds: number | null) =>
    seconds === null ? null : new Date(now + seconds * 1000)
  yield* upsertConnection({
    userId: input.userId,
    provider,
    product: state.product,
    externalEmail: account.externalEmail,
    externalAccountId: account.externalAccountId,
    scopes: grantedScopes(provider, grant.grantedWire, state.scopes),
    bundle: grant.bundle,
    expiresAt: after(grant.expiresIn),
    refreshTokenExpiresAt: after(grant.refreshTokenExpiresIn),
  }).pipe(
    Effect.mapError(
      (e) => new ConnectFailed({ message: e.message, cause: e.cause }),
    ),
  )

  return { location: state.returnTo }
})

const refusal = (error: ConnectCallbackError): Response => {
  switch (error._tag) {
    case 'ConnectUnauthorized':
      return text(401, error.message)
    case 'StateInvalid':
    case 'ConnectRefused':
      return text(400, error.message)
    case 'ProviderUnconfigured':
      return text(409, error.message)
    case 'ExchangeFailed':
      console.error(
        `[connections] ${error.step} failed (${String(error.status)}): ${error.message}`,
      )
      return text(502, error.message)
    case 'ConnectFailed':
      console.error('[connections] could not finish a connection', error.cause)
      return text(500, error.message)
  }
}

const callbackResponse = Effect.fn('connectCallbackResponse')(
  function* (
    request: Request,
    provider: string,
    providers: ProviderTable,
    origin: string,
  ): Effect.fn.Return<{ readonly location: string }, ConnectCallbackError> {
    const user = yield* sessionUser(request)
    return yield* connectCallbackProgram({
      userId: user.id,
      provider,
      params: new URL(request.url).searchParams,
      cookieHeader: request.headers.get('cookie'),
      origin,
      providers,
    })
  },
  Effect.match({
    onSuccess: ({ location }) =>
      new Response(null, {
        status: 302,
        headers: { location, 'cache-control': 'no-store' },
      }),
    onFailure: refusal,
  }),
)

/**
 * The `Set-Cookie` that clears this dance's verifier, or null when the
 * state is not genuinely signed and so names no cookie of ours.
 */
function clearing(
  request: Request,
  provider: string,
  origin: string,
  secure: boolean,
): string | null {
  if (!isProviderId(provider)) return null
  const state = new URL(request.url).searchParams.get('state')
  const nonce = state === null ? null : signedNonce(state)
  const redirect = redirectUri(origin, provider)
  if (nonce === null || !URL.canParse(redirect)) return null
  return clearVerifierCookie({
    nonce,
    path: new URL(redirect).pathname,
    secure,
  })
}

/** The route's GET. `providers` is the registry unless a test points it elsewhere. */
export async function handleConnectCallback(
  request: Request,
  provider: string,
  providers: ProviderTable = PROVIDERS,
): Promise<Response> {
  const { origin, cookieSecure } = describeExternalOrigin(process.env.APP_URL)
  const response = await effectFn(callbackResponse)(
    request,
    provider,
    providers,
    origin,
  )
  const clear = clearing(request, provider, origin, cookieSecure)
  if (clear !== null) response.headers.append('set-cookie', clear)
  return response
}
