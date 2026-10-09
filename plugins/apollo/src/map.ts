import { z } from 'zod'
import { isRoleEmail } from '@spaces/sdk/identity'
import type {
  AliasClaim,
  AnswerClaim,
  EntityId,
  FactValues,
  IdentityKeys,
  JsonObject,
  JsonValue,
  ReceiptClaim,
  SignalClaim,
} from '@spaces/sdk'

/**
 * The pure half of the Apollo jobs: what to ask, and what Apollo's answer
 * claims. Provider JSON in, port arguments out — no Effect, no ports.
 * - Fields are parsed, never trusted: an absent or null field claims nothing.
 * - Values are keyed by the slugs `SYSTEM_ATTRIBUTES` seeds for the kind,
 *   and answered in the vocabulary through `ANSWER_KEYS` — only the keys
 *   those slugs are linked to by default.
 * - A domain or an email is an identity key; a LinkedIn URL is a value. (D75)
 * - A funding round and a change of title are signals, never values: dated
 *   evidence citing the receipt. (D72)
 */

export const APOLLO_API = 'https://api.apollo.io/api/v1'

/** One enrichment, one credit (Apollo's unit) — `cost` and the receipt agree. */
export const CREDITS_PER_MATCH = 1

export type Endpoint = 'organizations/enrich' | 'people/match'

export const endpointUrl = (
  endpoint: Endpoint,
  query: { readonly [name: string]: string },
): string => `${APOLLO_API}/${endpoint}?${new URLSearchParams(query)}`

const text = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1))
  .nullish()
  .catch(null)

const place = (...parts: ReadonlyArray<string | null | undefined>) =>
  parts.filter((p) => p != null && p !== '').join(', ')

/** An ISO timestamp from Apollo's date text, or null when it is not one. */
const isoOf = (date: string | null | undefined): string | null => {
  if (date == null) return null
  const at = new Date(date)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** One of `funding_events`: Apollo spells the amount as text or a number. */
const fundingEvent = z.object({
  id: text,
  date: text,
  type: text,
  amount: z.union([z.string(), z.number()]).nullish().catch(null),
  currency: text,
  news_url: text,
  investors: text,
})

/** `organizations/enrich` — `{ organization }`, or `{}` for no match. */
const organizationResponse = z.object({
  organization: z
    .object({
      name: text,
      primary_domain: text,
      website_url: text,
      linkedin_url: text,
      founded_year: z.int().min(1000).max(9999).nullish().catch(null),
      short_description: text,
      city: text,
      country: text,
      funding_events: z.array(fundingEvent.catch({})).nullish().catch(null),
      latest_funding_stage: text,
      latest_funding_round_date: text,
    })
    .nullish(),
})

type FundingEvent = z.infer<typeof fundingEvent>

/** The fields of a JSON object that hold something, nulls left out. */
const present = (fields: {
  readonly [key: string]: string | number | null | undefined
}): JsonObject => {
  const out: { [key: string]: string | number } = {}
  for (const [key, value] of Object.entries(fields))
    if (value != null && value !== '') out[key] = value
  return out
}

/**
 * The latest round: the newest dated `funding_events` entry, else the
 * `latest_funding_stage` and its date. Null when Apollo names no round.
 */
const latestRound = (org: {
  readonly funding_events?: ReadonlyArray<FundingEvent> | null | undefined
  readonly latest_funding_stage?: string | null | undefined
  readonly latest_funding_round_date?: string | null | undefined
}): (FundingEvent & { readonly at: string }) | null => {
  const dated = (org.funding_events ?? []).flatMap((e) => {
    const at = isoOf(e.date)
    return at === null || (e.type == null && e.amount == null)
      ? []
      : [{ ...e, at }]
  })
  dated.sort((a, b) => b.at.localeCompare(a.at))
  const newest = dated.at(0)
  if (newest !== undefined) return newest
  const at = isoOf(org.latest_funding_round_date)
  return at === null || org.latest_funding_stage == null
    ? null
    : {
        type: org.latest_funding_stage,
        date: org.latest_funding_round_date,
        at,
      }
}

/** A round as the signal the record's timeline shows. */
const fundingSignal = (
  entityId: EntityId,
  receiptId: string,
  round: FundingEvent & { readonly at: string },
): SignalClaim => {
  const amount =
    round.amount == null ? null : `${round.currency ?? ''}${round.amount}`
  return {
    _tag: 'signal',
    entityId,
    kind: 'funding',
    title: [round.type ?? 'Funding round', amount].filter(Boolean).join(' · '),
    ...(round.news_url ? { url: round.news_url } : {}),
    publishedAt: round.at,
    payload: present({
      round: round.type,
      amount: round.amount,
      currency: round.currency,
      investors: round.investors,
      apolloEventId: round.id,
    }),
    receiptId,
  }
}

/** `people/match` — `{ person }`, with `person: null` for no match. */
const personResponse = z.object({
  person: z
    .object({
      email: text,
      linkedin_url: text,
      twitter_url: text,
      title: text,
      city: text,
      country: text,
      organization: z.object({ name: text }).nullish().catch(null),
      employment_history: z
        .array(
          z
            .object({ current: z.boolean().nullish(), start_date: text })
            .catch({}),
        )
        .nullish()
        .catch(null),
    })
    .nullish(),
})

/** The vocabulary key each mapped slug answers, by record kind. */
export const ANSWER_KEYS: {
  readonly [K in 'company' | 'person']: { readonly [slug: string]: string }
} = {
  company: {
    description: 'company.description',
    founded_year: 'company.founded_year',
    location: 'company.location',
    linkedin: 'company.linkedin',
  },
  person: {
    job_title: 'person.title',
    location: 'person.location',
    linkedin: 'person.linkedin',
    twitter: 'person.twitter',
  },
}

/** Slug-keyed values as vocabulary answers; a slug with no key is dropped. */
const answersOf = (
  kind: 'company' | 'person',
  values: FactValues,
): { [key: string]: JsonValue } => {
  const out: { [key: string]: JsonValue } = {}
  for (const [slug, value] of Object.entries(values)) {
    const keys = ANSWER_KEYS[kind]
    if (Object.hasOwn(keys, slug)) out[keys[slug]] = value
  }
  return out
}

/**
 * What one Apollo answer claims about the record it was asked about.
 * `alias` is null when Apollo returned no key worth adding; `answer` is null
 * when it returned no value.
 */
export type Enrichment = {
  readonly matched: boolean
  readonly receipt: ReceiptClaim
  readonly alias: AliasClaim | null
  readonly answer: (receiptId: string) => AnswerClaim | null
  /** What Apollo observed that is evidence, not a value, citing the receipt. */
  readonly signals: (receiptId: string) => ReadonlyArray<SignalClaim>
}

const enrichment = (
  kind: 'company' | 'person',
  entityId: EntityId,
  raw: JsonValue,
  found: {
    readonly keys: IdentityKeys
    readonly values: FactValues
    readonly signals?: (receiptId: string) => ReadonlyArray<SignalClaim>
  } | null,
): Enrichment => {
  const keys = found?.keys ?? {}
  const answers = answersOf(kind, found?.values ?? {})
  return {
    signals: found?.signals ?? (() => []),
    matched: found !== null,
    receipt: {
      entityId,
      raw,
      creditsUsed: found === null ? 0 : CREDITS_PER_MATCH,
    },
    alias: Object.keys(keys).length === 0 ? null : { entityId, keys },
    answer: (receiptId) =>
      Object.keys(answers).length === 0
        ? null
        : { entityId, answers, receiptId },
  }
}

/** Throws when `raw` is not an organization response. */
export const organizationEnrichment = (
  entityId: EntityId,
  raw: JsonValue,
): Enrichment => {
  const org = organizationResponse.parse(raw).organization
  if (org == null) return enrichment('company', entityId, raw, null)
  const domain = org.primary_domain ?? org.website_url
  const location = place(org.city, org.country)
  const round = latestRound(org)
  return enrichment('company', entityId, raw, {
    signals: (receiptId) =>
      round === null ? [] : [fundingSignal(entityId, receiptId, round)],
    keys: domain ? { domain } : {},
    values: {
      ...(org.short_description ? { description: org.short_description } : {}),
      ...(org.founded_year ? { founded_year: org.founded_year } : {}),
      ...(location ? { location } : {}),
      ...(org.linkedin_url ? { linkedin: org.linkedin_url } : {}),
    },
  })
}

/**
 * Apollo's stand-in for an email the plan has not revealed — an address,
 * but nobody's.
 */
const LOCKED_EMAIL = /^email_not_unlocked@/i

/**
 * Throws when `raw` is not a person response. A role email (`info@`) never
 * becomes an identity key (`isRoleEmail`), and neither does a locked one.
 * A title that differs from the one the record holds (`heldTitle`) is a
 * hiring change: a signal dated by the current role's start.
 */
export const personEnrichment = (
  entityId: EntityId,
  raw: JsonValue,
  heldTitle: string | null = null,
): Enrichment => {
  const person = personResponse.parse(raw).person
  if (person == null) return enrichment('person', entityId, raw, null)
  const held = heldTitle?.trim() ?? ''
  const title = person.title
  const org = person.organization?.name ?? null
  const started = isoOf(
    (person.employment_history ?? []).find((e) => e.current === true)
      ?.start_date,
  )
  const move =
    held !== '' && title != null && title !== held
      ? {
          title: org === null ? `Now ${title}` : `Now ${title} at ${org}`,
          ...(started === null ? {} : { publishedAt: started }),
          payload: present({ from: held, to: title, at: org }),
        }
      : null
  const hiring = (receiptId: string): ReadonlyArray<SignalClaim> =>
    move === null
      ? []
      : [{ _tag: 'signal', entityId, kind: 'hiring', ...move, receiptId }]
  const email =
    person.email &&
    !isRoleEmail(person.email) &&
    !LOCKED_EMAIL.test(person.email)
      ? person.email
      : null
  const location = place(person.city, person.country)
  return enrichment('person', entityId, raw, {
    signals: hiring,
    keys: email ? { email } : {},
    values: {
      ...(person.title ? { job_title: person.title } : {}),
      ...(location ? { location } : {}),
      ...(person.linkedin_url ? { linkedin: person.linkedin_url } : {}),
      ...(person.twitter_url ? { twitter: person.twitter_url } : {}),
    },
  })
}

const errorBody = z.union([
  z.object({ error: z.string().min(1) }),
  z.object({ message: z.string().min(1) }),
  z.object({ errors: z.array(z.string()).min(1) }),
])

/**
 * Apollo's own sentence from an error response — its `error`, `message` or
 * `errors` field, else the body as text — so the operator reads what Apollo
 * said, not our paraphrase of a status code.
 */
export const apolloMessage = (body: string): string => {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  const parsed = errorBody.safeParse(json)
  if (parsed.success) {
    const e = parsed.data
    return 'error' in e
      ? e.error
      : 'message' in e
        ? e.message
        : e.errors.join('; ')
  }
  const trimmed = body.trim()
  return trimmed === '' ? '(no message)' : trimmed.slice(0, 500)
}
