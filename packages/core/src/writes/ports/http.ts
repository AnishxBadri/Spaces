import { Clock, Effect, Layer, Semaphore } from 'effect'
import { Http, JobRateLimited, JobRetryable } from '@spaces/sdk'
import type { HttpRequest, HttpResponse } from '@spaces/sdk'
import { noScrub } from './binding'
import type { Scrub } from './binding'

/**
 * HttpLive (sdk-6a): the only way a plugin reaches the network — no raw
 * `fetch` in a plugin (spec §4). A fetch with a throttle in front of it that
 * learns the provider's limits from its responses rather than from a
 * hardcoded rate (CONTEXT.md, Enrichment: "read rate-limit headers, do not
 * hardcode"):
 *
 * - **429.** `Retry-After` (seconds or an HTTP date), else
 *   `X-RateLimit-Reset` with `X-RateLimit-Remaining: 0`, says when to come
 *   back; with neither, one second. The throttle holds every call on this
 *   binding until then, and the request is retried **once**. A second 429
 *   fails `JobRateLimited` with the wait it asked for, and the worker re-sends
 *   the job later without spending its retry budget (`runJob`).
 * - **Remaining 0 on any response.** `X-RateLimit-Remaining: 0` with a reset
 *   holds the next call until the reset, so the 429 never happens.
 * - **`manifest.http.rateLimit.rpm`.** When the manifest declares one,
 *   requests start at least `60s / rpm` apart: concurrent calls queue behind
 *   the throttle rather than bursting.
 *
 * **The throttle is per worker process.** Its state lives in this module,
 * one entry per integration row, so every job of one integration in this
 * process shares it — and a second worker process has its own. A deployment
 * that runs several workers can exceed a provider's limit by that factor;
 * a shared throttle (in Postgres) is the fix when that deployment exists.
 *
 * Network failures are `JobRetryable`; any other status comes back as a
 * response for the job to judge. Every error reason passes through the
 * binding's scrub, so a key carried in a URL is never written whole.
 * Time is Effect's `Clock`, so a test drives it with `TestClock`.
 */

/** What HttpLive calls — `globalThis.fetch`'s shape; a test hands a fake. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body?: string
  },
) => Promise<Response>

export type HttpLiveOptions = {
  /** The integration row — the throttle's key. */
  readonly integrationId: string
  readonly pluginId: string
  /** `manifest.http.rateLimit.rpm`, when the manifest declares one. */
  readonly rpm?: number
  readonly scrub?: Scrub
  readonly fetch?: FetchLike
}

/** With a 429 that names no wait, come back after this. */
export const DEFAULT_RETRY_AFTER_MS = 1000

type Throttle = {
  readonly gate: Semaphore.Semaphore
  /** Epoch ms before which no request on this binding may start. */
  nextAt: number
}

/** Per worker process, per integration row — see the module comment. */
const throttles = new Map<string, Throttle>()

const throttleFor = (integrationId: string): Throttle => {
  const existing = throttles.get(integrationId)
  if (existing) return existing
  const created: Throttle = { gate: Semaphore.makeUnsafe(1), nextAt: 0 }
  throttles.set(integrationId, created)
  return created
}

/** A reset header: epoch ms, epoch seconds, or seconds from now. */
const resetAt = (value: string, now: number): number | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (n > 1e12) return n
  if (n > 1e9) return n * 1000
  return now + n * 1000
}

/** `Retry-After`: delta seconds or an HTTP date. */
const retryAfterAt = (value: string, now: number): number | null => {
  const n = Number(value)
  if (value.trim() !== '' && Number.isFinite(n) && n >= 0) return now + n * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : date
}

const header = (
  headers: HttpResponse['headers'],
  name: string,
): string | undefined =>
  Object.hasOwn(headers, name) ? headers[name] : undefined

/** When the provider said this binding may call again, if it said. */
export const waitUntil = (
  headers: HttpResponse['headers'],
  now: number,
): number | null => {
  const retryAfter = header(headers, 'retry-after')
  if (retryAfter !== undefined) {
    const at = retryAfterAt(retryAfter, now)
    if (at !== null) return at
  }
  const remaining = header(headers, 'x-ratelimit-remaining')
  const reset = header(headers, 'x-ratelimit-reset')
  if (remaining !== undefined && Number(remaining) <= 0 && reset !== undefined)
    return resetAt(reset, now)
  return null
}

export const HttpLive = (options: HttpLiveOptions): Layer.Layer<Http> => {
  const scrub = options.scrub ?? noScrub
  const fetchImpl: FetchLike =
    options.fetch ?? ((url, init) => fetch(url, init))
  const spacing =
    options.rpm !== undefined && options.rpm > 0 ? 60_000 / options.rpm : 0
  const throttle = throttleFor(options.integrationId)

  /** Take the next slot under the gate, then wait outside it until then. */
  const turn = Effect.gen(function* () {
    const slot = yield* throttle.gate.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const at = Math.max(now, throttle.nextAt)
        throttle.nextAt = at + spacing
        return { at, now }
      }),
    )
    if (slot.at > slot.now) yield* Effect.sleep(slot.at - slot.now)
  })

  const holdUntil = (at: number) => {
    throttle.nextAt = Math.max(throttle.nextAt, at)
  }

  const send = (request: HttpRequest) =>
    Effect.gen(function* () {
      yield* turn
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers ?? {}))
        headers[k.toLowerCase()] = v
      let body: string | undefined
      if (request.body !== undefined) {
        if (typeof request.body === 'string') body = request.body
        else {
          body = JSON.stringify(request.body)
          headers['content-type'] ??= 'application/json'
        }
      }
      const failed = (error: unknown) =>
        new JobRetryable({
          reason: scrub(
            `${request.method} ${request.url} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        })
      const res = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(request.url, {
            method: request.method,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
        catch: failed,
      })
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: failed,
      })
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value
      })
      const response: HttpResponse = {
        status: res.status,
        headers: responseHeaders,
        body: text,
      }
      const now = yield* Clock.currentTimeMillis
      const until = waitUntil(responseHeaders, now)
      if (until !== null) holdUntil(until)
      else if (res.status === 429) holdUntil(now + DEFAULT_RETRY_AFTER_MS)
      return response
    })

  const request = (input: HttpRequest) =>
    Effect.gen(function* () {
      const first = yield* send(input)
      if (first.status !== 429) return first
      // The throttle now holds until the provider's time; `turn` waits it out.
      const second = yield* send(input)
      if (second.status !== 429) return second
      const now = yield* Clock.currentTimeMillis
      return yield* new JobRateLimited({
        reason: scrub(`${input.method} ${input.url} answered 429 twice`),
        retryAfterMs: Math.max(
          0,
          (waitUntil(second.headers, now) ?? now + DEFAULT_RETRY_AFTER_MS) -
            now,
        ),
      })
    })

  return Layer.succeed(Http, Http.of({ request }))
}
