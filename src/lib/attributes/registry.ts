import { z } from 'zod'
import type { BadgeColor } from './colors'

/**
 * The attribute type menu — fixed in code; users define attributes, never
 * types. Each type owns its value validator; option-dependent types get the
 * attribute's options at validation time.
 */

export type ObjectKind = 'company' | 'person' | 'deal'

/**
 * The seeded system rows of the object registry (one registry, system
 * rows — CONTEXT.md "Two-tier object model"). Slugs are plural, matching
 * the rule custom objects follow (slug derived from the plural noun).
 */
export const CORE_OBJECTS: Record<
  ObjectKind,
  { slug: string; singular: string; plural: string }
> = {
  company: { slug: 'companies', singular: 'Company', plural: 'Companies' },
  person: { slug: 'people', singular: 'Person', plural: 'People' },
  deal: { slug: 'deals', singular: 'Deal', plural: 'Deals' },
}

export type AttributeType =
  | 'text'
  | 'number'
  | 'currency'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'domain'
  | 'email'
  | 'url'
  | 'phone'
  | 'rating'
  | 'record_reference'
  | 'actor_reference'

export type SelectOption = {
  id: string
  label: string
  /** status only: funnel semantics for kanban/filters */
  group?: 'active' | 'parked' | 'closed'
  /** one of BADGE_COLORS; absent falls back to the option's position */
  color?: BadgeColor
}

export type AttributeOptions = {
  options?: Array<SelectOption>
  /** record_reference */
  targetKind?: ObjectKind
  multi?: boolean
  required?: boolean
  /** currency */
  code?: string
  /** rating */
  max?: number
  /** number: display decimals; stored numbers untouched */
  precision?: number
  /**
   * Default (spec §4): a static value in the type's write shape, or one of
   * exactly two dynamic forms — `'current-user'` (actor_reference) and an
   * ISO-8601 duration for dates (`'P7D'` = a week out). Fires on every
   * creation path, fills blanks only. Validated at attribute save
   * (`validateDefault`), resolved at record birth (`resolveDefault`).
   */
  default?: unknown
}

export type AttributeDef = {
  id: string
  objectId: string
  slug: string
  name: string
  type: AttributeType
  options: AttributeOptions
  isSystem: boolean
  archived: boolean
  sortOrder: number
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/** Validator for one attribute's value (null clears — always allowed). */
export function valueValidator(def: Pick<AttributeDef, 'type' | 'options'>) {
  const optionIds = (def.options.options ?? []).map((o) => o.id) as [
    string,
    ...Array<string>,
  ]
  switch (def.type) {
    case 'text':
      return z.string().max(2000)
    case 'domain':
      return z.string().max(255)
    case 'phone':
      return z.string().max(40)
    case 'email':
      return z.string().email().max(255)
    case 'url':
      return z.string().url().max(500)
    case 'number':
      return z.number().finite()
    case 'currency':
      return z.number().finite()
    case 'rating':
      return z
        .number()
        .int()
        .min(1)
        .max(def.options.max ?? 5)
    case 'date':
      return dateString
    case 'checkbox':
      return z.boolean()
    case 'select':
    case 'status':
      return optionIds.length > 0 ? z.enum(optionIds) : z.never()
    case 'multi_select':
      return optionIds.length > 0
        ? z.array(z.enum(optionIds)).max(50)
        : z.never()
    case 'record_reference':
      return def.options.multi
        ? z.array(z.string().uuid()).max(100)
        : z.string().uuid()
    case 'actor_reference':
      return z.string().max(64)
  }
}

// ---------------------------------------------------------------------------
// Seeded system attributes (CONTEXT.md "Seeded system attributes").
// Idempotent: seed inserts what's missing, never overwrites — options are
// user-editable content after first boot.
// ---------------------------------------------------------------------------

type SeedDef = {
  slug: string
  name: string
  type: AttributeType
  options?: AttributeOptions
}

const opt = (
  id: string,
  label: string,
  group?: SelectOption['group'],
  color?: BadgeColor,
) => ({
  id,
  label,
  ...(group ? { group } : {}),
  ...(color ? { color } : {}),
})

export const SYSTEM_ATTRIBUTES: Record<ObjectKind, Array<SeedDef>> = {
  company: [
    { slug: 'description', name: 'Description', type: 'text' },
    {
      slug: 'business_model',
      name: 'Business model',
      type: 'multi_select',
      options: {
        options: [
          opt('b2b', 'B2B'),
          opt('b2c', 'B2C'),
          opt('b2b2c', 'B2B2C'),
          opt('marketplace', 'Marketplace'),
          opt('hardware', 'Hardware'),
          opt('deep_tech', 'Deep tech'),
          opt('services', 'Services'),
        ],
      },
    },
    {
      slug: 'funding_stage',
      name: 'Funding stage',
      type: 'select',
      options: {
        options: [
          opt('pre_seed', 'Pre-seed', undefined, 'slate'),
          opt('seed', 'Seed', undefined, 'cyan'),
          opt('series_a', 'Series A', undefined, 'blue'),
          opt('series_b_plus', 'Series B+', undefined, 'indigo'),
          opt('public', 'Public', undefined, 'emerald'),
          opt('bootstrapped', 'Bootstrapped', undefined, 'lime'),
        ],
      },
    },
    { slug: 'location', name: 'Location', type: 'text' },
    { slug: 'founded_year', name: 'Founded', type: 'number' },
    { slug: 'linkedin', name: 'LinkedIn', type: 'url' },
  ],
  person: [
    { slug: 'job_title', name: 'Job title', type: 'text' },
    { slug: 'description', name: 'Description', type: 'text' },
    { slug: 'location', name: 'Location', type: 'text' },
    { slug: 'linkedin', name: 'LinkedIn', type: 'url' },
    { slug: 'twitter', name: 'Twitter', type: 'url' },
    { slug: 'phone', name: 'Phone', type: 'phone' },
  ],
  deal: [
    {
      slug: 'stage',
      name: 'Stage',
      type: 'status',
      options: {
        options: [
          opt('pre_lead', 'Pre-lead', 'active', 'slate'),
          opt('screening', 'Screening', 'active', 'cyan'),
          opt('meeting', 'Meeting', 'active', 'blue'),
          opt('diligence', 'Diligence', 'active', 'indigo'),
          opt('term_sheet', 'Term sheet', 'active', 'violet'),
          opt('early_revisit', 'Early — revisit', 'parked', 'amber'),
          opt('invested', 'Invested', 'closed', 'emerald'),
          opt('passed', 'Passed', 'closed', 'rose'),
          opt('lost', 'Lost', 'closed', 'fuchsia'),
        ],
      },
    },
    {
      slug: 'value',
      name: 'Value',
      type: 'currency',
      options: { code: 'USD' },
    },
    {
      slug: 'company',
      name: 'Company',
      type: 'record_reference',
      options: { targetKind: 'company', multi: false, required: true },
    },
    {
      slug: 'people',
      name: 'People',
      type: 'record_reference',
      options: { targetKind: 'person', multi: true },
    },
    {
      // New deals arrive owned — the most repetitive click in deal capture.
      // Existing deployments get this default via migration 0019 (the seed
      // never rewrites rows a user may have edited).
      slug: 'owner',
      name: 'Owner',
      type: 'actor_reference',
      options: { default: 'current-user' },
    },
    { slug: 'close_date', name: 'Close date', type: 'date' },
    {
      slug: 'source',
      name: 'Source',
      type: 'select',
      options: {
        options: [
          opt('inbound', 'Inbound', undefined, 'blue'),
          opt('referral', 'Referral', undefined, 'emerald'),
          opt('outbound', 'Outbound', undefined, 'orange'),
          opt('event', 'Event', undefined, 'violet'),
        ],
      },
    },
    {
      // Post-mortem memory (CONTEXT.md): Passed and Lost carry distinct
      // lessons — the reason is captured at close time, while it's fresh.
      slug: 'close_reason',
      name: 'Close reason',
      type: 'text',
      options: {},
    },
  ],
}
