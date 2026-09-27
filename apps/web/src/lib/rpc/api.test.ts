import { Cause, Effect } from 'effect'
import {
  FetchHttpClient,
  HttpServerError,
  HttpServerRequest,
} from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from './api'
import {
  BadRequest,
  InternalError,
  OPENAPI_PATH,
  failureBody,
  failureOf,
  handleApiRequest,
  makeApiClient,
} from './api'
import { API_VERSION, CAPTURE_SCHEMA_VERSION } from './versions'

/**
 * The door, end to end, with no server started: `handleApiRequest` is the
 * function the `/api/v1/$` route hands every request to, so a `Request` in
 * here is the same thing a curl against a running instance sends.
 */

const ORIGIN = 'http://spaces.test'
const HELLO = `${ORIGIN}/api/v1/capture/hello`

/** A `fetch` that never leaves the process: the mounted handler itself. */
const inProcess: typeof globalThis.fetch = (input, init) =>
  handleApiRequest(new Request(input, init))

/** The typed client over `Api`, its transport the given fetch. */
const withClient = <TValue, TError>(
  fetch: typeof globalThis.fetch,
  use: (client: ApiClient) => Effect.Effect<TValue, TError>,
) =>
  Effect.runPromise(
    Effect.flatMap(makeApiClient(ORIGIN), use).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  )

/** A transport that answers every request with one canned response. */
const answering =
  (status: number, body: unknown): typeof globalThis.fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

describe('capture.hello over HTTP', () => {
  it('answers the API version and the capture schema version, unauthenticated', async () => {
    const response = await handleApiRequest(new Request(HELLO))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      apiVersion: API_VERSION,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    })
  })

  it('lives under the one /api/v1 namespace (D27)', () => {
    expect(new URL(HELLO).pathname.startsWith(`/api/v${API_VERSION}/`)).toBe(
      true,
    )
  })
})

describe('one definition, two audiences', () => {
  // SPA-45: the same procedure over both handlers — the typed transport
  // (`makeApiClient`) and plain REST (`handleApiRequest`, what curl and a
  // client generated from the OpenAPI document call) — compared byte for byte.
  it('typed client and REST answer the handshake byte-identically', async () => {
    const overHttp = await (await handleApiRequest(new Request(HELLO))).text()
    const viaClient = await withClient(inProcess, (client) =>
      client.capture.hello(),
    )
    expect(JSON.stringify(viaClient)).toBe(overHttp)
    expect(viaClient).toEqual({
      apiVersion: API_VERSION,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    })
  })

  it('serves the OpenAPI document of that definition', async () => {
    const response = await handleApiRequest(
      new Request(`${ORIGIN}${OPENAPI_PATH}`),
    )
    expect(response.status).toBe(200)
    const doc: unknown = await response.json()
    expect(doc).toMatchObject({
      paths: { '/api/v1/capture/hello': { get: expect.anything() } },
    })
  })
})

describe('failures — one shape, never a stack', () => {
  it('an unknown path is a 404 in the envelope', async () => {
    const response = await handleApiRequest(
      new Request(`${ORIGIN}/api/v1/capture/nope`),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(
      failureBody('NotFound', 'No procedure at GET /api/v1/capture/nope'),
    )
  })

  it('a method the procedure does not take is a 404 in the envelope', async () => {
    const response = await handleApiRequest(
      new Request(HELLO, { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(404)
    const body: unknown = await response.json()
    expect(body).toMatchObject({ error: { tag: 'NotFound' } })
  })

  it('a defect is a 500 with a fixed message and nothing of the cause', () => {
    const boom = new Error('secret detail')
    const failure = failureOf(Cause.die(boom))
    expect(failure).toEqual({
      status: 500,
      tag: 'InternalError',
      message: 'Internal error',
    })
    expect(JSON.stringify(failure)).not.toContain('secret detail')
  })

  it('an interrupt is a 500 too', () => {
    expect(failureOf(Cause.interrupt()).status).toBe(500)
  })

  it('a request that could not be read is a 400', () => {
    const request = HttpServerRequest.fromWeb(new Request(HELLO))
    const cause = Cause.fail(
      new HttpServerError.HttpServerError({
        reason: new HttpServerError.RequestParseError({ request }),
      }),
    )
    expect(failureOf(cause)).toMatchObject({ status: 400, tag: 'BadRequest' })
  })

  it('the typed client decodes the 500 envelope back into InternalError', async () => {
    const error = await withClient(
      answering(500, failureBody('InternalError', 'Internal error')),
      (client) => Effect.flip(client.capture.hello()),
    )
    expect(error).toBeInstanceOf(InternalError)
    expect(error).toMatchObject({ message: 'Internal error' })
  })

  it('the typed client decodes the 400 envelope back into BadRequest', async () => {
    const error = await withClient(
      answering(400, failureBody('BadRequest', 'Query did not match')),
      (client) => Effect.flip(client.capture.hello()),
    )
    expect(error).toBeInstanceOf(BadRequest)
    expect(error).toMatchObject({ message: 'Query did not match' })
  })
})
