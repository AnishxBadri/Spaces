import { Effect, Option, Schema } from 'effect'
import { PROVIDERS } from '../../providers/registry'
import type { ProviderId, ProviderScope } from '../../providers/registry'
import type { TokenBundle } from './bundle'

/**
 * The provider half of the return leg: the authorization code traded for
 * tokens at the registry's `tokenUrl`, then the account read from its
 * `userinfoUrl`.
 * - The client authenticates in the form body (`client_secret_post`) and
 *   always sends the PKCE `code_verifier`.
 * - Failures carry the provider's error code, never a token or the secret.
 */

export class ExchangeFailed extends Schema.TaggedError<ExchangeFailed>()(
  'ExchangeFailed',
  {
    step: Schema.Literals(['token', 'userinfo']),
    /** The provider's HTTP status; null when it never answered. */
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

export type ExchangeRequest = {
  readonly tokenUrl: string
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
  readonly clientId: string
  readonly clientSecret: string
}

export type TokenGrant = {
  readonly bundle: TokenBundle
  /** The response's `scope`, space-split; null when it sent none. */
  readonly grantedWire: ReadonlyArray<string> | null
  /** Seconds. */
  readonly expiresIn: number | null
  /** Seconds; Box sends it, Google does not. */
  readonly refreshTokenExpiresIn: number | null
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token_expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
})

const ErrorResponse = Schema.Struct({ error: Schema.String })

const decodeToken = Schema.decodeUnknownOption(TokenResponse)
const decodeError = Schema.decodeUnknownOption(ErrorResponse)

const failed = (
  step: ExchangeFailed['step'],
  status: number | null,
  message: string,
) => new ExchangeFailed({ step, status, message })

const readJson = (response: Response, step: ExchangeFailed['step']) =>
  Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () =>
      failed(step, response.status, 'The provider answered with no JSON'),
  })

export const exchangeCode = Effect.fn('exchangeCode')(function* (
  request: ExchangeRequest,
): Effect.fn.Return<TokenGrant, ExchangeFailed> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    code_verifier: request.verifier,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    client_secret: request.clientSecret,
  })
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(request.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      }),
    catch: () => failed('token', null, 'The token endpoint did not answer'),
  })
  const json = yield* readJson(response, 'token')
  if (!response.ok) {
    const error = Option.match(decodeError(json), {
      onNone: () => 'no error code',
      onSome: (e) => e.error,
    })
    return yield* failed(
      'token',
      response.status,
      `The provider refused the code exchange (${error})`,
    )
  }
  const decoded = decodeToken(json)
  if (Option.isNone(decoded))
    return yield* failed(
      'token',
      response.status,
      'The token response carried no access token',
    )
  const token = decoded.value
  return {
    bundle: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      tokenType: token.token_type ?? 'Bearer',
    },
    grantedWire:
      token.scope === undefined
        ? null
        : token.scope.split(' ').filter((s) => s !== ''),
    expiresIn: token.expires_in ?? null,
    refreshTokenExpiresIn: token.refresh_token_expires_in ?? null,
  }
})

export type ProviderAccount = {
  readonly externalAccountId: string
  readonly externalEmail: string
}

/** Google is OIDC (`sub`, `email`); Box is its own `users/me` (`id`, `login`). */
const GoogleAccount = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
})
const BoxAccount = Schema.Struct({ id: Schema.String, login: Schema.String })
const decodeGoogle = Schema.decodeUnknownOption(GoogleAccount)
const decodeBox = Schema.decodeUnknownOption(BoxAccount)

function accountOf(provider: ProviderId, json: unknown) {
  switch (provider) {
    case 'google':
      return Option.map(decodeGoogle(json), (a) => ({
        externalAccountId: a.sub,
        externalEmail: a.email,
      }))
    case 'box':
      return Option.map(decodeBox(json), (a) => ({
        externalAccountId: a.id,
        externalEmail: a.login,
      }))
  }
}

export const readAccount = Effect.fn('readAccount')(function* (
  provider: ProviderId,
  userinfoUrl: string,
  accessToken: string,
): Effect.fn.Return<ProviderAccount, ExchangeFailed> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(userinfoUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      }),
    catch: () =>
      failed('userinfo', null, 'The userinfo endpoint did not answer'),
  })
  if (!response.ok)
    return yield* failed(
      'userinfo',
      response.status,
      'The provider would not say whose account this is',
    )
  const account = accountOf(provider, yield* readJson(response, 'userinfo'))
  if (Option.isNone(account))
    return yield* failed(
      'userinfo',
      response.status,
      'The userinfo response named no account and email',
    )
  return account.value
})

/** Wire strings a provider answers with, mapped to the registry's `wire`. */
const GRANTED_ALIASES: Readonly<
  Record<ProviderId, Readonly<Record<string, string>>>
> = {
  // Google answers the `email` scope as its long form.
  google: { 'https://www.googleapis.com/auth/userinfo.email': 'email' },
  box: {},
}

/**
 * The registry `value`s a grant carries: the response's scopes mapped back
 * through `wire`, in registry order. A response with no `scope` granted
 * exactly what was asked (RFC 6749 §5.1). A wire string the registry does
 * not list is dropped.
 */
export function grantedScopes(
  provider: ProviderId,
  grantedWire: ReadonlyArray<string> | null,
  requested: ReadonlyArray<string>,
): Array<string> {
  const vocabulary: ReadonlyArray<ProviderScope> = PROVIDERS[provider].scopes
  if (grantedWire === null)
    return vocabulary
      .filter((s) => requested.includes(s.value))
      .map((s) => s.value)
  const aliases = GRANTED_ALIASES[provider]
  const granted = new Set(
    grantedWire.map((w) => (Object.hasOwn(aliases, w) ? aliases[w] : w)),
  )
  return vocabulary.filter((s) => granted.has(s.wire)).map((s) => s.value)
}
