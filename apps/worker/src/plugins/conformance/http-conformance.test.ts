import { randomUUID } from 'node:crypto'
import { Effect, Exit } from 'effect'
import type { Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { HttpLive } from '@spaces/core/writes/ports/http'
import { Http } from '@spaces/sdk'
import { HttpTest } from '@spaces/sdk/testing'
import type { HttpScript } from '@spaces/sdk/testing'
import { exitOn, failureOf } from './support'

/**
 * The Http port's contract, over every implementation: what a job may rely
 * on whichever Layer it runs on.
 *
 * - Any status but 429 comes back as a response, headers lower-cased.
 * - A 429 never reaches the job as a response: it is waited out and retried
 *   (live), or failed `JobRateLimited` carrying the provider's wait.
 */

type Scripted = {
  readonly status: number
  readonly headers?: { readonly [name: string]: string }
  readonly body: string
}

type HttpImplementation = {
  readonly name: string
  /** A port whose provider answers `url` with `script`, in order. */
  readonly make: (
    url: string,
    script: ReadonlyArray<Scripted>,
  ) => Layer.Layer<Http>
}

const IMPLEMENTATIONS: ReadonlyArray<HttpImplementation> = [
  {
    name: 'HttpLive',
    make: (url, script) => {
      const pending = [...script]
      return HttpLive({
        // Its own throttle: the per-process state is keyed by the row.
        integrationId: randomUUID(),
        pluginId: 'conformance',
        fetch: (requested) => {
          const next = pending.shift()
          if (requested !== url || next === undefined)
            return Promise.reject(new Error(`unscripted ${requested}`))
          return Promise.resolve(
            new Response(next.body, {
              status: next.status,
              headers: { ...next.headers },
            }),
          )
        },
      })
    },
  },
  {
    name: 'HttpTest',
    make: (url, script) =>
      HttpTest(
        script.map((s): HttpScript => ({
          method: 'GET',
          url,
          response: {
            status: s.status,
            ...(s.headers === undefined ? {} : { headers: s.headers }),
            body: s.body,
          },
        })),
      ).layer,
  },
]

const PROVIDER_URL =
  'https://provider.example/v1/organizations?domain=acme.example'

const get = Effect.gen(function* () {
  return yield* (yield* Http).request({ method: 'GET', url: PROVIDER_URL })
})

describe.each(IMPLEMENTATIONS)('Http — $name', (impl) => {
  it('hands back a 200 with its status, its body and lower-cased header names', async () => {
    const exit = await exitOn(
      impl.make(PROVIDER_URL, [
        { status: 200, headers: { 'X-Request-Id': 'r-1' }, body: '{"ok":1}' },
      ]),
      get,
    )
    if (!Exit.isSuccess(exit)) throw new Error('expected a response')
    expect(exit.value.status).toBe(200)
    expect(exit.value.body).toBe('{"ok":1}')
    expect(exit.value.headers['x-request-id']).toBe('r-1')
  })

  it.each([404, 402, 500, 503])(
    'hands back a %i as a response for the job to judge',
    async (status) => {
      const exit = await exitOn(
        impl.make(PROVIDER_URL, [{ status, body: '{"error":"no"}' }]),
        get,
      )
      if (!Exit.isSuccess(exit)) throw new Error('expected a response')
      expect(exit.value.status).toBe(status)
    },
  )

  it('never hands a job a 429: it is retried, or failed JobRateLimited', async () => {
    const exit = await exitOn(
      impl.make(PROVIDER_URL, [
        { status: 429, headers: { 'Retry-After': '0' }, body: '' },
        { status: 200, body: '{"ok":1}' },
      ]),
      get,
    )
    if (Exit.isSuccess(exit)) expect(exit.value.status).toBe(200)
    else expect(failureOf(exit)?._tag).toBe('JobRateLimited')
  })

  it('fails a 429 that persists JobRateLimited, carrying the wait the provider asked', async () => {
    const limited = { status: 429, headers: { 'Retry-After': '1' }, body: '' }
    const failure = failureOf(
      await exitOn(impl.make(PROVIDER_URL, [limited, limited]), get),
    )
    expect(failure?._tag).toBe('JobRateLimited')
    const wait =
      failure !== null && 'retryAfterMs' in failure ? failure.retryAfterMs : -1
    expect(wait).toBeGreaterThanOrEqual(900)
    expect(wait).toBeLessThanOrEqual(1000)
  })

  it('streams a body as its bytes, and fails a 429 that persists the same way', async () => {
    const stream = Effect.gen(function* () {
      const response = yield* (yield* Http).stream({
        method: 'GET',
        url: PROVIDER_URL,
      })
      const text = yield* Effect.promise(() =>
        new Response(response.body).text(),
      )
      return { status: response.status, text }
    })
    const exit = await exitOn(
      impl.make(PROVIDER_URL, [{ status: 200, body: 'PK bytes' }]),
      stream,
    )
    expect(exit).toEqual(Exit.succeed({ status: 200, text: 'PK bytes' }))
    const limited = { status: 429, headers: { 'Retry-After': '1' }, body: '' }
    const failure = failureOf(
      await exitOn(impl.make(PROVIDER_URL, [limited, limited]), stream),
    )
    expect(failure?._tag).toBe('JobRateLimited')
  })
})
