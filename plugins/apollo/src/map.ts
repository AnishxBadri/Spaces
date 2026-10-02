import { z } from 'zod'
import { isRoleEmail } from '@spaces/sdk/identity'
import type {
  AliasClaim,
  EntityId,
  FactClaim,
  FactValues,
  IdentityKeys,
  JsonValue,
  ReceiptClaim,
} from '@spaces/sdk'

/**
 * The pure half of the Apollo jobs: what to ask, and what Apollo's answer
 * claims. Provider JSON in, port arguments out — no Effect, no ports.
 * - Fields are parsed, never trusted: an absent or null field claims nothing.
 * - Values are keyed by the slugs `SYSTEM_ATTRIBUTES` seeds for the kind.
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
    })
    .nullish(),
})

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
    })
    .nullish(),
})

/**
 * What one Apollo answer claims about the record it was asked about.
 * `alias` is null when Apollo returned no key worth adding; `facts` is null
 * when it returned no value.
 */
export type Enrichment = {
  readonly matched: boolean
  readonly receipt: ReceiptClaim
  readonly alias: AliasClaim | null
  readonly facts: (receiptId: string) => FactClaim | null
}

const enrichment = (
  entityId: EntityId,
  raw: JsonValue,
  found: { readonly keys: IdentityKeys; readonly values: FactValues } | null,
): Enrichment => {
  const keys = found?.keys ?? {}
  const values = found?.values ?? {}
  return {
    matched: found !== null,
    receipt: {
      entityId,
      raw,
      creditsUsed: found === null ? 0 : CREDITS_PER_MATCH,
    },
    alias: Object.keys(keys).length === 0 ? null : { entityId, keys },
    facts: (receiptId) =>
      Object.keys(values).length === 0 ? null : { entityId, values, receiptId },
  }
}

/** Throws when `raw` is not an organization response. */
export const organizationEnrichment = (
  entityId: EntityId,
  raw: JsonValue,
): Enrichment => {
  const org = organizationResponse.parse(raw).organization
  if (org == null) return enrichment(entityId, raw, null)
  const domain = org.primary_domain ?? org.website_url
  const location = place(org.city, org.country)
  return enrichment(entityId, raw, {
    keys: {
      ...(domain ? { domain } : {}),
      ...(org.linkedin_url ? { linkedin: org.linkedin_url } : {}),
    },
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
 */
export const personEnrichment = (
  entityId: EntityId,
  raw: JsonValue,
): Enrichment => {
  const person = personResponse.parse(raw).person
  if (person == null) return enrichment(entityId, raw, null)
  const email =
    person.email &&
    !isRoleEmail(person.email) &&
    !LOCKED_EMAIL.test(person.email)
      ? person.email
      : null
  const location = place(person.city, person.country)
  return enrichment(entityId, raw, {
    keys: {
      ...(email ? { email } : {}),
      ...(person.linkedin_url ? { linkedin: person.linkedin_url } : {}),
    },
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
