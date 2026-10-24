import { Clock, Effect, Redacted } from 'effect'
import { z } from 'zod'
import {
  Ai,
  Content,
  Discover,
  Http,
  JobPermanent,
  JobRetryable,
  Judgment,
  Log,
  Read,
  Receipts,
  Secrets,
  Spaces,
  configOf,
  definePlugin,
  responseJson,
  watchSettingsOf,
} from '@spaces/sdk'
import type {
  ActionInput,
  EntityId,
  HttpMethod,
  HttpResponse,
  JsonObject,
  JsonValue,
  Ref,
  SpaceBrief,
  WatchInput,
} from '@spaces/sdk'
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
import {
  EXA_WEBSETS_URL,
  MAX_PAGES,
  createBody,
  handOf,
  itemsAfter,
  itemsUrl,
  membersByDomain,
  readPage,
  watchState,
  websetId,
  websetUrl,
} from './webset.ts'
import type { WatchSettings, WatchState } from './webset.ts'

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
 * One request to Exa. The key goes in `x-api-key`, never the URL, so no
 * error reason can carry it.
 */
const exaRequest = Effect.fn('exa.request')(function* (request: {
  readonly method: HttpMethod
  readonly url: string
  readonly body?: JsonObject
}) {
  const key = yield* (yield* Secrets).get()
  return yield* (yield* Http).request({
    ...request,
    headers: {
      accept: 'application/json',
      ...(request.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      'x-api-key': Redacted.value(key),
    },
  })
})

/**
 * Exa's answer as JSON, or the failure it is.
 * - 429 never reaches here: the Http port fails it `JobRateLimited`.
 * - Any other 4xx (a bad key, no credits) is permanent and carries Exa's
 *   own sentence; 5xx is retryable.
 */
const exaAnswer = Effect.fn('exa.answer')(function* (
  label: string,
  response: HttpResponse,
) {
  if (response.status >= 500) {
    return yield* new JobRetryable({
      reason: `${label} answered ${response.status}: ${exaMessage(response.body)}`,
    })
  }
  if (response.status < 200 || response.status > 299) {
    return yield* new JobPermanent({
      reason: `${label} answered ${response.status}: ${exaMessage(response.body)}`,
    })
  }
  const body = yield* responseJson(response, label)
  return yield* Effect.try({
    try: (): JsonValue => z.json().parse(body),
    catch: () => new JobPermanent({ reason: `${label} returned no JSON` }),
  })
})

/** A body Exa answered, read by `read`; one it did not mean is permanent. */
const decode = <T>(label: string, read: () => T) =>
  Effect.try({
    try: read,
    catch: () =>
      new JobPermanent({
        reason: `${label} returned a body this plugin cannot read`,
      }),
  })

/** One Exa search. */
const search = Effect.fn('exa.search')(function* (body: JsonObject) {
  const response = yield* exaRequest({
    method: 'POST',
    url: EXA_SEARCH_URL,
    body,
  })
  const raw = yield* exaAnswer('Exa search', response)
  return yield* decode('Exa search', () => searchHits(raw))
})

/** Exa's answer kept whole against the space — the run's provenance. */
const keep = Effect.fn('exa.keep')(function* (
  spaceId: EntityId,
  raw: JsonValue,
) {
  const { receiptId } = yield* (yield* Receipts).store({
    entityId: spaceId,
    raw,
  })
  return receiptId
})

/**
 * The watch's webset, created from the brief. Created under the watch id as
 * its `externalId`, so a run that created it and then failed adopts it on
 * the next run (Exa answers 409) rather than paying for a second.
 */
const createWebset = Effect.fn('exa.createWebset')(function* (
  input: WatchInput,
  brief: SpaceBrief,
  settings: WatchSettings,
) {
  const created = yield* exaRequest({
    method: 'POST',
    url: EXA_WEBSETS_URL,
    body: createBody(brief, settings, input.watchId),
  })
  const raw =
    created.status === 409
      ? yield* exaAnswer(
          'Exa webset lookup',
          yield* exaRequest({ method: 'GET', url: websetUrl(input.watchId) }),
        )
      : yield* exaAnswer('Exa webset create', created)
  yield* keep(input.spaceId, raw)
  return yield* decode('Exa webset create', () => websetId(raw))
})

/** The cursor the last run handed back; null before the first. */
const priorState = (input: WatchInput) =>
  input.state === null
    ? Effect.succeed(null)
    : decode(`watch ${input.watchId}'s state`, () =>
        watchState.parse(input.state),
      )

/** The jobs as written; `definePlugin` checks each `R` against its `uses`. */
export const jobs = {
  /**
   * Research: search, draft the brief, then write. The brief is drafted
   * before anything is written, so a refused Ai call (a sensitive record,
   * the day's cap) leaves no signal behind. Each hit's signal id is what the
   * brief cites; no hits means no brief.
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

  /**
   * Watch: the first run creates a webset from the space's brief; every run
   * pages it from the stored cursor. A member's item is a signal on the
   * member, anything else a candidate for the host to judge. The run
   * stops at the cap with the cursor where it stopped; every answer Exa gave
   * is kept as a receipt on the space.
   */
  watch: Effect.fn('exa.watch')(function* (input: WatchInput) {
    const settings = yield* watchSettingsOf(manifest.jobs.watch, input)
    const prior = yield* priorState(input)
    const brief = yield* (yield* Spaces).brief(input.spaceId)
    const start: WatchState = prior ?? {
      websetId: yield* createWebset(input, brief, settings),
      cursor: null,
      lastItemId: null,
    }
    const members = membersByDomain(brief.members)
    const content = yield* Content
    const discover = yield* Discover
    let { cursor, lastItemId } = start
    let handed = 0
    let signals = 0
    let candidates = 0
    pages: for (
      let page = 0;
      page < MAX_PAGES && handed < settings.cap;
      page++
    ) {
      const raw = yield* exaAnswer(
        'Exa webset items',
        yield* exaRequest({
          method: 'GET',
          url: itemsUrl(start.websetId, cursor),
        }),
      )
      const receiptId = yield* keep(input.spaceId, raw)
      const items = yield* decode('Exa webset items', () => readPage(raw))
      for (const item of itemsAfter(items.data, lastItemId)) {
        if (handed >= settings.cap) break pages
        const hand = handOf(item, input.spaceId, members, {
          websetId: start.websetId,
          receiptId,
        })
        if (hand._tag === 'signal') {
          yield* content.emitSignal(hand.claim)
          signals++
          handed++
        } else if (hand._tag === 'candidate') {
          yield* discover.candidate(hand.claim)
          candidates++
          handed++
        }
        lastItemId = item.id
      }
      const next = items.hasMore ? (items.nextCursor ?? null) : null
      if (next === null || next === cursor) break
      cursor = next
      lastItemId = null
    }
    const state: WatchState = { websetId: start.websetId, cursor, lastItemId }
    yield* (yield* Log).info('watch run', {
      watchId: input.watchId,
      created: prior === null,
      ...state,
      signals,
      candidates,
    })
    return { state }
  }),
}

export default definePlugin({ manifest, jobs })
