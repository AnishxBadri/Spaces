import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  SchemaTransformation,
} from 'effect'
import {
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerResponse,
} from 'effect/unstable/http'
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiScalar,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from 'effect/unstable/httpapi'
import { API_SCOPES } from '#/lib/tokens/scopes'
import type { ApiScope } from '#/lib/tokens/scopes'
import { authenticateTokenProgram } from '#/lib/tokens/store'
import { WebLayer } from './runtime'
import { API_PREFIX, API_VERSION, CAPTURE_SCHEMA_VERSION } from './versions'

/**
 * The external API door (SPA-37; CONTEXT.md "Backend paradigm" decision 3 as
 * amended 2026-09-16, D8; one `/api/v1` namespace, D27).
 *
 * This file is the only one in the repo that imports `effect/unstable/httpapi`
 * — `one-door.test.ts` asserts it, and eslint keeps the package out of
 * `src/routes/**` and `src/components/**`. Everything the API is lives here:
 * the definition (`Api`), the handlers, the web handler the TanStack splat
 * route `src/routes/api/v1/$.ts` hands every method to, the typed client, and
 * the OpenAPI document at `/api/v1/openapi.json`. One definition, two
 * audiences: the HTTP caller and the typed client both go through `Api`.
 *
 * Procedures are Effect programs. Their services come from `WebLayer`
 * (`./runtime.ts`), provided once when the web handler is built — the same
 * closed-Layer shape `runJob` provides in the worker.
 *
 * Server-fns are untouched (decision 4: the boundary finds itself).
 *
 * ## Versioning — two clocks (SPA-45; `docs/api-versioning.md`)
 *
 * The path is the only version: `/api/v1`, `API_VERSION` in `./versions.ts`.
 * Within v1 every change is additive — a new procedure, a new optional input
 * field, a new output field. What forces v2 is anything a v1 caller could
 * trip on: a removed or renamed procedure, path or field; a narrowed type (a
 * wider input refused, an output that loses a case); a required input that
 * was optional; a changed status or error tag. v2 is a second `Api` under
 * `/api/v2`, with v1 still served beside it.
 *
 * `captureSchemaVersion` (`CAPTURE_SCHEMA_VERSION`) is the second clock, and
 * it lives inside v1 on purpose: the capture extension ships on its own
 * release cycle (CONTEXT.md integration map #8), so the shape of the capture
 * payload moves on its own. It moves when that payload's shape changes; the
 * API version does not move with it. `capture.hello` answers both, which is
 * how an installed extension tells "update me" from breakage.
 *
 * `openapi.test.ts` snapshots the whole document at `OPENAPI_PATH`: the
 * snapshot diff is the review of every change to the external contract.
 *
 * Manual check that a generated client can call the handshake (not a
 * dependency, not run in tests), against `pnpm dev`:
 *
 *     npx openapi-typescript http://localhost:3000/api/v1/openapi.json -o /tmp/spaces-api.d.ts
 *     curl -s http://localhost:3000/api/v1/capture/hello
 *
 * The docs UI is `HttpApiScalar`, served at `DOCS_PATH` from the bundled
 * script (no CDN). It is a page, not a procedure, and not part of the contract.
 *
 * ## Failures — one shape, one status per kind
 *
 * Every non-2xx answer from `/api/v1/*` has the body
 * `{ "error": { "tag": string, "message": string } }`, and never a stack.
 *
 * | What happened                                        | Status | tag             |
 * | ---------------------------------------------------- | ------ | --------------- |
 * | A handler failed with a declared failure             | its own| the failure's   |
 * | No bearer, or one that is malformed, unknown,        | 401    | `Unauthorized`  |
 * | revoked, or whose user is banned — one message, so   |        |                 |
 * | the answer never says whether the token exists       |        |                 |
 * | A live token without the procedure's scope           | 403    | `Forbidden`     |
 * | Params, query, headers or payload failed the schema  | 400    | `BadRequest`    |
 * | The request could not be read at all                 | 400    | `BadRequest`    |
 * | No procedure at that method and path                 | 404    | `NotFound`      |
 * | Our own response failed its schema                   | 500    | `InternalError` |
 * | A defect, an interrupt, anything else                | 500    | `InternalError` |
 *
 * A declared failure is a `Schema.TaggedError` with a `message`, carried on
 * the wire through `onTheWire` below, which is what gives it its status and
 * its envelope — so the typed client decodes the same body back into the
 * same class. Everything else never reaches a handler's error channel; the
 * seam (`web` below) catches it at the router and renders it with
 * `failureOf`. The 500 message is fixed ("Internal error"): the cause is
 * logged on the server, and nothing about it is sent.
 *
 * ## Authentication — one personal-token store, scoped (SPA-48)
 *
 * A procedure that needs a caller carries the `TokenAuth` middleware and
 * declares the scope it requires as the `RequiredScope` annotation (`null`
 * for "any live token"). The credential is `Authorization: Bearer <token>`,
 * the same `api_token` rows the MCP server reads — one store, minted once in
 * Settings → API tokens, not a second credential. `authorize` below hashes
 * the token, finds the row, compares the digests in constant time
 * (`lib/tokens/store.ts`), refuses 401 or 403 per the table, and otherwise
 * puts the token's user and grant in the procedure's context as `Principal`.
 * A procedure then runs as that user — canRead and all. A token is an
 * identity, never an escalation: a scope can only narrow what the user could
 * already do. The token itself is never logged and never answered.
 */

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export interface FailureBody {
  readonly error: { readonly tag: string; readonly message: string }
}

/** The one error shape. Both the declared failures and the middleware use it. */
export const failureBody = (tag: string, message: string): FailureBody => ({
  error: { tag, message },
})

export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', {
  message: Schema.String,
}) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  'InternalError',
  { message: Schema.String },
) {}

const INTERNAL_MESSAGE = 'Internal error'

/**
 * A declared failure's wire form: the envelope decoded into the error class,
 * with its HTTP status. The class's own encoding is `{ _tag, message }`; this
 * is what turns it into `{ error: { tag, message } }` on the way out and back
 * again in the typed client.
 */
const onTheWire = <TTag extends string, TSelf>(
  tag: TTag,
  status: number,
  errorClass: Schema.Codec<
    TSelf,
    { readonly _tag: TTag; readonly message: string }
  >,
) =>
  Schema.Struct({
    error: Schema.Struct({ tag: Schema.Literal(tag), message: Schema.String }),
  }).pipe(
    Schema.decodeTo(
      errorClass,
      SchemaTransformation.transform({
        decode: (wire) => ({ _tag: tag, message: wire.error.message }),
        encode: (encoded) => ({
          error: { tag: encoded._tag, message: encoded.message },
        }),
      }),
    ),
    HttpApiSchema.status(status),
  )

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  { message: Schema.String },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', {
  message: Schema.String,
}) {}

const BadRequestWire = onTheWire('BadRequest', 400, BadRequest)
const InternalErrorWire = onTheWire('InternalError', 500, InternalError)
const UnauthorizedWire = onTheWire('Unauthorized', 401, Unauthorized)
const ForbiddenWire = onTheWire('Forbidden', 403, Forbidden)

/**
 * What the seam can answer for any procedure, whatever its handler declares:
 * its request failed the schema, or something broke. Declared on every
 * endpoint so the OpenAPI document and the typed client both know them.
 */
const SEAM_FAILURES = [BadRequestWire, InternalErrorWire] as const

export interface Failure {
  readonly status: number
  readonly tag: string
  readonly message: string
}

/**
 * Everything the router lets escape, as a status and the one shape. Pure, so
 * the table above is tested row by row without having to break a handler.
 */
export function failureOf(cause: Cause.Cause<unknown>): Failure {
  const error = Cause.squash(cause)
  if (HttpServerError.isHttpServerError(error)) {
    const reason = error.reason
    if (reason._tag === 'RouteNotFound') {
      return {
        status: 404,
        tag: 'NotFound',
        message: `No procedure at ${reason.request.method} ${reason.request.url}`,
      }
    }
    if (reason._tag === 'RequestParseError') {
      return {
        status: 400,
        tag: 'BadRequest',
        message: 'The request could not be read',
      }
    }
  }
  if (HttpApiError.HttpApiSchemaError.is(error)) {
    // Body and ResponseHeaders are *our* response failing its own schema —
    // a bug here, not a bad request there.
    if (error.kind === 'Body' || error.kind === 'ResponseHeaders') {
      return { status: 500, tag: 'InternalError', message: INTERNAL_MESSAGE }
    }
    return {
      status: 400,
      tag: 'BadRequest',
      message: `${error.kind} did not match the schema: ${error.cause.message}`,
    }
  }
  return { status: 500, tag: 'InternalError', message: INTERNAL_MESSAGE }
}

/**
 * Whatever escapes routing, decoding or a handler becomes the envelope. A
 * 500's cause is logged here, on the server, and only here.
 */
const renderFailure = (cause: Cause.Cause<unknown>) => {
  const failure = failureOf(cause)
  const response = HttpServerResponse.jsonUnsafe(
    failureBody(failure.tag, failure.message),
    { status: failure.status },
  )
  return failure.status >= 500
    ? Effect.as(
        Effect.logError('[api] request failed', Cause.pretty(cause)),
        response,
      )
    : Effect.succeed(response)
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * The one 401 message. Absent, malformed, unknown, revoked and banned all
 * read the same, so a caller cannot tell a token that never existed from
 * one that stopped working.
 */
export const UNAUTHORIZED_MESSAGE = 'Unauthorized'

/** Who is calling: the token's user, and what the token was granted. */
export interface PrincipalShape {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
  }
  readonly tokenId: string
  readonly scopes: ReadonlyArray<ApiScope>
}

export class Principal extends Context.Service<Principal, PrincipalShape>()(
  'spaces/api/Principal',
) {}

/**
 * The scope an authenticated procedure requires, as an endpoint annotation:
 * an `ApiScope`, or `null` for any live token. An endpoint that carries
 * `TokenAuth` and forgets this does not fall open — `authorize` treats it as
 * a defect and the seam answers 500.
 */
class RequiredScope extends Context.Service<RequiredScope, ApiScope | null>()(
  'spaces/api/RequiredScope',
) {}

export class TokenAuth extends HttpApiMiddleware.Service<
  TokenAuth,
  { provides: Principal }
>()('spaces/api/TokenAuth', {
  security: { bearer: HttpApiSecurity.bearer },
  error: [UnauthorizedWire, ForbiddenWire],
}) {}

/**
 * The bearer credential and the procedure's declared scope in, the
 * principal out — or 401, or 403. A store that cannot answer is a defect
 * (500), never a pass.
 */
const authorize = Effect.fn('api.authorize')(function* (
  credential: Redacted.Redacted<string>,
  endpoint: HttpApiEndpoint.Top,
): Effect.fn.Return<PrincipalShape, Unauthorized | Forbidden> {
  const required = Context.getOption(endpoint.annotations, RequiredScope)
  if (Option.isNone(required))
    return yield* Effect.die(
      `api: ${endpoint.name} carries TokenAuth but declares no RequiredScope`,
    )
  const token = yield* authenticateTokenProgram(
    Redacted.value(credential),
  ).pipe(
    Effect.catchTag('ApiTokenUnauthorized', () =>
      Effect.fail(new Unauthorized({ message: UNAUTHORIZED_MESSAGE })),
    ),
    Effect.catchTag('ApiTokenQueryFailed', (failure) => Effect.die(failure)),
  )
  const scope = required.value
  if (scope !== null && !token.scopes.includes(scope))
    return yield* new Forbidden({
      message: `This token does not hold the ${scope} scope`,
    })
  return {
    user: { id: token.id, name: token.name, email: token.email },
    tokenId: token.tokenId,
    scopes: token.scopes,
  }
})

const TokenAuthLive = Layer.succeed(
  TokenAuth,
  TokenAuth.of({
    bearer: (httpEffect, { credential, endpoint }) =>
      Effect.flatMap(authorize(credential, endpoint), (principal) =>
        Effect.provideService(httpEffect, Principal, principal),
      ),
  }),
)

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * The version handshake. Unauthenticated on purpose: it is what an installed
 * capture extension calls before it knows whether its token or its payload
 * are still any good, so it owes nothing to either.
 */
const Hello = Schema.Struct({
  apiVersion: Schema.Int,
  captureSchemaVersion: Schema.Int,
})

class CaptureGroup extends HttpApiGroup.make('capture')
  .add(
    HttpApiEndpoint.get('hello', '/hello', {
      success: Hello,
      error: SEAM_FAILURES,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Version handshake',
        description:
          'The API version (the v in /api/v1) and the capture payload schema version, so a client can tell "update me" from breakage.',
      }),
    ),
  )
  .prefix('/capture') {}

/**
 * Who the token is. Any live token, no scope: it is how the capture
 * extension's settings screen says "connected to <instance> as <user>", and
 * how anyone checks a token still works.
 */
const Me = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
  }),
  scopes: Schema.Array(Schema.Literals(API_SCOPES)),
})

class SessionGroup extends HttpApiGroup.make('session').add(
  HttpApiEndpoint.get('me', '/me', {
    success: Me,
    error: SEAM_FAILURES,
  })
    .middleware(TokenAuth)
    .annotate(RequiredScope, null)
    .annotateMerge(
      OpenApi.annotations({
        summary: 'The token’s user and scopes',
        description:
          'Answers for any live token, whatever its scopes. 401 for anything else, with no hint why.',
      }),
    ),
) {}

export class Api extends HttpApi.make('spaces')
  .add(CaptureGroup)
  .add(SessionGroup)
  .prefix(API_PREFIX)
  .annotateMerge(
    OpenApi.annotations({ title: 'Spaces', version: String(API_VERSION) }),
  ) {}

/** Served beside the procedures; `openapi.test.ts` pins its contents. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const

/** The Scalar reference page over the same document. */
export const DOCS_PATH = `${API_PREFIX}/docs` as const

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const hello = Effect.succeed({
  apiVersion: API_VERSION,
  captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
}).pipe(Effect.withSpan('capture.hello'))

const CaptureHandlers = HttpApiBuilder.group(Api, 'capture', (handlers) =>
  handlers.handle('hello', () => hello),
)

/** The principal, as the wire has it. Nothing about the token but its grant. */
const me = Effect.gen(function* () {
  const principal = yield* Principal
  return { user: principal.user, scopes: principal.scopes }
}).pipe(Effect.withSpan('session.me'))

const SessionHandlers = HttpApiBuilder.group(Api, 'session', (handlers) =>
  handlers.handle('me', () => me),
).pipe(Layer.provide(TokenAuthLive))

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

const ApiRoutes = Layer.merge(
  HttpApiBuilder.layer(Api, { openapiPath: OPENAPI_PATH }),
  // No default fonts: they load from fonts.scalar.com, and a self-hosted
  // instance's docs page should not call a third party.
  HttpApiScalar.layer(Api, {
    path: DOCS_PATH,
    scalar: { withDefaultFonts: false },
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(CaptureHandlers, SessionHandlers).pipe(
      Layer.provide(WebLayer),
    ),
  ),
)

/**
 * Routes in, a web handler out, with the envelope as the only way out.
 * `HttpRouter.toWebHandler` is this plus a request logger, minus the catch —
 * its router middleware may not swallow errors it was not configured for,
 * and this seam's whole job is that nothing leaves it except the envelope.
 */
const webHandlerOf = (routes: typeof ApiRoutes) =>
  HttpEffect.toWebHandlerLayerWith(
    Layer.provideMerge(
      routes.pipe(Layer.provide(HttpServer.layerServices)),
      HttpRouter.layer,
    ),
    {
      toHandler: (context) =>
        Effect.succeed(
          Effect.catchCause(
            Context.get(context, HttpRouter.HttpRouter).asHttpEffect(),
            renderFailure,
          ),
        ),
    },
  )

/**
 * Built once for the life of the process, on the first request: this is
 * where `WebLayer` is provided, and nowhere else.
 */
const web = webHandlerOf(ApiRoutes)

/** The whole of `/api/v1/*`: a web `Request` in, a web `Response` out. */
export const handleApiRequest = (request: Request): Promise<Response> =>
  web.handler(request)

/**
 * The typed client over the same definition. It needs an `HttpClient`; the
 * caller picks the transport — `FetchHttpClient.layer` for a remote instance,
 * or a `Fetch` that calls `handleApiRequest` for the in-process test. With a
 * token, every request carries it as the bearer; without one, only the
 * unauthenticated procedures answer.
 */
export const makeApiClient = (baseUrl: string, token?: string) =>
  HttpApiClient.make(
    Api,
    token === undefined
      ? { baseUrl }
      : {
          baseUrl,
          transformClient: (client: HttpClient.HttpClient) =>
            HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)),
        },
  )

export type ApiClient = HttpApiClient.ForApi<typeof Api>

// ---------------------------------------------------------------------------
// The scope probe
// ---------------------------------------------------------------------------

/**
 * One procedure that requires `capture:write`, behind the same `TokenAuth`
 * and the same seam, and answering the principal it was handed. It is never
 * mounted — not under `/api/v1/$`, not in the OpenAPI document, and not in
 * `Api` — so it is no part of the external contract. It exists because
 * SPA-48 pins a scope refusal before any mounted procedure requires a scope:
 * the first is api-4's `/api/capture`, and when it lands its own test takes
 * this proof over and the probe goes.
 */
class ProbeApi extends HttpApi.make('scope-probe')
  .add(
    HttpApiGroup.make('probe').add(
      HttpApiEndpoint.get('captureWrite', '/probe/capture-write', {
        success: Me,
        error: SEAM_FAILURES,
      })
        .middleware(TokenAuth)
        .annotate(RequiredScope, 'capture:write'),
    ),
  )
  .prefix(API_PREFIX) {}

const ProbeHandlers = HttpApiBuilder.group(ProbeApi, 'probe', (handlers) =>
  handlers.handle('captureWrite', () => me),
).pipe(Layer.provide(TokenAuthLive))

const probe = webHandlerOf(
  HttpApiBuilder.layer(ProbeApi).pipe(Layer.provide(ProbeHandlers)),
)

/** Where the probe answers, for the test that calls it. */
export const SCOPE_PROBE_PATH = `${API_PREFIX}/probe/capture-write` as const

/** The probe's handler: a web `Request` in, a web `Response` out. */
export const handleScopeProbeRequest = (request: Request): Promise<Response> =>
  probe.handler(request)
