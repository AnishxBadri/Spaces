import { Effect, Redacted } from 'effect'
import { z } from 'zod'
import {
  Content,
  Facts,
  Http,
  Identity,
  JobPermanent,
  JobRetryable,
  Log,
  Read,
  Receipts,
  Secrets,
  configOf,
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
import type { Endpoint, Enrichment, HeldCompany } from './map.ts'
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
 * answers in the host's vocabulary, then the signals — each citing the
 * receipt the store returned.
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
  const answer = claims.answer(receiptId)
  const unlinked =
    answer === null ? [] : (yield* (yield* Facts).answer(answer)).unlinked
  const content = yield* Content
  const signals: Array<string> = []
  for (const claim of claims.signals(receiptId))
    signals.push((yield* content.emitSignal(claim)).signalId)
  yield* log.info('enriched', {
    endpoint,
    entityId: claims.receipt.entityId,
    receiptId,
    aliases: aliases.map((a) => `${a.key}:${a.outcome}`),
    unlinked: [...unlinked],
    signals,
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

/**
 * Ask by email, else by the LinkedIn URL the record holds — what
 * `people/match` matches on. LinkedIn is a value, never a key. (D75)
 */
const personQuery = (person: ReadEntity) => {
  const email = first(person.keys.email)
  if (email !== undefined) return { email }
  const linkedin = person.values.linkedin
  if (typeof linkedin === 'string' && linkedin !== '')
    return { linkedin_url: linkedin }
  return null
}

/** One credit per record asked about, whatever fields are wanted (D53). */
const cost = ({ entityIds }: CostInput) => ({
  credits: entityIds.length * CREDITS_PER_MATCH,
})

const textValue = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/** The companies the person links, by name and domain, as the job may read them. */
const heldCompanies = Effect.fn('apollo.heldCompanies')(function* (
  person: ReadEntity,
) {
  const linked = person.values.companies
  const ids = Array.isArray(linked)
    ? linked.flatMap((id) => (typeof id === 'string' ? [id] : []))
    : []
  const read = yield* Read
  const held: Array<HeldCompany> = []
  for (const id of ids) {
    const company = yield* read.entity(id)
    if (company !== null)
      held.push({ name: company.name, domains: company.keys.domain })
  }
  return held
})

/**
 * One person, by email or LinkedIn: the call, then the claims. The phone is
 * asked for only with the `phone` setting on — Apollo charges extra for it.
 */
const enrichPersonRecord = Effect.fn('apollo.enrichPersonRecord')(function* (
  entityId: EntityId,
  person: ReadEntity,
  query: { readonly [name: string]: string },
) {
  const { phone } = yield* configOf(manifest)
  const raw = yield* callApollo(
    'people/match',
    phone ? { ...query, reveal_phone_number: 'true' } : query,
  )
  const held = {
    title: textValue(person.values.job_title),
    description: textValue(person.values.description),
    companies: yield* heldCompanies(person),
  }
  const claims = yield* mapped('people/match', () =>
    personEnrichment(entityId, raw, held, { phone }),
  )
  yield* record('people/match', claims)
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
   * Auto-enrich: the Enrich button pressed by the host when a trigger fires
   * in the owner's scope. A company is asked by domain, a person by email or
   * LinkedIn; anything else — a deal, a record with no key — is declined
   * before the key is read or Apollo is called, so it spends no credit, and
   * declining is a success: nothing was asked of it.
   */
  autoEnrich: Effect.fn('apollo.autoEnrich')(function* ({ event }: EventInput) {
    if (event.kind === 'deal') return
    const found = yield* (yield* Read).entity(event.entityId)
    const declined = (reason: string) =>
      Effect.gen(function* () {
        yield* (yield* Log).info(`declined: ${reason}`, {
          entityId: event.entityId,
          trigger: event.name,
        })
      })
    if (found?.kind === 'company') {
      const domain = first(found.keys.domain)
      if (domain === undefined) return yield* declined('no domain')
      return yield* enrichByDomain(event.entityId, domain)
    }
    if (found?.kind === 'person') {
      const query = personQuery(found)
      if (query === null) return yield* declined('no email or LinkedIn')
      return yield* enrichPersonRecord(event.entityId, found, query)
    }
    return yield* declined('not a company or a person')
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
      yield* enrichPersonRecord(entityId, person, query)
    }),
    cost,
  },
}

export default definePlugin({ manifest, jobs })
