import { z } from 'zod'
import { ENRICHMENT_VOCABULARY, isVocabularyKey } from '@spaces/sdk/vocabulary'
import type { VocabularyType } from '@spaces/sdk/vocabulary'
import type {
  AttributeOptions,
  ObjectKind,
  SelectOption,
} from '@spaces/db/schema/attributes'
import type { IdentityKey } from '@spaces/db/schema/objects'
import type { CoreIdentityKey } from '@spaces/db/schema/entities'
import {
  domainHost,
  isRoleEmail,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
} from '@spaces/sdk/identity'
import type { BadgeColor } from './colors'
import { phoneProblem, toE164 } from './phone'

/**
 * The attribute type menu — fixed in code; users define attributes, never
 * types. Each type owns its value validator; option-dependent types get the
 * attribute's options at validation time.
 *
 * `ObjectKind`, `SelectOption` and `AttributeOptions` are declared at the
 * `attribute.options` column (`@spaces/db/schema/attributes`), `IdentityKey`
 * at the `object.identity_keys` column, and all four are re-exported here
 * unchanged — packages/db imports nothing internal, and the column owns the
 * shape of what it stores.
 */
export type {
  AttributeOptions,
  CoreIdentityKey,
  IdentityKey,
  ObjectKind,
  SelectOption,
}

/** The three core kinds, as a list — iteration order for the seeder. */
export const OBJECT_KINDS: Array<ObjectKind> = ['company', 'person', 'deal']

/**
 * The seeded system rows of the object registry (one registry: custom
 * objects sit beside these). Slugs are plural, matching the rule custom
 * objects follow (slug derived from the plural noun).
 */
export const CORE_OBJECTS: Record<
  ObjectKind,
  { slug: string; singular: string; plural: string }
> = {
  company: { slug: 'companies', singular: 'Company', plural: 'Companies' },
  person: { slug: 'people', singular: 'Person', plural: 'People' },
  deal: { slug: 'deals', singular: 'Deal', plural: 'Deals' },
}

/** entity.kind is the wider enum; this is the core-object narrowing. */
export function toObjectKind(kind: string): ObjectKind | null {
  return kind === 'company' || kind === 'person' || kind === 'deal'
    ? kind
    : null
}

/**
 * An attribute's slug, from its name — derived once at creation and frozen.
 * The create program suffixes it on collision; the import mapping
 * slugifies a sheet's header with it so `Close date` finds `close_date`.
 */
export function slugifyAttributeName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'attribute'
  )
}

/**
 * The identity keys a custom object may declare, and the attribute each one
 * materializes. The slug falls out of the name through the same
 * slugifier every attribute uses, which is what makes `domain` and
 * `linkedin` predictable to the write path.
 */
export const IDENTITY_KEYS: Array<IdentityKey> = ['domain', 'linkedin']

export const IDENTITY_KEY_ATTRIBUTES: Record<
  IdentityKey,
  { slug: string; name: string; type: AttributeType; help: string }
> = {
  domain: {
    slug: 'domain',
    name: 'Domain',
    type: 'domain',
    help: 'the website that identifies the record',
  },
  linkedin: {
    slug: 'linkedin',
    name: 'LinkedIn',
    type: 'url',
    help: 'the LinkedIn page that identifies the record',
  },
}

/**
 * Every alias kind that carries `is_identity` (`CoreIdentityKey` is derived
 * from the `alias_kind` enum). `resolveEntity`'s normalizer table is keyed by
 * this type, so the two cannot disagree about what identifies a record.
 */
export const CORE_IDENTITY_KEYS: Array<CoreIdentityKey> = [
  'domain',
  'email',
  'linkedin',
]

/**
 * What identifies a person or a company, and the multi-valued system
 * attribute that holds it: a person's `emails`, a company's `domains`.
 * `setValues` mirrors each value into an identity alias; LinkedIn is a plain
 * attribute on both and identifies neither.
 */
export const CORE_IDENTITY: Record<
  'company' | 'person',
  { key: CoreIdentityKey; slug: string }
> = {
  company: { key: 'domain', slug: 'domains' },
  person: { key: 'email', slug: 'emails' },
}

/**
 * Keys that identify people and nothing else — refused on a custom object
 * rather than offered: the role-prefix rule behind them is core doctrine and
 * means nothing on an attribute bag.
 */
export const CORE_ONLY_IDENTITY_KEYS: Array<string> = CORE_IDENTITY_KEYS.filter(
  (k) => !IDENTITY_KEYS.some((declarable) => declarable === k),
)

/** An object row's core kind — a seeded system row's slug — or null for a custom object. */
export function coreKindOf(object: {
  slug: string
  isSystem: boolean
}): ObjectKind | null {
  if (!object.isSystem) return null
  return OBJECT_KINDS.find((k) => CORE_OBJECTS[k].slug === object.slug) ?? null
}

/**
 * The one answer to "what identifies a record of this object?". A company
 * carries its domains, a person their emails (`CORE_IDENTITY`), a deal
 * nothing, and a custom object exactly what it declared in
 * `object.identity_keys`.
 */
export function identityKeysOf(object: {
  slug: string
  isSystem: boolean
  identityKeys: ReadonlyArray<IdentityKey>
}): Array<CoreIdentityKey> {
  const kind = coreKindOf(object)
  if (kind === 'company' || kind === 'person') return [CORE_IDENTITY[kind].key]
  if (kind === 'deal') return []
  return [...object.identityKeys]
}

export const CORE_ONLY_IDENTITY_MESSAGE =
  'email identifies people, not custom records'

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

/**
 * The normal form each identity key is compared in — the same functions
 * `resolveEntity` and the alias writer use, so the validator and the alias
 * agree on what the value means by construction. Null: not a valid key.
 */
const IDENTITY_FORMS: Record<CoreIdentityKey, (raw: string) => string | null> =
  {
    domain: normalizeDomain,
    email: normalizeEmail,
    linkedin: normalizeLinkedin,
  }

/**
 * Whether `raw` is stored on an identity attribute but claims nothing: a
 * role address (`info@`, `team@` — `isRoleEmail`, the one list) on a
 * person's emails. It is real contact data, so it is kept, but it never
 * gains an `entity_alias` row, so nothing matches on it or births from it.
 */
export function isNonIdentityValue(key: CoreIdentityKey, raw: string): boolean {
  if (key !== 'email') return false
  const form = normalizeEmail(raw)
  return form !== null && isRoleEmail(form)
}

/**
 * One element of a multi-valued identity attribute as it is stored: a
 * domain as the host a record shows (`domainHost`), anything else trimmed.
 * Elements are compared on the identity normal form, never on this.
 */
export function identityElement(key: CoreIdentityKey, raw: string): string {
  return key === 'domain' ? (domainHost(raw) ?? raw.trim()) : raw.trim()
}

/**
 * Whether `raw` can be stored as one element of a core kind's identity
 * attribute — what `setValues` would accept — so a birth never claims a key
 * its own value write would refuse.
 */
export function storableIdentity(
  kind: 'company' | 'person',
  raw: string,
): boolean {
  const { slug } = CORE_IDENTITY[kind]
  const def = SYSTEM_ATTRIBUTES[kind].find((d) => d.slug === slug)
  if (!def) return false
  return valueValidator({
    type: def.type,
    options: def.options ?? {},
  }).safeParse([raw]).success
}

/**
 * The identity normal form of one element, or null when it identifies
 * nothing: an invalid key, or a non-identity one (`isNonIdentityValue`).
 */
export function identityNorm(key: CoreIdentityKey, raw: string): string | null {
  return isNonIdentityValue(key, raw) ? null : IDENTITY_FORMS[key](raw)
}

/**
 * The normal form an element is de-duplicated on: `identityNorm`, except a
 * non-identity value keeps one (`Info@acme.example` is `info@acme.example`).
 */
export function identityForm(key: CoreIdentityKey, raw: string): string | null {
  return IDENTITY_FORMS[key](raw)
}

/**
 * An identity-backed value has to survive normalization, because the claim
 * it makes is the normalized form; a role address survives it and
 * is stored as non-identity (`isNonIdentityValue`). `domain` is `z.string().max(255)`
 * for everyone else — deliberately permissive, it is a field like any other
 * — but on an attribute carrying `options.identityKey` a value that
 * normalizes to null would be stored and then silently claim nothing, which
 * is the one failure the whole mirror exists to prevent. Free mail is the
 * everyday case: gmail.com is a real domain and a real string, and it
 * identifies nobody.
 */
const identityValue = (
  base: z.ZodType<string, string>,
  key: CoreIdentityKey,
): z.ZodType<string, string> =>
  base.superRefine((raw, ctx) => {
    if (IDENTITY_FORMS[key](raw) !== null) return
    ctx.addIssue({
      code: 'custom',
      message: `${raw.trim().toLowerCase()} never identifies a record`,
    })
  })

/** Elements a multi-valued `email` or `domain` attribute may hold. */
const MAX_MULTI_TEXT = 50

/**
 * A multi-valued `email` / `domain` value: an array of elements, each
 * cleaned by `identityElement` and de-duplicated — on the identity normal
 * form when the attribute backs an identity key, on the cleaned text
 * otherwise. The first spelling wins.
 */
const multiText = (
  element: z.ZodType<string, string>,
  key: CoreIdentityKey | undefined,
  type: 'email' | 'domain',
) =>
  z
    .array(z.string().trim().pipe(element))
    .max(MAX_MULTI_TEXT)
    .transform((items) => {
      const seen = new Set<string>()
      const out: Array<string> = []
      for (const raw of items) {
        const value = identityElement(type, raw)
        const norm = key ? (identityForm(key, value) ?? value) : value
        if (seen.has(norm)) continue
        seen.add(norm)
        out.push(value)
      }
      return out
    })

/**
 * Validator for one attribute's value (null clears — always allowed).
 *
 * `held` is the value the record currently stores. An archived option is
 * history, not vocabulary: a write may keep one the record already
 * holds — a multi-select gaining a tag must not lose its retired one — but
 * never asserts one afresh.
 */
export function valueValidator(
  def: Pick<AttributeDef, 'type' | 'options'>,
  held?: unknown,
) {
  const options = def.options.options ?? []
  const identityKey = def.options.identityKey
  const heldIds = new Set(
    Array.isArray(held) ? held.map(String) : held == null ? [] : [String(held)],
  )
  // Not z.enum: that wants a non-empty literal tuple, which an option list
  // read out of the registry can never be without an assertion.
  const liveOption = () =>
    z.string().superRefine((id, ctx) => {
      const opt = options.find((o) => o.id === id)
      if (!opt) {
        ctx.addIssue({ code: 'custom', message: 'Not one of the options' })
        return
      }
      if (opt.archived && !heldIds.has(id))
        ctx.addIssue({
          code: 'custom',
          message: `"${opt.label}" is archived — pick a current option`,
        })
    })
  switch (def.type) {
    case 'text':
      return z.string().max(2000)
    case 'domain': {
      const base = z.string().max(255)
      const one = identityKey ? identityValue(base, identityKey) : base
      return def.options.multi ? multiText(one, identityKey, 'domain') : one
    }
    case 'phone': {
      // A number the record already holds is kept as written, so a value
      // stored before E.164 does not block the write that adds a second.
      const one = z
        .string()
        .trim()
        .max(40)
        .transform((raw, ctx) => {
          if (heldIds.has(raw)) return raw
          const e164 = toE164(raw)
          if (e164 !== null) return e164
          ctx.addIssue({ code: 'custom', message: phoneProblem(raw) })
          return z.NEVER
        })
      return def.options.multi
        ? z
            .array(one)
            .max(MAX_MULTI_TEXT)
            .transform((items) => [...new Set(items)])
        : one
    }
    case 'email': {
      const base = z.string().email().max(255)
      const one = identityKey ? identityValue(base, identityKey) : base
      return def.options.multi ? multiText(one, identityKey, 'email') : one
    }
    case 'url': {
      const base = z.string().url().max(500)
      return identityKey ? identityValue(base, identityKey) : base
    }
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
      return options.length > 0 ? liveOption() : z.never()
    case 'multi_select':
      return options.length > 0 ? z.array(liveOption()).max(50) : z.never()
    case 'record_reference':
      return def.options.multi
        ? z.array(z.string().uuid()).max(100)
        : z.string().uuid()
    case 'actor_reference':
      return z.string().max(64)
  }
}

// ---------------------------------------------------------------------------
// Fill from enrichment
// ---------------------------------------------------------------------------

/** The attribute types a vocabulary value type can be written into. */
const LINKABLE_TYPES: {
  readonly [T in VocabularyType]: ReadonlyArray<AttributeType>
} = {
  // A select fills by the option whose label the text matches exactly.
  text: ['text', 'select'],
  number: ['number', 'currency'],
  url: ['url', 'text'],
  phone: ['phone', 'text'],
  list: ['text'],
  // A picture key fills the record's picture, never an attribute.
  image: [],
  company: ['record_reference'],
}

/**
 * Why an attribute of `type` on an object of `kind` cannot fill from `key`,
 * or null when it can. A custom object has no vocabulary: its `kind` is null.
 * A `company` key needs a reference whose `targetKind` is company.
 */
export function enrichmentLinkProblem(
  type: AttributeType,
  kind: ObjectKind | null,
  key: string,
  targetKind?: string | null,
): string | null {
  if (!isVocabularyKey(key)) return `${key} is not in the enrichment vocabulary`
  const entry = ENRICHMENT_VOCABULARY[key]
  if (kind !== entry.kind) return `${key} describes a ${entry.kind}`
  if (!LINKABLE_TYPES[entry.type].includes(type))
    return `a ${type} attribute cannot hold ${key}, a ${entry.type}`
  if (entry.type === 'company' && targetKind !== 'company')
    return `${key} holds a company, not a ${targetKind ?? 'record'}`
  return null
}

// ---------------------------------------------------------------------------
// Seeded system attributes.
// Idempotent: seed inserts what's missing, never overwrites — options are
// user-editable content after first boot.
// ---------------------------------------------------------------------------

type SeedDef = {
  slug: string
  name: string
  type: AttributeType
  options?: AttributeOptions
  /**
   * Engine flags: the seeded attribute is born with its `attr_idx_<id>`
   * expression index. Only `deal.stage` carries them — every board, saved
   * view and the funnel group by it; an index nobody's query needs is a write
   * cost with no read. Set as a pair because the one dialog control sets both.
   */
  filterable?: boolean
  sortable?: boolean
  /**
   * The other half of a relationship. The seeder pairs the two rows
   * once both exist, writing `options.inverseOf` on each; the owner and the
   * `derived` half say which is which in `options`.
   */
  pair?: { kind: ObjectKind; slug: string }
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

/**
 * The seeded system attributes, per core kind.
 * - Sensitivity is not an attribute: an attribute can never reach a space or
 *   a document. It is the `entity.sensitive` column, read by `resolveSensitivity`.
 * - A person's `emails` and a company's `domains` are identity: multi-valued,
 *   carrying `options.identityKey`, mirrored into `entity_alias` by `setValues`.
 *   LinkedIn is a plain `url` on both.
 * - `options.enrichmentKey` is the default enrichment link; `seedEnrichmentLinks`
 *   adds it to installs seeded without it.
 * - Append new entries, never slot them: the seeder derives sortOrder from the
 *   array index and only inserts what is missing.
 */
export const SYSTEM_ATTRIBUTES: Record<ObjectKind, Array<SeedDef>> = {
  company: [
    {
      slug: 'description',
      name: 'Description',
      type: 'text',
      options: { enrichmentKey: 'company.description' },
    },
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
        enrichmentKey: 'company.funding_stage',
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
    {
      slug: 'location',
      name: 'Location',
      type: 'text',
      options: { enrichmentKey: 'company.location' },
    },
    {
      slug: 'founded_year',
      name: 'Founded',
      type: 'number',
      options: { enrichmentKey: 'company.founded_year' },
    },
    {
      slug: 'linkedin',
      name: 'LinkedIn',
      type: 'url',
      options: { enrichmentKey: 'company.linkedin' },
    },
    {
      // Where the deck reader puts the founders a company deck names, so a
      // deck filed on a bare company still proposes identities. Accepting one
      // writes the person here and the company to the person's `companies`.
      // Appended, never slotted.
      slug: 'founders',
      name: 'Founders',
      type: 'record_reference',
      options: { targetKind: 'person', multi: true },
    },
    {
      // Identity: every value is an `entity_alias` claim, so a domain
      // another company holds is refused at that element. Appended, never
      // slotted — the seeder derives sortOrder from the array index.
      slug: 'domains',
      name: 'Domains',
      type: 'domain',
      options: { multi: true, identityKey: 'domain' },
    },
    {
      // The people at this company: the inverse of a person's `companies`.
      // Stores nothing — `setValues` writes a person's `companies` instead.
      // Appended, never slotted.
      slug: 'team',
      name: 'Team',
      type: 'record_reference',
      options: {
        targetKind: 'person',
        multi: true,
        cardinality: 'N:N',
        derived: true,
      },
      pair: { kind: 'person', slug: 'companies' },
    },
    {
      // The deals naming this company: the inverse of a deal's `company`.
      // Stores nothing. Appended, never slotted.
      slug: 'associated_deals',
      name: 'Associated deals',
      type: 'record_reference',
      options: {
        targetKind: 'deal',
        multi: true,
        cardinality: '1:N',
        derived: true,
      },
      pair: { kind: 'deal', slug: 'company' },
    },
  ],
  person: [
    {
      slug: 'job_title',
      name: 'Job title',
      type: 'text',
      options: { enrichmentKey: 'person.title' },
    },
    {
      slug: 'description',
      name: 'Description',
      type: 'text',
      options: { enrichmentKey: 'person.description' },
    },
    {
      slug: 'location',
      name: 'Location',
      type: 'text',
      options: { enrichmentKey: 'person.location' },
    },
    {
      slug: 'linkedin',
      name: 'LinkedIn',
      type: 'url',
      options: { enrichmentKey: 'person.linkedin' },
    },
    {
      slug: 'twitter',
      name: 'Twitter',
      type: 'url',
      options: { enrichmentKey: 'person.twitter' },
    },
    // Unlinked by default: a phone costs extra credits and is opt-in.
    { slug: 'phone', name: 'Phone', type: 'phone', options: { multi: true } },
    {
      // The companies this person is at: angels, advisors and co-investors
      // sit at several, hence multi. The write path materializes
      // `link(references, 'companies')`. Appended, never slotted.
      slug: 'companies',
      name: 'Companies',
      type: 'record_reference',
      options: {
        targetKind: 'company',
        multi: true,
        enrichmentKey: 'person.company',
        cardinality: 'N:N',
      },
      // The owner of the pair a company's `team` reads.
      pair: { kind: 'company', slug: 'team' },
    },
    {
      // Identity, like a company's domains. Appended, never slotted.
      slug: 'emails',
      name: 'Emails',
      type: 'email',
      options: { multi: true, identityKey: 'email' },
    },
    // The name in two parts; `setValues` keeps `canonical_name` their
    // join. Appended, never slotted — the record page draws them as one cell.
    { slug: 'first_name', name: 'First name', type: 'text' },
    { slug: 'last_name', name: 'Last name', type: 'text' },
    {
      // The deals this person is on: the inverse of a deal's `people`.
      // Stores nothing. Appended, never slotted.
      slug: 'deals',
      name: 'Deals',
      type: 'record_reference',
      options: {
        targetKind: 'deal',
        multi: true,
        cardinality: 'N:N',
        derived: true,
      },
      pair: { kind: 'deal', slug: 'people' },
    },
  ],
  deal: [
    {
      slug: 'stage',
      name: 'Stage',
      type: 'status',
      // The one seeded attribute born indexed — see SeedDef.
      filterable: true,
      sortable: true,
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
      options: {
        targetKind: 'company',
        multi: false,
        required: true,
        cardinality: 'N:1',
      },
      // The owner of the pair a company's `associated_deals` reads.
      pair: { kind: 'company', slug: 'associated_deals' },
    },
    {
      slug: 'people',
      name: 'People',
      type: 'record_reference',
      options: { targetKind: 'person', multi: true, cardinality: 'N:N' },
      // The owner of the pair a person's `deals` reads.
      pair: { kind: 'person', slug: 'deals' },
    },
    {
      // New deals arrive owned — the most repetitive click in deal capture.
      // The seed never rewrites rows a user may have edited, so existing
      // installs got this default from a migration.
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
      // Post-mortem memory: Passed and Lost carry distinct
      // lessons — the reason is captured at close time, while it's fresh.
      slug: 'close_reason',
      name: 'Close reason',
      type: 'text',
      options: {},
    },
    {
      // Who sent the deal; `source` says how it arrived. A plain reference:
      // the write path syncs its `references` link in the same transaction,
      // so backlinks, the merge repoint and the context assembler read it.
      // Appended, never slotted next to Source: sortOrder is (i+1)*10 and a
      // mid-array insert would collide with an installed close_reason.
      slug: 'referred_by',
      name: 'Referred by',
      type: 'record_reference',
      options: { targetKind: 'person', multi: false },
    },
  ],
}
