import { Effect, Option, Schema } from 'effect'
import { PROVIDERS } from '../../providers/registry'
import type { ProviderId, ProviderScope } from '../../providers/registry'
import type { TokenBundle } from './bundle'

/**
 * The provider half of a connection: the authorization code traded for
 * tokens at the registry's `tokenUrl`, a refresh token traded for fresh ones
 * there, and the account read from its `userinfoUrl`.
 * - The client authenticates in the form body (`client_secret_post`); the
 *   code exchange always sends the PKCE `code_verifier`.
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

/** The provider refused the refresh token: the grant is gone. */
export class RefreshRefused extends Schema.TaggedError<RefreshRefused>()(
  'RefreshRefused',
  {
    status: Schema.Number,
    /** The provider's `error`, e.g. `invalid_grant`. */
    error: Schema.String,
    /** The provider's `error_description`, when it sent one. */
    description: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

/** No answer, a 5xx, a 429, or an answer naming no error: try again later. */
export class RefreshUnavailable extends Schema.TaggedError<RefreshUnavailable>()(
  'RefreshUnavailable',
  {
    /** The provider's HTTP status; null when it never answered. */
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

/** A provider endpoint that never answered. */
export class NoAnswer extends Schema.TaggedError<NoAnswer>()('NoAnswer', {
  message: Schema.String,
}) {}

export type ExchangeRequest = {
  readonly tokenUrl: string
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
  readonly clientId: string
  readonly clientSecret: string
}

export type RefreshRequest = {
  readonly tokenUrl: string
  readonly refreshToken: string
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

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})

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

/** A provider's answer to a form POST; `json` is null when the body is none. */
export type FormAnswer = {
  readonly status: number
  readonly ok: boolean
  readonly json: unknown
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

/** POSTs a form to a provider endpoint. Fails only when nothing answered. */
export const postForm = Effect.fn('postForm')(function* (
  url: string,
  form: URLSearchParams,
): Effect.fn.Return<FormAnswer, NoAnswer> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
      }),
    catch: () => new NoAnswer({ message: 'The provider did not answer' }),
  })
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new NoAnswer({ message: 'The provider dropped its answer' }),
  })
  return { status: response.status, ok: response.ok, json: parseJson(text) }
})

/** The provider's `error` and `error_description`, when the body names one. */
export function providerError(
  json: unknown,
): { error: string; description: string | null } | null {
  return Option.match(decodeError(json), {
    onNone: () => null,
    onSome: (e) => ({
      error: e.error,
      description: e.error_description ?? null,
    }),
  })
}

function grantOf(json: unknown): Option.Option<TokenGrant> {
  return Option.map(decodeToken(json), (token) => ({
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
  }))
}

export const exchangeCode = Effect.fn('exchangeCode')(function* (
  request: ExchangeRequest,
): Effect.fn.Return<TokenGrant, ExchangeFailed> {
  const answer = yield* postForm(
    request.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: request.code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      client_secret: request.clientSecret,
    }),
  ).pipe(
    Effect.mapError(() =>
      failed('token', null, 'The token endpoint did not answer'),
    ),
  )
  if (answer.json === null)
    return yield* failed(
      'token',
      answer.status,
      'The provider answered with no JSON',
    )
  if (!answer.ok) {
    const error = providerError(answer.json)?.error ?? 'no error code'
    return yield* failed(
      'token',
      answer.status,
      `The provider refused the code exchange (${error})`,
    )
  }
  const grant = grantOf(answer.json)
  if (Option.isNone(grant))
    return yield* failed(
      'token',
      answer.status,
      'The token response carried no access token',
    )
  return grant.value
})

/**
 * Trades a refresh token for fresh tokens (`grant_type=refresh_token`).
 * - A 4xx naming an error (429 aside) is `RefreshRefused`: the grant is gone.
 * - Anything else short of a token is `RefreshUnavailable`.
 * - `bundle.refreshToken` is null when the provider did not rotate it.
 */
export const refreshGrant = Effect.fn('refreshGrant')(function* (
  request: RefreshRequest,
): Effect.fn.Return<TokenGrant, RefreshRefused | RefreshUnavailable> {
  const answer = yield* postForm(
    request.tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: request.refreshToken,
      client_id: request.clientId,
      client_secret: request.clientSecret,
    }),
  ).pipe(
    Effect.mapError(
      (e) => new RefreshUnavailable({ status: null, message: e.message }),
    ),
  )
  if (!answer.ok) {
    const named = providerError(answer.json)
    if (
      named !== null &&
      answer.status >= 400 &&
      answer.status < 500 &&
      answer.status !== 429
    )
      return yield* new RefreshRefused({
        status: answer.status,
        error: named.error,
        description: named.description,
        message: `The provider refused the refresh (${named.error})`,
      })
    return yield* new RefreshUnavailable({
      status: answer.status,
      message: `The token endpoint answered ${String(answer.status)}`,
    })
  }
  const grant = grantOf(answer.json)
  if (Option.isNone(grant))
    return yield* new RefreshUnavailable({
      status: answer.status,
      message: 'The refresh response carried no access token',
    })
  return grant.value
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
