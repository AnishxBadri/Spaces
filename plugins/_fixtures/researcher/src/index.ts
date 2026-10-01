import { Effect } from 'effect'
import { z } from 'zod'
import {
  Content,
  Http,
  JobPermanent,
  JobRetryable,
  Log,
  Read,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { Ref, SignalClaim } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** A stand-in search provider; the test scripts its responses (HttpTest). */
export const SEARCH_URL = 'https://search.example/v1/search'

/**
 * The provider's answer — the fields this fixture reads and nothing more.
 * Parsed, never trusted: an absent field is simply not claimed.
 */
const searchResponse = z.object({
  results: z.array(
    z.object({
      url: z.string().min(1),
      title: z.string().min(1).nullish(),
      publishedDate: z.string().min(1).nullish(),
      score: z.number().nullish(),
      author: z.string().min(1).nullish(),
    }),
  ),
})

/** The pure half: one search hit → one signal claim on the record. */
export const toSignals = (
  entityId: string,
  raw: unknown,
): ReadonlyArray<SignalClaim> =>
  searchResponse.parse(raw).results.map((hit) => ({
    _tag: 'signal',
    entityId,
    kind: 'web',
    url: hit.url,
    ...(hit.title == null ? {} : { title: hit.title }),
    ...(hit.publishedDate == null ? {} : { publishedAt: hit.publishedDate }),
    payload: {
      ...(hit.score == null ? {} : { score: hit.score }),
      ...(hit.author == null ? {} : { author: hit.author }),
    },
  }))

export default definePlugin({
  manifest,
  jobs: {
    // D52: each emitSignal writes at once and hands back the signal's id,
    // which is what a later suggestion would cite (`event:<id>`, D4).
    research: ({ entityId }) =>
      Effect.gen(function* () {
        const record = yield* (yield* Read).entity(entityId)
        if (record === null) {
          return yield* new JobPermanent({
            reason: `${entityId} is not a record this integration may read`,
          })
        }
        const response = yield* (yield* Http).request({
          method: 'POST',
          url: SEARCH_URL,
          headers: { accept: 'application/json' },
          body: { query: record.name, numResults: 5 },
        })
        if (response.status !== 200) {
          return yield* new JobRetryable({
            reason: `${SEARCH_URL} answered ${response.status}`,
          })
        }
        const raw = yield* responseJson(response, SEARCH_URL)
        const claims = yield* Effect.try({
          try: () => toSignals(record.id, raw),
          catch: () =>
            new JobPermanent({
              reason: `${SEARCH_URL} did not return search results`,
            }),
        })
        const content = yield* Content
        const refs: Array<Ref> = []
        for (const claim of claims) {
          const { signalId } = yield* content.emitSignal(claim)
          refs.push(`event:${signalId}`)
        }
        yield* (yield* Log).info('researched', { entityId, refs })
      }),
  },
})
