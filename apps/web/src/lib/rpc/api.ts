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
import { MAX_CAPTURE_BYTES } from '@spaces/core/documents'
import { listRegistryProgram } from '#/lib/mcp/tools-read'
import { API_SCOPES } from '#/lib/tokens/scopes'
import type { ApiScope } from '#/lib/tokens/scopes'
import { authenticateTokenProgram } from '#/lib/tokens/store'
import { RECORD_PAGE_MAX, RECORD_PAGE_SIZE } from '#/lib/views/page-size'
import { captureProgram } from './capture'
import type { CaptureInput } from './capture'
import { getApiRecordProgram, listApiRecordsProgram } from './records'
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
 * | What happened                                        | Status | tag                               |
 * | ---------------------------------------------------- | ------ | --------------------------------- |
 * | A handler failed with a declared failure             | its own| the failure's                     |
 * | No bearer, or one that is malformed, unknown,        | 401    | `Unauthorized`                    |
 * | revoked, or whose user is banned — one message, so   |        |                                   |
 * | the answer never says whether the token exists       |        |                                   |
 * | A live token without the procedure's scope           | 403    | `Forbidden`                       |
 * | Params, query, headers or payload failed the schema  | 400    | `BadRequest`                      |
 * | The request could not be read at all                 | 400    | `BadRequest`                      |
 * | No procedure at that method and path                 | 404    | `NotFound`                        |
 * | A capture's target names no record the token's user  | 404    | `NotFound`                        |
 * | can see, or names several                            |        |                                   |
 * | A capture's `object` is not in the registry; the     | 400    | `BadRequest`                      |
 * | message names the slug and nothing was stored        |        |                                   |
 * | A capture's target will not take a document (a       | 400    | `BadRequest`                      |
 * | space, a document, a merged record) — birth's reason |        |                                   |
 * | A capture's `text` is over `MAX_CAPTURE_BYTES`; the  | 413    | `PayloadTooLarge`                 |
 * | limit is in the message and nothing was stored       |        |                                   |
 * | A capture's `captureSchemaVersion` is not in         | 422    | `UnsupportedCaptureSchemaVersion` |
 * | `ACCEPTED_CAPTURE_SCHEMA_VERSIONS`; the message says |        |                                   |
 * | "update the extension" and names the accepted ones   |        |                                   |
 * | Our own response failed its schema                   | 500    | `InternalError`                   |
 * | A defect, an interrupt, anything else                | 500    | `InternalError`                   |
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

/**
 * No such thing for this caller: an unknown object, or a record that does
 * not exist or that the token's user may not read — the two read the same,
 * so a private note's existence is never disclosed. The same tag the seam
 * answers for an unknown path.
 */
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  message: Schema.String,
}) {}

/** A capture's text is over `MAX_CAPTURE_BYTES` (SPA-111). */
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  'PayloadTooLarge',
  { message: Schema.String },
) {}

/**
 * A capture payload version this instance does not read (SPA-111): the
 * extension and the instance have drifted, and the answer is "update the
 * extension", never a schema error.
 */
export class UnsupportedCaptureSchemaVersion extends Schema.TaggedError<UnsupportedCaptureSchemaVersion>()(
  'UnsupportedCaptureSchemaVersion',
  { message: Schema.String },
) {}

const BadRequestWire = onTheWire('BadRequest', 400, BadRequest)
const PayloadTooLargeWire = onTheWire('PayloadTooLarge', 413, PayloadTooLarge)
const UnsupportedCaptureSchemaVersionWire = onTheWire(
  'UnsupportedCaptureSchemaVersion',
  422,
  UnsupportedCaptureSchemaVersion,
)
const NotFoundWire = onTheWire('NotFound', 404, NotFound)
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

/** A string that is not only whitespace. */
const NonBlank = Schema.String.check(
  Schema.makeFilter((s: string) => s.trim().length > 0 || 'must not be blank'),
)

/** An absolute http(s) address — the page the text was read from. */
const PageUrl = Schema.String.check(
  Schema.makeFilter((s: string) => {
    try {
      const { protocol } = new URL(s)
      return (
        protocol === 'http:' ||
        protocol === 'https:' ||
        'must be an http or https URL'
      )
    } catch {
      return 'must be an absolute URL'
    }
  }),
).annotate({ description: 'The address of the captured page' })

/** An instant, as `Date.parse` reads an ISO 8601 string. */
const Instant = Schema.String.check(
  Schema.makeFilter(
    (s: string) =>
      !Number.isNaN(Date.parse(s)) || 'must be an ISO 8601 date-time',
  ),
).annotate({ description: 'When the page was captured, ISO 8601' })

/**
 * The capture payload, v1 (SPA-111; CONTEXT.md integration map #8). The
 * shape an extension, a bookmarklet or curl posts.
 */
const CapturePayload = Schema.Struct({
  captureSchemaVersion: Schema.Int.annotate({
    description:
      'The payload version the client was built for; capture.hello answers the one this instance speaks',
  }),
  url: PageUrl,
  title: NonBlank.check(Schema.isMaxLength(400)).annotate({
    description: 'The page title; the document’s name',
  }),
  capturedAt: Instant,
  text: NonBlank.annotate({
    description: `The page’s visible text, stored as a text/plain blob; at most ${MAX_CAPTURE_BYTES} bytes of UTF-8`,
  }),
  target: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'A record id, or a record’s exact name, to file the capture on; omit to leave it unfiled',
    }),
  ),
  object: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The registry object the page describes — person for a profile, company for a company page, or any object’s slug — to read it against that object’s fields; omit to file the page unread. An object the registry does not hold is refused.',
    }),
  ),
})

const Captured = Schema.Struct({
  documentId: Schema.String,
  url: Schema.String.annotate({
    description:
      'Where the capture shows in the app: the record it was filed on, or the unfiled inbox',
  }),
  extraction: Schema.Literals(['queued', 'skipped']).annotate({
    description:
      'queued: the page will be read against the declared object and its suggestions land in the inbox. skipped: no object was declared, or no model is routed for the extract lane — the page is filed all the same.',
  }),
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
  .add(
    HttpApiEndpoint.post('capture', '/', {
      payload: CapturePayload,
      success: Captured,
      error: [
        ...SEAM_FAILURES,
        NotFoundWire,
        PayloadTooLargeWire,
        UnsupportedCaptureSchemaVersionWire,
      ],
    })
      .middleware(TokenAuth)
      .annotate(RequiredScope, 'capture:write')
      .annotateMerge(
        OpenApi.annotations({
          summary: 'Capture a page',
          description:
            'Files a page’s text as a document: a text/plain blob named by the title, with the page’s URL on the row, filed on the target record or left unfiled, extraction queued behind it. With `object` declared and the extract lane routed, the page is also read against that object’s fields and its suggestions land in the inbox, anchored on the page; `extraction` says whether that read was queued. Re-posting the same text to the same record answers the same document. Runs as the token’s user.',
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

/**
 * The read half of integration map #11 (SPA-80): the registry, then records
 * a page at a time, then one record — every one `records:read`, every one a
 * thin wrapper over a program the app already runs (`./records.ts` says
 * which). Three things are absent on purpose, each owned elsewhere, and
 * `records-api.test.ts` fails if one appears here: a filter parameter
 * (docsurf-12b's condition registry and ai-18), search (the fused query,
 * clean-5 and ai-11; MCP has it via ai-23b) and any write (ai-24's one
 * proposal door).
 */
const RegistryAttributeWire = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  type: Schema.String,
  isSystem: Schema.Boolean,
  target: Schema.NullOr(Schema.String),
  options: Schema.JsonObject,
})

const RegistryObjectWire = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  singular: Schema.String,
  plural: Schema.String,
  isSystem: Schema.Boolean,
  identityKeys: Schema.Array(Schema.String),
  attributes: Schema.Array(RegistryAttributeWire),
})

const Registry = Schema.Struct({ objects: Schema.Array(RegistryObjectWire) })

class RegistryGroup extends HttpApiGroup.make('registry').add(
  HttpApiEndpoint.get('list', '/registry', {
    success: Registry,
    error: SEAM_FAILURES,
  })
    .middleware(TokenAuth)
    .annotate(RequiredScope, 'records:read')
    .annotateMerge(
      OpenApi.annotations({
        summary: 'Every object and its attributes',
        description:
          'Every live object — companies, people, deals and each custom object — with its live attributes in registry order and their per-type config (select options, reference target, currency code). Read on every call: an object created a minute ago is listed. This is how a record’s `values`, keyed by attribute slug, are interpreted.',
      }),
    ),
) {}

/** A record's attribute values, keyed by the registry's attribute slug. */
const Values = Schema.Record(Schema.String, Schema.Json)

const RecordRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  values: Values,
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  emails: Schema.optionalKey(Schema.Array(Schema.String)),
})

const RecordPage = Schema.Struct({
  object: Schema.String,
  rows: Schema.Array(RecordRow),
  nextCursor: Schema.NullOr(Schema.String),
  total: Schema.Int,
})

const RecordWire = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  mergedFrom: Schema.NullOr(Schema.String),
  object: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      singular: Schema.String,
      plural: Schema.String,
    }),
  ),
  values: Values,
  links: Schema.Array(
    Schema.Struct({
      direction: Schema.Literals(['out', 'in']),
      relation: Schema.String,
      attrSlug: Schema.String,
      source: Schema.String,
      entity: Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        name: Schema.String,
      }),
    }),
  ),
  spaces: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
})

/**
 * A query value is a string on the wire; the description rides on that side
 * so the OpenAPI document states the bounds a caller is held to.
 */
const PageLimit = Schema.String.annotate({
  description: `Rows per page, an integer from 1 to ${RECORD_PAGE_MAX}; ${RECORD_PAGE_SIZE} when omitted`,
}).pipe(
  Schema.decodeTo(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: RECORD_PAGE_MAX }),
    ),
    SchemaTransformation.numberFromString,
  ),
)

class RecordsGroup extends HttpApiGroup.make('records')
  .add(
    HttpApiEndpoint.get('list', '/objects/:object/records', {
      params: { object: Schema.String },
      query: {
        cursor: Schema.optionalKey(
          Schema.String.annotate({
            description:
              'The previous page’s nextCursor, as it was handed out; omit for the first page',
          }),
        ),
        limit: Schema.optionalKey(PageLimit),
      },
      success: RecordPage,
      error: [...SEAM_FAILURES, NotFoundWire],
    })
      .middleware(TokenAuth)
      .annotate(RequiredScope, 'records:read')
      .annotateMerge(
        OpenApi.annotations({
          summary: 'One page of an object’s records',
          description:
            'The object by slug (or its singular or plural name). The same rows, in the same order, as the object’s list in the app with no view applied: newest first, keyset-paged on (created_at, id), so rows created or deleted while you page never repeat or skip another. Pass the previous page’s nextCursor to continue; null means the last page. No filter, search or sort parameter, by design.',
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get('get', '/records/:id', {
      params: { id: Schema.String },
      success: RecordWire,
      error: [...SEAM_FAILURES, NotFoundWire],
    })
      .middleware(TokenAuth)
      .annotate(RequiredScope, 'records:read')
      .annotateMerge(
        OpenApi.annotations({
          summary: 'One record',
          description:
            'Its object, its values keyed by attribute slug, its links both ways and the spaces it is tagged into — as the token’s user may see it. A record that user may not read is not found.',
        }),
      ),
  ) {}

export class Api extends HttpApi.make('spaces')
  .add(CaptureGroup)
  .add(SessionGroup)
  .add(RegistryGroup)
  .add(RecordsGroup)
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

/** The capture program's refusals, as the wire has them; the rest die (500). */
const captureFailure = (
  failure: Effect.Error<ReturnType<typeof captureProgram>>,
): Effect.Effect<
  never,
  UnsupportedCaptureSchemaVersion | PayloadTooLarge | NotFound | BadRequest
> => {
  switch (failure._tag) {
    case 'CaptureSchemaUnsupported':
      return Effect.fail(
        new UnsupportedCaptureSchemaVersion({ message: failure.message }),
      )
    case 'CaptureTooLarge':
      return Effect.fail(new PayloadTooLarge({ message: failure.message }))
    case 'CaptureTargetNotFound':
      return Effect.fail(new NotFound({ message: failure.message }))
    case 'CaptureTargetRefused':
    case 'CaptureObjectUnknown':
      return Effect.fail(new BadRequest({ message: failure.message }))
    case 'CaptureFailed':
      return Effect.die(failure)
  }
}

/** As the token's user: they are the actor, and canRead is theirs. */
const capture = Effect.fn('capture.capture')(function* (payload: CaptureInput) {
  const principal = yield* Principal
  return yield* captureProgram(principal.user, payload).pipe(
    Effect.catch(captureFailure),
  )
})

const CaptureHandlers = HttpApiBuilder.group(Api, 'capture', (handlers) =>
  handlers
    .handle('hello', () => hello)
    .handle('capture', ({ payload }) => capture(payload)),
).pipe(Layer.provide(TokenAuthLive))

/** The principal, as the wire has it. Nothing about the token but its grant. */
const me = Effect.gen(function* () {
  const principal = yield* Principal
  return { user: principal.user, scopes: principal.scopes }
}).pipe(Effect.withSpan('session.me'))

const SessionHandlers = HttpApiBuilder.group(Api, 'session', (handlers) =>
  handlers.handle('me', () => me),
).pipe(Layer.provide(TokenAuthLive))

const registry = listRegistryProgram({}).pipe(
  Effect.map((objects) => ({ objects })),
  Effect.orDie,
  Effect.withSpan('registry.list'),
)

const RegistryHandlers = HttpApiBuilder.group(Api, 'registry', (handlers) =>
  handlers.handle('list', () => registry),
).pipe(Layer.provide(TokenAuthLive))

/** An unknown object is 404, a foreign cursor 400; a query failure dies (500). */
const listFailure = (
  failure: Effect.Error<ReturnType<typeof listApiRecordsProgram>>,
): Effect.Effect<never, NotFound | BadRequest> =>
  failure._tag === 'McpToolRefused'
    ? Effect.fail(new NotFound({ message: failure.message }))
    : failure._tag === 'UnreadableCursor'
      ? Effect.fail(new BadRequest({ message: failure.message }))
      : Effect.die(failure)

const listRecords = Effect.fn('records.list')(function* (
  object: string,
  page: { readonly cursor?: string; readonly limit?: number },
) {
  return yield* listApiRecordsProgram(object, { ...page }).pipe(
    Effect.catch(listFailure),
  )
})

/** As the token's user: canRead is `getRecordProgram`'s own. */
const getRecord = Effect.fn('records.get')(function* (id: string) {
  const principal = yield* Principal
  return yield* getApiRecordProgram(principal.user, id).pipe(
    Effect.catchTag('McpToolRefused', (refused) =>
      Effect.fail(new NotFound({ message: refused.message })),
    ),
    Effect.catchTag('McpToolQueryFailed', (failure) => Effect.die(failure)),
  )
})

const RecordsHandlers = HttpApiBuilder.group(Api, 'records', (handlers) =>
  handlers
    .handle('list', ({ params, query }) => listRecords(params.object, query))
    .handle('get', ({ params }) => getRecord(params.id)),
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
    Layer.mergeAll(
      CaptureHandlers,
      SessionHandlers,
      RegistryHandlers,
      RecordsHandlers,
    ).pipe(Layer.provide(WebLayer)),
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
