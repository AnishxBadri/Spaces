import { Effect } from 'effect'
import { z } from 'zod'
import {
  Ai,
  Content,
  Http,
  JobPermanent,
  JobRetryable,
  Judgment,
  Log,
  Read,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { AiItem, Ref, SignalClaim } from '@spaces/sdk'
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

/** A hit's place-holding ref in the prompt, before its signal exists. */
const hitRef = (index: number): Ref => `event:hit-${index + 1}`

/** The record and each hit, as the context the brief is drafted from. */
export const briefItems = (
  record: { readonly id: string; readonly name: string },
  claims: ReadonlyArray<SignalClaim>,
): ReadonlyArray<AiItem> => [
  { ref: `attr:${record.id}:name`, text: record.name },
  ...claims.map((claim, index) => ({
    ref: hitRef(index),
    text: [claim.title, claim.url]
      .filter((part) => part !== undefined)
      .join(' — '),
  })),
]

export default definePlugin({
  manifest,
  jobs: {
    // The brief is drafted before anything is written, so a refused call
    // (a sensitive record, the day's cap) leaves no signal behind. Each
    // emitSignal hands back the signal's id, which the suggestion cites.
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
        const draft = yield* (yield* Ai).complete(
          'synthesize',
          briefItems(record, claims),
        )
        const content = yield* Content
        const refs: Array<Ref> = []
        let brief = draft
        for (const [index, claim] of claims.entries()) {
          const { signalId } = yield* content.emitSignal(claim)
          const ref: Ref = `event:${signalId}`
          refs.push(ref)
          brief = brief.replaceAll(`[${hitRef(index)}]`, `[${ref}]`)
        }
        const { suggestionId } = yield* (yield* Judgment).suggest({
          entityId: record.id,
          proposal: { kind: 'note', body: brief },
          rationale: 'Web research (fixture)',
          refs,
        })
        yield* (yield* Log).info('researched', { entityId, refs, suggestionId })
      }),
  },
})
