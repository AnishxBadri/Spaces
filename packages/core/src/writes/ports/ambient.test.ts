import { Effect, Exit, Fiber, Layer, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { Http, Log, Secrets, configOf } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { redact } from '../vault/crypto'
import { storeCredential } from '../vault/index'
import { AmbientPortsLive } from './ambient'
import { makeScrub } from './binding'
import type { BoundIntegration } from './binding'
import { ConfigLive } from './config'
import { HttpLive } from './http'
import type { FetchLike } from './http'
import { LogLive } from './log'
import type { LogLevel } from './log'

/**
 * The four ambient ports bound to one integration row (sdk-6a). The Http
 * tests drive time with `TestClock` and stand a fake server in for fetch:
 * it records the clock's time at each request it receives and answers from
 * a script.
 *
 * That the ports read no environment is `src/purity.test.ts`'s to enforce:
 * `writes/ports/` is not one of the two directories it lets read it.
 */

const settings = z.object({
  greeting: z.string().default('hello'),
  times: z.int().min(1).max(3).default(1),
})
const manifest = { id: 'echo', settings } as const

const bound = (over: Partial<BoundIntegration> = {}): BoundIntegration => ({
  id: crypto.randomUUID(),
  capabilityId: 'echo',
  config: {},
  credentialId: null,
  ...over,
})

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

/** A scripted fake server: each request takes the next answer. */
const fakeServer = (
  script: ReadonlyArray<{
    status?: number
    headers?: Record<string, string>
    body?: string
  }>,
) => {
  const received: Array<{
    url: string
    at: number
    headers: Record<string, string>
  }> = []
  let now = () => 0
  const fetch: FetchLike = (url, init) => {
    const answer = script.at(Math.min(received.length, script.length - 1)) ?? {}
    received.push({ url, at: now(), headers: init.headers })
    return Promise.resolve(
      new Response(answer.body ?? '{}', {
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
      }),
    )
  }
  return {
    fetch,
    received,
    /** Read time from the test's clock. */
    clock: (read: () => number) => {
      now = read
    },
  }
}

/** Let the fake server's promises settle between clock moves. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve)),
).pipe(Effect.repeat({ times: 4 }))

/** Run with a TestClock the fake server reads from. */
const withClock = <TValue, TError>(
  server: ReturnType<typeof fakeServer>,
  program: Effect.Effect<TValue, TError, Http>,
  layer: Layer.Layer<Http>,
  startAt = 0,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.testClockWith(Effect.succeed)
      if (startAt > 0) yield* TestClock.setTime(startAt)
      server.clock(() => clock.currentTimeMillisUnsafe())
      return yield* program
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
  )

const url = 'https://provider.example/v1/organizations/enrich?domain=stripe.com'
const get = Effect.gen(function* () {
  return yield* (yield* Http).request({ method: 'GET', url })
})

describe('ConfigLive', () => {
  it('serves the bound row config, typed by the settings schema with defaults', async () => {
    const config = await Effect.runPromise(
      configOf(manifest).pipe(
        Effect.provide(
          ConfigLive(bound({ config: { greeting: 'hi' } }), settings),
        ),
      ),
    )
    expect(config).toEqual({ greeting: 'hi', times: 1 })
  })

  it('fails ConfigInvalid naming the field, not a throw', async () => {
    const exit = await Effect.runPromiseExit(
      configOf(manifest).pipe(
        Effect.provide(ConfigLive(bound({ config: { times: 9 } }), settings)),
      ),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'ConfigInvalid',
      pluginId: 'echo',
      path: 'times',
    })
  })
})

describe('SecretsLive', () => {
  const twoRows = async () => {
    const a = await storeCredential({
      scope: 'workspace',
      kind: 'enrichment',
      provider: 'apollo',
      secret: 'sk-apollo-aaaa-1111',
      createdBy: FIXTURE_ACTOR.id,
    })
    const b = await storeCredential({
      scope: 'workspace',
      kind: 'enrichment',
      provider: 'exa',
      secret: 'sk-exa-bbbb-2222',
      createdBy: FIXTURE_ACTOR.id,
    })
    const rows = await db
      .insert(integration)
      .values([
        { capabilityId: 'apollo', version: '1.0.0', credentialId: a.id },
        { capabilityId: 'exa', version: '1.0.0', credentialId: b.id },
        { capabilityId: 'echo', version: '0.1.0' },
      ])
      .returning()
    return rows
  }

  const secretOf = (row: BoundIntegration) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return Redacted.value(yield* (yield* Secrets).get())
      }).pipe(
        Effect.provide(AmbientPortsLive(row, { settings: z.object({}) })),
      ),
    )

  it("hands out the bound row's credential and nothing else", async () => {
    const [apollo, exa] = await twoRows()
    const fromApollo = await secretOf(apollo)
    const fromExa = await secretOf(exa)
    expect(Exit.isSuccess(fromApollo) && fromApollo.value).toBe(
      'sk-apollo-aaaa-1111',
    )
    expect(Exit.isSuccess(fromExa) && fromExa.value).toBe('sk-exa-bbbb-2222')
    // The port takes no id: apollo's Layer has no way to name exa's row.
    expect(Exit.isSuccess(fromApollo) && fromApollo.value).not.toBe(
      'sk-exa-bbbb-2222',
    )
  })

  it('fails JobPermanent for a row with no credential, and accessToken is NotConnected', async () => {
    const [, , echo] = await twoRows()
    expect(failureOf(await secretOf(echo))).toMatchObject({
      _tag: 'JobPermanent',
    })
    const token = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* Secrets).accessToken()
      }).pipe(
        Effect.provide(AmbientPortsLive(echo, { settings: z.object({}) })),
      ),
    )
    expect(failureOf(token)._tag).toBe('NotConnected')
  })
})

describe('LogLive', () => {
  it('prefixes [plugin:<id>] and writes a secret in its redacted form', async () => {
    const lines: Array<[LogLevel, string]> = []
    const secret = 'sk-live-0123456789abcdef'
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* Log
        yield* log.info(`calling with ${secret}`, { key: secret, n: 1 })
        yield* log.warn('plain')
      }).pipe(
        Effect.provide(
          LogLive('apollo', {
            scrub: makeScrub([secret]),
            sink: (level, line) => lines.push([level, line]),
          }),
        ),
      ),
    )
    expect(lines).toEqual([
      [
        'info',
        `[plugin:apollo] calling with ${redact(secret)} {"key":"${redact(secret)}","n":1}`,
      ],
      ['warn', '[plugin:apollo] plain'],
    ])
    expect(lines.join('\n')).not.toContain(secret)
  })

  it('scrubs through the whole binding: the row credential never reaches a line', async () => {
    const lines: Array<string> = []
    const { id } = await storeCredential({
      scope: 'workspace',
      kind: 'enrichment',
      provider: 'apollo',
      secret: 'sk-bound-9999-zzzz',
      createdBy: FIXTURE_ACTOR.id,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const key = Redacted.value(yield* (yield* Secrets).get())
        yield* (yield* Log).error(`401 with ${key}`)
      }).pipe(
        Effect.provide(
          AmbientPortsLive(
            bound({ capabilityId: 'apollo', credentialId: id }),
            {
              settings: z.object({}),
              sink: (_level, line) => lines.push(line),
            },
          ),
        ),
      ),
    )
    expect(lines).toEqual([
      `[plugin:apollo] 401 with ${redact('sk-bound-9999-zzzz')}`,
    ])
  })
})

describe('HttpLive', () => {
  it('waits out Retry-After: 2 and retries once', async () => {
    const server = fakeServer([
      { status: 429, headers: { 'Retry-After': '2' } },
      { status: 200, body: '{"ok":true}' },
    ])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    const response = await withClock(
      server,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(get)
        yield* settle
        yield* TestClock.adjust('1999 millis')
        yield* settle
        expect(server.received).toHaveLength(1)
        yield* TestClock.adjust('1 millis')
        yield* settle
        return yield* Fiber.join(fiber)
      }),
      layer,
    )
    expect(response.status).toBe(200)
    expect(server.received.map((r) => r.at)).toEqual([0, 2000])
  })

  it('waits until X-RateLimit-Reset when X-RateLimit-Remaining is 0 (delta seconds)', async () => {
    const server = fakeServer([
      {
        status: 429,
        headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '5' },
      },
      { status: 200 },
    ])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    await withClock(
      server,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(get)
        yield* settle
        yield* TestClock.adjust('5 seconds')
        yield* settle
        return yield* Fiber.join(fiber)
      }),
      layer,
    )
    expect(server.received.map((r) => r.at)).toEqual([0, 5000])
  })

  it('waits until X-RateLimit-Reset given as epoch seconds', async () => {
    const start = 1_790_000_000_000
    const server = fakeServer([
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(start / 1000 + 30),
        },
      },
      { status: 200 },
    ])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    await withClock(
      server,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(get)
        yield* settle
        yield* TestClock.adjust('30 seconds')
        yield* settle
        return yield* Fiber.join(fiber)
      }),
      layer,
      start,
    )
    expect(server.received.map((r) => r.at - start)).toEqual([0, 30_000])
  })

  it('holds the next call when a 200 says Remaining: 0', async () => {
    const server = fakeServer([
      {
        status: 200,
        headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '10' },
      },
      { status: 200 },
    ])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    await withClock(
      server,
      Effect.gen(function* () {
        yield* get
        const fiber = yield* Effect.forkChild(get)
        yield* settle
        expect(server.received).toHaveLength(1)
        yield* TestClock.adjust('10 seconds')
        yield* settle
        return yield* Fiber.join(fiber)
      }),
      layer,
    )
    expect(server.received.map((r) => r.at)).toEqual([0, 10_000])
  })

  it('fails JobRateLimited when the retry is refused too', async () => {
    const server = fakeServer([
      { status: 429, headers: { 'Retry-After': '3' } },
    ])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    const exit = await withClock(
      server,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(get)
        yield* settle
        yield* TestClock.adjust('3 seconds')
        yield* settle
        return yield* Fiber.await(fiber)
      }),
      layer,
    )
    expect(server.received).toHaveLength(2)
    expect(failureOf(exit)).toMatchObject({
      _tag: 'JobRateLimited',
      retryAfterMs: 3000,
    })
  })

  it('queues concurrent calls beyond manifest rpm instead of bursting', async () => {
    const server = fakeServer([{ status: 200 }])
    // 60 rpm: one start a second.
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      rpm: 60,
      fetch: server.fetch,
    })
    await withClock(
      server,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.all([get, get, get, get], { concurrency: 'unbounded' }),
        )
        for (let i = 0; i < 4; i++) {
          yield* settle
          yield* TestClock.adjust('1 second')
        }
        yield* settle
        return yield* Fiber.join(fiber)
      }),
      layer,
    )
    expect(server.received.map((r) => r.at)).toEqual([0, 1000, 2000, 3000])
  })

  it('sends headers lower-cased and a JSON body as JSON', async () => {
    const server = fakeServer([{ status: 201, headers: { 'X-Thing': 'a' } }])
    const layer = HttpLive({
      integrationId: crypto.randomUUID(),
      pluginId: 'echo',
      fetch: server.fetch,
    })
    const response = await withClock(
      server,
      Effect.gen(function* () {
        return yield* (yield* Http).request({
          method: 'POST',
          url,
          headers: { 'X-Api-Key': 'k' },
          body: { q: 1 },
        })
      }),
      layer,
    )
    expect(server.received.at(0)?.headers).toEqual({
      'x-api-key': 'k',
      'content-type': 'application/json',
    })
    expect(response).toMatchObject({ status: 201, body: '{}' })
    expect(response.headers['x-thing']).toBe('a')
  })

  it('fails a network error JobRetryable, the key in its URL redacted', async () => {
    const secret = 'sk-in-the-url-123456'
    const leakyUrl = `https://provider.example/v1?api_key=${secret}`
    const failing: FetchLike = () =>
      Promise.reject(new Error(`connect ECONNREFUSED ${leakyUrl}`))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* Http).request({ method: 'GET', url: leakyUrl })
      }).pipe(
        Effect.provide(
          HttpLive({
            integrationId: crypto.randomUUID(),
            pluginId: 'echo',
            fetch: failing,
            scrub: makeScrub([secret]),
          }),
        ),
      ),
    )
    const error = failureOf(exit)
    expect(error._tag).toBe('JobRetryable')
    const reason = 'reason' in error ? error.reason : ''
    expect(reason).toContain(redact(secret))
    expect(reason).not.toContain(secret)
  })
})

describe('the demo: four live Layers on one seeded row', () => {
  it('typed config, a fetch through the throttle under a 429, the prefix and the redacted key', async () => {
    const secret = 'sk-demo-apollo-77778888'
    const { id: credentialId } = await storeCredential({
      scope: 'workspace',
      kind: 'enrichment',
      provider: 'apollo',
      secret,
      createdBy: FIXTURE_ACTOR.id,
    })
    const row = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'echo',
          version: '0.1.0',
          enabled: true,
          config: { greeting: 'hey' },
          credentialId,
        })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    const server = fakeServer([
      { status: 429, headers: { 'Retry-After': '1' } },
      { status: 200, body: '{"organization":{"name":"Stripe"}}' },
    ])
    const lines: Array<string> = []
    const ports = AmbientPortsLive(row, {
      settings,
      fetch: server.fetch,
      sink: (_level, line) => lines.push(line),
    })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed)
        server.clock(() => clock.currentTimeMillisUnsafe())
        const config = yield* configOf(manifest)
        const key = Redacted.value(yield* (yield* Secrets).get())
        const fiber = yield* Effect.forkChild(
          (yield* Http).request({
            method: 'GET',
            url,
            headers: { 'X-Api-Key': key },
          }),
        )
        yield* settle
        yield* TestClock.adjust('1 second')
        yield* settle
        const response = yield* Fiber.join(fiber)
        yield* (yield* Log).info(
          `${config.greeting} x${config.times}: ${response.status} with ${key}`,
        )
        return { config, status: response.status }
      }).pipe(Effect.provide(Layer.merge(ports, TestClock.layer()))),
    )
    expect(out).toEqual({ config: { greeting: 'hey', times: 1 }, status: 200 })
    expect(server.received.map((r) => r.at)).toEqual([0, 1000])
    expect(lines).toEqual([`[plugin:echo] hey x1: 200 with ${redact(secret)}`])
  })
})
