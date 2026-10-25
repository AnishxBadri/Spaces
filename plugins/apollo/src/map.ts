import { z } from 'zod'
import { vocabularyProblem } from '@spaces/sdk'
import { isRoleEmail, normalizeDomain } from '@spaces/sdk/identity'
import type {
  AliasClaim,
  AnswerClaim,
  EntityId,
  IdentityKeys,
  JsonObject,
  JsonValue,
  ReceiptClaim,
  SignalClaim,
} from '@spaces/sdk'

/**
 * The pure half of the Apollo jobs: what to ask, and what Apollo's answer
 * claims. Provider JSON in, port arguments out — no Effect, no ports.
 * - Fields are parsed, never trusted: an absent or null field claims nothing,
 *   and a value the vocabulary would refuse is left in the receipt only.
 * - Answers are vocabulary keys; the host decides which attribute,
 *   if any, each one fills. Apollo's own ids stay in the receipt.
 * - A domain or a verified email is an identity key; a LinkedIn URL is a
 *   value.
 * - The latest round and a change of role are keyed signals, never values:
 *   dated evidence citing the receipt, written once however often it runs.
 * - Not read: departmental head count, Alexa ranking, retail location
 *   count, Apollo's tag ids.
 */

export const APOLLO_API = 'https://api.apollo.io/api/v1'

/** One enrichment, one credit (Apollo's unit) — `cost` and the receipt agree. */
export const CREDITS_PER_MATCH = 1

/**
 * What asking for a person's phone adds, in Apollo credits — its price for
 * revealing a mobile number. Only spent with the `phone` setting on.
 */
export const PHONE_CREDITS = 8

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

const count = z.number().finite().min(0).nullish().catch(null)

const texts = z
  .array(z.string().catch(''))
  .transform((items) => items.map((s) => s.trim()).filter((s) => s !== ''))
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

/** The domain a URL or a bare host names, or null. */
const domainOf = (url: string | null | undefined): string | null =>
  url == null ? null : normalizeDomain(url)

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

const phoneOf = z
  .object({ sanitized_number: text, number: text })
  .nullish()
  .catch(null)

/** `organizations/enrich` — `{ organization }`, or `{}` for no match. */
const organizationResponse = z.object({
  organization: z
    .object({
      name: text,
      primary_domain: text,
      website_url: text,
      linkedin_url: text,
      twitter_url: text,
      facebook_url: text,
      angellist_url: text,
      crunchbase_url: text,
      blog_url: text,
      logo_url: text,
      founded_year: z.int().min(1000).max(9999).nullish().catch(null),
      short_description: text,
      seo_description: text,
      city: text,
      country: text,
      raw_address: text,
      industry: text,
      keywords: texts,
      technology_names: texts,
      estimated_num_employees: count,
      annual_revenue: count,
      total_funding: count,
      publicly_traded_symbol: text,
      primary_phone: phoneOf,
      phone: text,
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
 * The answers the vocabulary takes, absent and refused values left out —
 * a malformed URL from Apollo stays in the receipt rather than failing the
 * whole answer.
 */
const answersOf = (candidates: {
  readonly [key: string]: JsonValue | null | undefined
}): { [key: string]: JsonValue } => {
  const out: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(candidates))
    if (value != null && vocabularyProblem(key, value) === null)
      out[key] = value
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

/** A round as the signal the record's timeline shows, keyed on round and day. */
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
    key: `funding:${round.type ?? 'round'}:${round.at.slice(0, 10)}`,
  }
}

/** `people/match` — `{ person }`, with `person: null` for no match. */
const personResponse = z.object({
  person: z
    .object({
      email: text,
      email_status: text,
      linkedin_url: text,
      twitter_url: text,
      github_url: text,
      facebook_url: text,
      photo_url: text,
      title: text,
      headline: text,
      city: text,
      country: text,
      seniority: text,
      departments: texts,
      phone_numbers: z.array(phoneOf).nullish().catch(null),
      organization: z
        .object({ name: text, primary_domain: text, website_url: text })
        .nullish()
        .catch(null),
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

/** Apollo's seniority codes as the words a person reads. */
const SENIORITY: { readonly [code: string]: string } = {
  owner: 'Owner',
  founder: 'Founder',
  c_suite: 'C-suite',
  partner: 'Partner',
  vp: 'VP',
  head: 'Head',
  director: 'Director',
  manager: 'Manager',
  senior: 'Senior',
  entry: 'Entry',
  intern: 'Intern',
}

/** `master_engineering_technical` → `Engineering technical`. */
const words = (code: string): string => {
  const plain = code
    .replace(/^master_/, '')
    .replace(/_/g, ' ')
    .trim()
  return plain === '' ? code : plain[0].toUpperCase() + plain.slice(1)
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
  entityId: EntityId,
  raw: JsonValue,
  credits: number,
  found: {
    readonly keys: IdentityKeys
    readonly answers: { readonly [key: string]: JsonValue }
    readonly signals: (receiptId: string) => ReadonlyArray<SignalClaim>
  } | null,
): Enrichment => {
  const keys = found?.keys ?? {}
  const answers = found?.answers ?? {}
  return {
    signals: found?.signals ?? (() => []),
    matched: found !== null,
    receipt: { entityId, raw, creditsUsed: found === null ? 0 : credits },
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
  if (org == null) return enrichment(entityId, raw, CREDITS_PER_MATCH, null)
  const domain = org.primary_domain ?? org.website_url
  const round = latestRound(org)
  const phone =
    org.primary_phone?.sanitized_number ??
    org.primary_phone?.number ??
    org.phone
  return enrichment(entityId, raw, CREDITS_PER_MATCH, {
    signals: (receiptId) =>
      round === null ? [] : [fundingSignal(entityId, receiptId, round)],
    keys: domain ? { domain } : {},
    answers: answersOf({
      'company.description': org.short_description ?? org.seo_description,
      'company.founded_year': org.founded_year,
      'company.location': place(org.city, org.country) || null,
      'company.linkedin': org.linkedin_url,
      'company.funding_stage': org.latest_funding_stage,
      'company.total_raised': org.total_funding,
      'company.headcount': org.estimated_num_employees,
      'company.revenue': org.annual_revenue,
      'company.industry': org.industry,
      'company.keywords': org.keywords?.length ? org.keywords : null,
      'company.tech_stack': org.technology_names?.length
        ? org.technology_names
        : null,
      'company.twitter': org.twitter_url,
      'company.facebook': org.facebook_url,
      'company.angellist': org.angellist_url,
      'company.crunchbase': org.crunchbase_url,
      'company.blog': org.blog_url,
      'company.phone': phone,
      'company.address': org.raw_address,
      'company.ticker': org.publicly_traded_symbol,
      'company.logo': org.logo_url,
    }),
  })
}

/**
 * Apollo's stand-in for an email the plan has not revealed — an address,
 * but nobody's.
 */
const LOCKED_EMAIL = /^email_not_unlocked@/i

/** A company the person record links, as the job read it. */
export type HeldCompany = {
  readonly name: string
  readonly domains: ReadonlyArray<string>
}

/** What the person record holds that the mapping judges Apollo against. */
export type HeldPerson = {
  readonly title: string | null
  readonly description: string | null
  readonly companies: ReadonlyArray<HeldCompany>
}

export const NOTHING_HELD: HeldPerson = {
  title: null,
  description: null,
  companies: [],
}

/** What the owner's settings let a person answer carry. */
export type PersonOptions = { readonly phone: boolean }

const sameCompany = (
  held: HeldCompany,
  org: { readonly name: string | null; readonly domain: string | null },
) =>
  (org.domain !== null &&
    held.domains.some((d) => normalizeDomain(d) === org.domain)) ||
  (org.name !== null && held.name.toLowerCase() === org.name.toLowerCase())

/**
 * Throws when `raw` is not a person response.
 * - The email is an identity key only when Apollo marks it verified and it
 *   is neither a role address (`isRoleEmail`) nor a locked one.
 * - The headline answers the description only while the record has none.
 * - The company is answered by name and domain; the host links an existing
 *   one or proposes it, and never creates it.
 * - A company or title other than the one held is a move: one signal,
 *   dated by the current role's start and keyed on the new role.
 * - The phone is answered only with the `phone` setting on.
 */
export const personEnrichment = (
  entityId: EntityId,
  raw: JsonValue,
  held: HeldPerson = NOTHING_HELD,
  options: PersonOptions = { phone: false },
): Enrichment => {
  const person = personResponse.parse(raw).person
  const credits = CREDITS_PER_MATCH + (options.phone ? PHONE_CREDITS : 0)
  if (person == null) return enrichment(entityId, raw, credits, null)
  const title = person.title ?? null
  const orgName = person.organization?.name ?? null
  const org = {
    name: orgName,
    domain:
      domainOf(person.organization?.primary_domain) ??
      domainOf(person.organization?.website_url),
  }
  const started = isoOf(
    (person.employment_history ?? []).find((e) => e.current === true)
      ?.start_date,
  )
  const heldTitle = held.title?.trim() ?? ''
  const at = orgName ?? org.domain
  // The company left: the first one held, when Apollo names none of them.
  const left =
    at === null || held.companies.some((c) => sameCompany(c, org))
      ? undefined
      : held.companies.at(0)
  const retitled = heldTitle !== '' && title !== null && title !== heldTitle
  const move =
    left !== undefined && at !== null
      ? {
          title: `Moved from ${left.name} to ${at}${title === null ? '' : ` as ${title}`}`,
          payload: present({
            from: left.name,
            to: at,
            title,
            previousTitle: heldTitle,
          }),
        }
      : retitled
        ? {
            title: at === null ? `Now ${title}` : `Now ${title} at ${at}`,
            payload: present({ from: heldTitle, to: title, at }),
          }
        : null
  const signals = (receiptId: string): ReadonlyArray<SignalClaim> =>
    move === null
      ? []
      : [
          {
            _tag: 'signal',
            entityId,
            kind: 'hiring',
            ...move,
            ...(started === null ? {} : { publishedAt: started }),
            receiptId,
            key: `role:${org.domain ?? orgName ?? ''}:${title ?? ''}`,
          },
        ]
  const email =
    person.email &&
    person.email_status === 'verified' &&
    !isRoleEmail(person.email) &&
    !LOCKED_EMAIL.test(person.email)
      ? person.email
      : null
  const phone = (person.phone_numbers ?? [])
    .map((p) => p?.sanitized_number ?? p?.number ?? null)
    .find((p) => p != null)
  const department = person.departments?.at(0)
  return enrichment(entityId, raw, credits, {
    signals,
    keys: email ? { email } : {},
    answers: answersOf({
      'person.title': title,
      'person.description':
        (held.description?.trim() ?? '') === '' ? person.headline : null,
      'person.location': place(person.city, person.country) || null,
      'person.linkedin': person.linkedin_url,
      'person.twitter': person.twitter_url,
      'person.company':
        orgName !== null && org.domain !== null
          ? { name: orgName, domain: org.domain }
          : null,
      'person.seniority':
        person.seniority == null
          ? null
          : (SENIORITY[person.seniority] ?? words(person.seniority)),
      'person.department': department === undefined ? null : words(department),
      'person.github': person.github_url,
      'person.facebook': person.facebook_url,
      'person.photo': person.photo_url,
      'person.phone': options.phone ? phone : null,
    }),
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
