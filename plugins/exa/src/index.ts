import { Clock, Effect, Redacted } from 'effect'
import {
  Ai,
  Content,
  Http,
  JobPermanent,
  JobRetryable,
  Judgment,
  Read,
  Secrets,
  configOf,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { ActionInput, EntityId, JsonObject, Ref } from '@spaces/sdk'
import {
  EXA_SEARCH_URL,
  briefItems,
  citeSignals,
  exaMessage,
  searchBody,
  searchHits,
  toSignal,
} from './map.ts'
import { manifest } from './manifest.ts'

/** The company the action was pressed on. */
const readCompany = Effect.fn('exa.readCompany')(function* (
  entityId: EntityId,
) {
  const record = yield* (yield* Read).entity(entityId)
  if (record === null || record.kind !== 'company') {
    return yield* new JobPermanent({
      reason: `${entityId} is not a company this integration can read`,
    })
  }
  return record
})

/**
 * One Exa search. The key goes in `x-api-key`, never the URL, so no error
 * reason can carry it.
 * - 429 never reaches here: the Http port fails it `JobRateLimited`.
 * - Any other 4xx (a bad key, no credits) is permanent and carries Exa's
 *   own sentence; 5xx is retryable.
 */
const search = Effect.fn('exa.search')(function* (body: JsonObject) {
  const key = yield* (yield* Secrets).get()
  const response = yield* (yield* Http).request({
    method: 'POST',
    url: EXA_SEARCH_URL,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': Redacted.value(key),
    },
    body,
  })
  if (response.status >= 500) {
    return yield* new JobRetryable({
      reason: `Exa search answered ${response.status}: ${exaMessage(response.body)}`,
    })
  }
  if (response.status !== 200) {
    return yield* new JobPermanent({
      reason: `Exa search answered ${response.status}: ${exaMessage(response.body)}`,
    })
  }
  const raw = yield* responseJson(response, 'Exa search')
  return yield* Effect.try({
    try: () => searchHits(raw),
    catch: () =>
      new JobPermanent({
        reason: 'Exa search returned a body this plugin cannot read',
      }),
  })
})

/** The jobs as written; `definePlugin` checks each `R` against its `uses`. */
export const jobs = {
  /**
   * Research: search, draft the brief, then write. The brief is drafted
   * before anything is written, so a refused Ai call (a sensitive record,
   * the day's cap) leaves no signal behind. Each hit's signal id is what the
   * brief cites (D4, D52); no hits means no brief.
   */
  research: Effect.fn('exa.research')(function* ({ entityId }: ActionInput) {
    const settings = yield* configOf(manifest)
    const company = yield* readCompany(entityId)
    const now = yield* Clock.currentTimeMillis
    const hits = yield* search(searchBody(company, settings, now))
    if (hits.length === 0) return
    const draft = yield* (yield* Ai).complete(
      'synthesize',
      briefItems(company, hits),
    )
    const content = yield* Content
    const refs: Array<Ref> = []
    for (const hit of hits) {
      const { signalId } = yield* content.emitSignal(toSignal(company.id, hit))
      refs.push(`event:${signalId}`)
    }
    yield* (yield* Judgment).suggest({
      entityId: company.id,
      proposal: { kind: 'note', body: citeSignals(draft, refs) },
      rationale: `Exa web research: ${hits.length} ${hits.length === 1 ? 'page' : 'pages'}`,
      refs: [...new Set(refs)],
    })
  }),
}

export default definePlugin({ manifest, jobs })
