import type { FetchLike } from '@spaces/core/writes/ports/http'
import type { Cassette } from './cassette'

/**
 * A provider fake: the cassette's answers behind a little mutable state, so
 * the chaos cases are things the provider does rather than things a test
 * scripts into a port. Handed to `HttpLive` as its `fetch`, so the live
 * throttle, scrub and 429 handling are what runs.
 *
 * Checked in this order: a revoked key, a pending 429, a failing URL, then
 * the cassette; a request none of them answers is a 404 naming it.
 */

export type FakeRequest = {
  readonly method: string
  readonly url: string
  /** The value of the cassette's key header, when the request carried one. */
  readonly key: string | null
  /** Epoch ms the request arrived. */
  readonly at: number
}

export type FakeProvider = {
  readonly fetch: FetchLike
  /** Every request, in arrival order. */
  readonly requests: ReadonlyArray<FakeRequest>
  /** The next `times` requests answer 429 with this `Retry-After`. */
  readonly rateLimit: (times: number, retryAfter: string) => void
  /** From now on a request carrying `key` gets the cassette's `revoked` answer. */
  readonly revoke: (key: string) => void
  /** From now on a request whose URL `match` accepts answers `status`. */
  readonly failWhere: (match: (url: string) => boolean, status: number) => void
}

const json = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

export const makeFakeProvider = (cassette: Cassette): FakeProvider => {
  const requests: Array<FakeRequest> = []
  const revoked = new Set<string>()
  const failing: Array<{
    readonly match: (url: string) => boolean
    readonly status: number
  }> = []
  let limited = { times: 0, retryAfter: '1' }

  const answer = (method: string, url: string, key: string | null) => {
    if (key !== null && revoked.has(key))
      return json(cassette.revoked.status, cassette.revoked.body)
    if (limited.times > 0) {
      limited = { ...limited, times: limited.times - 1 }
      return json(429, JSON.stringify({ error: 'rate limit exceeded' }), {
        'retry-after': limited.retryAfter,
      })
    }
    const failure = failing.find((f) => f.match(url))
    if (failure !== undefined)
      return json(
        failure.status,
        JSON.stringify({
          error: `the fake failed this request (${failure.status})`,
        }),
      )
    const recorded = cassette.match(method, url)
    return recorded === null
      ? json(
          404,
          JSON.stringify({
            error: `no recorded interaction for ${method} ${url}`,
          }),
        )
      : json(recorded.status, recorded.body)
  }

  const fetch: FetchLike = (url, init) => {
    const header = Object.entries(init.headers).find(
      ([name]) => name.toLowerCase() === cassette.keyHeader,
    )
    const key = header?.[1] ?? null
    requests.push({ method: init.method, url, key, at: Date.now() })
    return Promise.resolve(answer(init.method, url, key))
  }

  return {
    fetch,
    requests,
    rateLimit: (times, retryAfter) => {
      limited = { times, retryAfter }
    },
    revoke: (key) => {
      revoked.add(key)
    },
    failWhere: (match, status) => {
      failing.push({ match, status })
    },
  }
}
