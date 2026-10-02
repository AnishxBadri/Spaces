import { Effect, Redacted } from 'effect'
import { z } from 'zod'
import {
  Facts,
  Http,
  Identity,
  JobPermanent,
  JobRetryable,
  Log,
  Read,
  Receipts,
  Secrets,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type {
  ActionInput,
  CostInput,
  EntityId,
  EventInput,
  JsonValue,
  ReadEntity,
  RecordKind,
} from '@spaces/sdk'
import {
  CREDITS_PER_MATCH,
  apolloMessage,
  endpointUrl,
  organizationEnrichment,
  personEnrichment,
} from './map.ts'
import type { Endpoint, Enrichment } from './map.ts'
import { manifest } from './manifest.ts'

/** The record the action was pressed on, of the kind the job enriches. */
const readRecord = Effect.fn('apollo.readRecord')(function* (
  entityId: EntityId,
  kind: RecordKind,
) {
  const record = yield* (yield* Read).entity(entityId)
  if (record === null || record.kind !== kind) {
    return yield* new JobPermanent({
      reason: `${entityId} is not a ${kind} this integration can read`,
    })
  }
  return record
})

/**
 * One Apollo call. The key goes in `X-Api-Key`, never the URL, so no error
 * reason can carry it.
 * - 429 never reaches here: the Http port fails it `JobRateLimited`.
 * - Any other 4xx — a bad key, a 402/403 from a paid-plan-only endpoint —
 *   is permanent and carries Apollo's own sentence; 5xx is retryable.
 */
const callApollo = Effect.fn('apollo.call')(function* (
  endpoint: Endpoint,
  query: { readonly [name: string]: string },
) {
  const key = yield* (yield* Secrets).get()
  const url = endpointUrl(endpoint, query)
  const response = yield* (yield* Http).request({
    method: 'POST',
    url,
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'x-api-key': Redacted.value(key),
    },
  })
  if (response.status >= 500) {
    return yield* new JobRetryable({
      reason: `Apollo ${endpoint} answered ${response.status}: ${apolloMessage(response.body)}`,
    })
  }
  if (response.status !== 200) {
    return yield* new JobPermanent({
      reason: `Apollo ${endpoint} answered ${response.status}: ${apolloMessage(response.body)}`,
    })
  }
  const body = yield* responseJson(response, `Apollo ${endpoint}`)
  return yield* Effect.try({
    try: (): JsonValue => z.json().parse(body),
    catch: () =>
      new JobPermanent({ reason: `Apollo ${endpoint} returned no JSON` }),
  })
})

/**
 * D52's order: the receipt first, then the keys Apollo returned, then the
 * values — each citing the receipt the store returned.
 */
const record = Effect.fn('apollo.record')(function* (
  endpoint: Endpoint,
  claims: Enrichment,
) {
  const { receiptId } = yield* (yield* Receipts).store(claims.receipt)
  const log = yield* Log
  if (!claims.matched) {
    yield* log.info('no match', { endpoint, receiptId })
    return
  }
  const aliases =
    claims.alias === null
      ? []
      : (yield* (yield* Identity).addAlias(claims.alias)).keys
  const fill = claims.facts(receiptId)
  const conflicts =
    fill === null ? [] : (yield* (yield* Facts).fill(fill)).conflicts
  yield* log.info('enriched', {
    endpoint,
    entityId: claims.receipt.entityId,
    receiptId,
    aliases: aliases.map((a) => `${a.key}:${a.outcome}`),
    conflicts: conflicts.map((c) => c.slug),
  })
})

/** Parse failures are permanent: a retry gets the same body. */
const mapped = (
  endpoint: Endpoint,
  map: () => Enrichment,
): Effect.Effect<Enrichment, JobPermanent> =>
  Effect.try({
    try: map,
    catch: () =>
      new JobPermanent({
        reason: `Apollo ${endpoint} returned a body this plugin cannot read`,
      }),
  })

const first = (keys: ReadonlyArray<string>) => keys.at(0)

/** Ask by email, else by LinkedIn — the keys `people/match` matches on. */
const personQuery = (person: ReadEntity) => {
  const email = first(person.keys.email)
  if (email !== undefined) return { email }
  const linkedin = first(person.keys.linkedin)
  if (linkedin !== undefined) return { linkedin_url: `https://${linkedin}` }
  return null
}

/** One credit per record asked about, whatever fields are wanted (D53). */
const cost = ({ entityIds }: CostInput) => ({
  credits: entityIds.length * CREDITS_PER_MATCH,
})

/** One company, by the domain it was read with: the call, then the claims. */
const enrichByDomain = Effect.fn('apollo.enrichByDomain')(function* (
  entityId: EntityId,
  domain: string,
) {
  const raw = yield* callApollo('organizations/enrich', { domain })
  const claims = yield* mapped('organizations/enrich', () =>
    organizationEnrichment(entityId, raw),
  )
  yield* record('organizations/enrich', claims)
})

/** The jobs as written; `definePlugin` checks each `R` against its `uses`. */
export const jobs = {
  enrichCompany: {
    run: Effect.fn('apollo.enrichCompany')(function* ({
      entityId,
    }: ActionInput) {
      const company = yield* readRecord(entityId, 'company')
      const domain = first(company.keys.domain)
      if (domain === undefined) {
        return yield* new JobPermanent({
          reason: `${company.name} has no domain to enrich from`,
        })
      }
      yield* enrichByDomain(entityId, domain)
    }),
    cost,
  },
  /**
   * Enrich-on-create. Anything but a company with a domain is declined
   * before the key is read or Apollo is called, so it spends no credit —
   * and declining is a success, not a failure: nothing was asked of it.
   */
  onCompanyCreated: Effect.fn('apollo.onCompanyCreated')(function* ({
    event,
  }: EventInput) {
    if (event.kind !== 'company') return
    const company = yield* (yield* Read).entity(event.entityId)
    const domain =
      company?.kind === 'company' ? first(company.keys.domain) : undefined
    if (domain === undefined) {
      yield* (yield* Log).info('declined: no domain', {
        entityId: event.entityId,
      })
      return
    }
    yield* enrichByDomain(event.entityId, domain)
  }),
  enrichPerson: {
    run: Effect.fn('apollo.enrichPerson')(function* ({
      entityId,
    }: ActionInput) {
      const person = yield* readRecord(entityId, 'person')
      const query = personQuery(person)
      if (query === null) {
        return yield* new JobPermanent({
          reason: `${person.name} has no email or LinkedIn to match on`,
        })
      }
      const raw = yield* callApollo('people/match', query)
      const claims = yield* mapped('people/match', () =>
        personEnrichment(entityId, raw),
      )
      yield* record('people/match', claims)
    }),
    cost,
  },
}

export default definePlugin({ manifest, jobs })
