import { Effect } from 'effect'
import type { EmbeddingModel } from 'ai'
import { EmbeddingCountMismatch, embedProgram } from '#/lib/ai/embed'
import type { EmbedFailure } from '#/lib/ai/embed'
import { readEmbeddingPinProgram } from '#/lib/ai/embedding-pin'
import type { Caller } from '#/lib/ai/complete'

/**
 * The query half of Cmd-K's semantic lane (SPA-129). The palette's second
 * wave — the fused query plus the vector lane, 600ms after the last
 * keystroke — embeds what the user typed; this module is where that embed
 * happens and where it is remembered.
 *
 * **Cached by (text, model)** in a small in-process LRU: a phrase the user
 * pauses on twice, or retypes, is billed once. The key carries the pinned
 * provider and model, so a vector can never answer for a model it did not
 * come from. The cache lives outside `lib/server/` so a test can reach it
 * without a request (SPA-155), and in the process because a query vector is
 * cheap to lose — a restart costs one provider call per phrase, nothing more.
 *
 * `sensitivity: 'normal'`: the text is what the user typed into a search
 * box, not record content, so no record's sensitivity applies to it.
 *
 * `model` is the test seam, passed straight through to `embed()`: the pin,
 * the cap and the `ai_usage` row are all still real.
 */

/** Distinct (text, model) pairs held — a session's worth of pauses. */
export const QUERY_EMBEDDING_CACHE_SIZE = 256

const cache = new Map<string, ReadonlyArray<number>>()

/**
 * The failure tag last logged, so a cap reached (or a provider down) is one
 * log line, not one per pause in typing. Cleared by the next success, so the
 * same failure returning after a recovery is logged again.
 */
let lastLogged: string | null = null

const cacheKey = (provider: string, model: string, text: string): string =>
  `${provider}\u0000${model}\u0000${text}`

/**
 * Forgets every cached query vector and the last failure logged; a test
 * starts from an empty cache and a quiet log.
 */
export function clearQueryEmbeddingCache(): void {
  cache.clear()
  lastLogged = null
}

/** A query vector and the pinned model it came from. */
export type QueryVector = { vector: ReadonlyArray<number>; model: string }

export type QueryEmbeddingOptions = {
  caller: Caller
  model?: EmbeddingModel
}

/**
 * The query's vector under the pinned model, from the cache when this
 * (text, model) was embedded before. `null` when no model is pinned —
 * "no pin" is not a failure, it is the lexical-only workspace.
 */
export const queryEmbeddingProgram = Effect.fn('queryEmbedding')(function* (
  text: string,
  opts: QueryEmbeddingOptions,
): Effect.fn.Return<QueryVector | null, EmbedFailure> {
  const pin = yield* readEmbeddingPinProgram()
  if (pin === null) return null

  const key = cacheKey(pin.provider, pin.model, text)
  const cached = cache.get(key)
  if (cached !== undefined) {
    // Re-inserted so the Map's insertion order is recency order.
    cache.delete(key)
    cache.set(key, cached)
    return { vector: cached, model: pin.model }
  }

  const result = yield* embedProgram([text], {
    caller: opts.caller,
    sensitivity: 'normal',
    ...(opts.model === undefined ? {} : { model: opts.model }),
  })
  const vector = result.vectors.at(0)
  if (vector === undefined)
    return yield* new EmbeddingCountMismatch({
      provider: result.target.provider,
      expected: 1,
      received: 0,
    })

  cache.set(cacheKey(result.target.provider, result.target.model, text), vector)
  const oldest = cache.keys().next()
  if (cache.size > QUERY_EMBEDDING_CACHE_SIZE && !oldest.done)
    cache.delete(oldest.value)
  return { vector, model: result.target.model }
})

/**
 * The second wave's embed, made total: any failure — cap reached, provider
 * down, no key, a pin this build cannot read — answers `null`, and the wave
 * runs as the lexical query it would otherwise have been. The user sees the
 * lexical list stay put; the operator sees one warning per failure kind.
 */
export const queryVectorOrNullProgram = Effect.fn('queryVectorOrNull')(
  function* (
    text: string,
    opts: QueryEmbeddingOptions,
  ): Effect.fn.Return<QueryVector | null> {
    const r = yield* Effect.result(queryEmbeddingProgram(text, opts))
    if (r._tag === 'Success') {
      lastLogged = null
      return r.success
    }
    if (lastLogged !== r.failure._tag) {
      lastLogged = r.failure._tag
      yield* Effect.logWarning(
        `[search] the semantic lane is off until embedding recovers: ${r.failure._tag}`,
      )
    }
    return null
  },
)
