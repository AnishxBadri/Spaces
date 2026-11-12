import { Schema } from 'effect'
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
const organizationResponse = Schema.Struct({
  organization: Schema.Struct({
    name: Schema.NonEmptyString,
    primary_domain: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
    linkedin_url: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
    founded_year: Schema.optional(Schema.NullOr(Schema.Int)),
    short_description: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
    city: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
    country: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  }),
  credits_consumed: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
})

/**
 * The pure half of the `enrich` job: provider JSON in, claims out. The job
 * then calls the ports with them: `Identity.resolve(identity)`,
 * `Receipts.store(receipt(id))`, `Facts.fill(facts(id, receiptId))`. The
 * identity is claimable before any id exists; the receipt and the facts
 * name the entity the resolve returned, so they are functions of it.
 */
export const toClaims = (raw: JsonValue) => {
  const { organization: org, credits_consumed } =
    Schema.decodeUnknownSync(organizationResponse)(raw)
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
