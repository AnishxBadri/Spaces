import { z } from 'zod'
import type {
  EntityId,
  FactClaim,
  IdentityClaim,
  JsonValue,
  ReceiptClaim,
} from '@spaces/sdk'

/**
 * The provider payload an enrichment job gets back — shaped like an Apollo
 * organization-enrich response, the fields this fixture reads and nothing
 * more. Parsed, never trusted: an absent field is simply not claimed.
 */
const organizationResponse = z.object({
  organization: z.object({
    name: z.string().min(1),
    primary_domain: z.string().min(1).nullish(),
    linkedin_url: z.string().min(1).nullish(),
    founded_year: z.int().nullish(),
    short_description: z.string().min(1).nullish(),
    city: z.string().min(1).nullish(),
    country: z.string().min(1).nullish(),
  }),
  credits_consumed: z.int().nonnegative().nullish(),
})

/**
 * The pure half of the `enrich` job: provider JSON in, claims out (D52 —
 * the job then calls the ports with them: `Identity.resolve(identity)`,
 * `Receipts.store(receipt(id))`, `Facts.fill(facts(id, receiptId))`). The
 * identity is claimable before any id exists; the receipt and the facts
 * name the entity the resolve returned, so they are functions of it.
 */
export const toClaims = (raw: JsonValue) => {
  const { organization: org, credits_consumed } =
    organizationResponse.parse(raw)
  const location = [org.city, org.country].filter(Boolean).join(', ')

  const identity: IdentityClaim = {
    kind: 'company',
    name: org.name,
    keys: {
      ...(org.primary_domain ? { domain: org.primary_domain } : {}),
      ...(org.linkedin_url ? { linkedin: org.linkedin_url } : {}),
    },
  }

  const values = {
    ...(org.short_description ? { description: org.short_description } : {}),
    ...(org.founded_year ? { founded_year: org.founded_year } : {}),
    ...(location ? { location } : {}),
  }

  const receipt = (entityId: EntityId): ReceiptClaim => ({
    entityId,
    raw,
    ...(credits_consumed == null ? {} : { creditsUsed: credits_consumed }),
  })

  const facts = (entityId: EntityId, receiptId: string): FactClaim => ({
    entityId,
    values,
    receiptId,
  })

  return { identity, receipt, facts }
}
