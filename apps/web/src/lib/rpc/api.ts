import {
  Cause,
  Context,
  Effect,
  Layer,
  Schema,
  SchemaTransformation,
} from 'effect'
import {
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
  HttpApiSchema,
  OpenApi,
} from 'effect/unstable/httpapi'
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
 * ## Failures — one shape, one status per kind
 *
 * Every non-2xx answer from `/api/v1/*` has the body
 * `{ "error": { "tag": string, "message": string } }`, and never a stack.
 *
 * | What happened                                        | Status | tag             |
 * | ---------------------------------------------------- | ------ | --------------- |
 * | A handler failed with a declared failure             | its own| the failure's   |
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

const BadRequestWire = onTheWire('BadRequest', 400, BadRequest)
const InternalErrorWire = onTheWire('InternalError', 500, InternalError)

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

export class Api extends HttpApi.make('spaces')
  .add(CaptureGroup)
  .prefix(API_PREFIX)
  .annotateMerge(
    OpenApi.annotations({ title: 'Spaces', version: String(API_VERSION) }),
  ) {}

/** Served beside the procedures; SPA-45 is what pins its contents. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const

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

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: OPENAPI_PATH,
}).pipe(Layer.provide(CaptureHandlers.pipe(Layer.provide(WebLayer))))

/**
 * Built once for the life of the process, on the first request: this is
 * where `WebLayer` is provided, and nowhere else. `HttpRouter.toWebHandler`
 * is this plus a request logger, minus the catch — its router middleware may
 * not swallow errors it was not configured for, and this seam's whole job is
 * that nothing leaves it except the envelope.
 */
const web = HttpEffect.toWebHandlerLayerWith(
  Layer.provideMerge(
    ApiRoutes.pipe(Layer.provide(HttpServer.layerServices)),
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

/** The whole of `/api/v1/*`: a web `Request` in, a web `Response` out. */
export const handleApiRequest = (request: Request): Promise<Response> =>
  web.handler(request)

/**
 * The typed client over the same definition. It needs an `HttpClient`; the
 * caller picks the transport — `FetchHttpClient.layer` for a remote instance,
 * or a `Fetch` that calls `handleApiRequest` for the in-process test.
 */
export const makeApiClient = (baseUrl: string) =>
  HttpApiClient.make(Api, { baseUrl })

export type ApiClient = HttpApiClient.ForApi<typeof Api>
