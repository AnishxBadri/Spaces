import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SYSTEM_ATTRIBUTES, valueValidator } from '../attributes/registry'
import type { AttributeDef, AttributeType } from '../attributes/registry'
import { schemaFor, toPatch, validateProposal, proposalRefs } from './schema'
import type { JsonSchema, SchemaAttribute } from './schema'

/**
 * The registry → JSON-schema compiler (spec-ai-substrate §2, §14 step 1).
 * This file runs in @spaces/core's suite, which loads no env file and has no
 * connection string by construction: the compiled company schema — the deck
 * reader's output type — is legible with no model and no database.
 */

const def = (
  slug: string,
  type: AttributeType,
  options: AttributeDef['options'] = {},
  extra: Partial<SchemaAttribute> = {},
): SchemaAttribute => ({
  slug,
  name: slug.replace(/_/g, ' '),
  type,
  options,
  archived: false,
  ...extra,
})

/** The seeded company registry, as the attribute table holds it. */
const company: Array<SchemaAttribute> = SYSTEM_ATTRIBUTES.company.map((a) =>
  def(a.slug, a.type, a.options ?? {}, { name: a.name }),
)

/** One attribute per type — all fifteen. */
const everyType: Array<SchemaAttribute> = [
  def('summary', 'text', {}, { description: 'One line on what they do' }),
  def('headcount', 'number'),
  def('raise', 'currency', { code: 'USD' }),
  def('founded', 'date'),
  def('profitable', 'checkbox'),
  def('sector', 'select', {
    options: [
      { id: 'fintech', label: 'Fintech' },
      { id: 'crypto', label: 'Crypto', archived: true },
    ],
  }),
  def('tags', 'multi_select', {
    options: [
      { id: 'ai', label: 'AI' },
      { id: 'web3', label: 'Web3', archived: true },
      { id: 'climate', label: 'Climate' },
    ],
  }),
  def('stage', 'status', {
    options: [
      { id: 'screening', label: 'Screening', group: 'active' },
      { id: 'passed', label: 'Passed', group: 'closed' },
    ],
  }),
  def('website', 'domain'),
  def('contact', 'email'),
  def('deck_url', 'url'),
  def('phone', 'phone'),
  def('conviction', 'rating', { max: 3 }),
  def('lead', 'record_reference', { targetKind: 'company', required: true }),
  def('owner', 'actor_reference'),
]

const TYPES: Array<AttributeType> = [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'domain',
  'email',
  'url',
  'phone',
  'rating',
  'record_reference',
  'actor_reference',
]

const valueOf = (s: JsonSchema, slug: string) =>
  s.properties?.[slug]?.properties?.value

const field = (value: unknown, refs: Array<string> = ['doc:1#p4']) => ({
  value,
  refs,
  confidence: 0.8,
})

describe('schemaFor', () => {
  it('covers all fifteen types, each with a write shape but actor_reference', () => {
    expect(new Set(everyType.map((d) => d.type))).toEqual(new Set(TYPES))
    const s = schemaFor(everyType)
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(s.type).toBe('object')
    expect(s.additionalProperties).toBe(false)
    expect(Object.keys(s.properties ?? {})).toEqual(
      everyType.filter((d) => d.type !== 'actor_reference').map((d) => d.slug),
    )
    expect(s).toMatchSnapshot()
  })

  it("compiles the company registry — the deck reader's output type", () => {
    expect(schemaFor(company, 'Company')).toMatchSnapshot()
  })

  it('wraps every property in {value, refs, confidence}', () => {
    const s = schemaFor(everyType)
    for (const prop of Object.values(s.properties ?? {})) {
      expect(prop.required).toEqual(['value', 'refs', 'confidence'])
      expect(prop.additionalProperties).toBe(false)
    }
  })

  it("carries attribute.description as the property's description", () => {
    expect(schemaFor(everyType).properties?.summary.description).toBe(
      'One line on what they do',
    )
  })

  it('requires no property, not even a required attribute', () => {
    // A model that cannot find a value must be free to omit it; a schema
    // that requires the field forces it to invent one. `required` on an
    // attribute means a person cannot clear it — the write path's rule, not
    // the extractor's.
    const s = schemaFor(everyType)
    expect(everyType.find((d) => d.slug === 'lead')?.options.required).toBe(
      true,
    )
    expect(s.required).toBeUndefined()
  })

  it('emits only live option ids for select, status and multi_select', () => {
    const s = schemaFor(everyType)
    expect(valueOf(s, 'sector')?.enum).toEqual(['fintech'])
    expect(valueOf(s, 'tags')?.items?.enum).toEqual(['ai', 'climate'])
    expect(valueOf(s, 'stage')?.enum).toEqual(['screening', 'passed'])
  })

  it('compiles record_reference to an identity claim with name required, never a uuid', () => {
    const lead = valueOf(schemaFor(everyType), 'lead')
    expect(lead?.type).toBe('object')
    expect(lead?.required).toEqual(['name'])
    expect(Object.keys(lead?.properties ?? {})).toEqual([
      'name',
      'domain',
      'email',
    ])
    expect(JSON.stringify(lead)).not.toContain('uuid')

    const people = valueOf(
      schemaFor([def('people', 'record_reference', { multi: true })]),
      'people',
    )
    expect(people?.type).toBe('array')
    expect(people?.items?.required).toEqual(['name'])
  })

  it('claims a person by name, role, email and LinkedIn — never a domain (SPA-105)', () => {
    const founders = valueOf(
      schemaFor([
        def('founders', 'record_reference', {
          targetKind: 'person',
          multi: true,
        }),
      ]),
      'founders',
    )
    expect(founders?.type).toBe('array')
    expect(founders?.items?.required).toEqual(['name'])
    expect(Object.keys(founders?.items?.properties ?? {})).toEqual([
      'name',
      'role',
      'email',
      'linkedin',
    ])
  })

  it('leaves out archived attributes', () => {
    const s = schemaFor([def('gone', 'text', {}, { archived: true })])
    expect(s.properties).toEqual({})
  })

  it('is a function of the registry alone — a custom object needs no AI code', () => {
    // The same `AttributeDef` shape `createObjectProgram` + the attribute
    // dialog produce for a user's "Fund" object; the DB-backed twin of this
    // lives in apps/web/src/lib/ai/schema.test.ts.
    const fund = [
      def('strategy', 'select', {
        options: [
          { id: 'venture', label: 'Venture' },
          { id: 'growth', label: 'Growth' },
        ],
      }),
      def('fund_size', 'currency', { code: 'USD' }),
      def('gp', 'record_reference', { targetKind: 'person' }),
    ]
    expect(Object.keys(schemaFor(fund, 'Fund').properties ?? {})).toEqual([
      'strategy',
      'fund_size',
      'gp',
    ])
  })
})

describe('validateProposal', () => {
  it('rejects an archived option, naming it — as valueValidator does for a fresh write', () => {
    const r = validateProposal(everyType, { sector: field('crypto') })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.message).toContain('"Crypto" is archived')

    // The write path's rule, unchanged: a *held* archived option passes,
    // a fresh assertion of one never does.
    const sector = everyType.find((d) => d.slug === 'sector')
    if (!sector) throw new Error('fixture')
    expect(valueValidator(sector, 'crypto').safeParse('crypto').success).toBe(
      true,
    )
    expect(valueValidator(sector).safeParse('crypto').success).toBe(false)
  })

  it('validates as a fresh write, even for a value the record already holds', () => {
    // A proposal is always a fresh assertion: the model is claiming the
    // value anew from its context, not keeping one a person chose. So there
    // is no `held` to pass, and an archived option the record happens to
    // hold is refused exactly as if it had never been held.
    const r = validateProposal(everyType, {
      tags: field(['ai', 'web3']),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.message).toContain('"Web3" is archived')
  })

  it('rejects a proposal containing an actor_reference', () => {
    const r = validateProposal(everyType, { owner: field('user_123') })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.slug).toBe('owner')
  })

  it('rejects an unknown slug, a bare value, and a uuid where a claim belongs', () => {
    const r = validateProposal(everyType, {
      invented: field('x'),
      headcount: 12,
      lead: field('0b6f8f7e-8d59-4f0e-9e0e-6a4f0d8c1a11'),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.map((i) => i.slug)).toEqual([
      'invented',
      'headcount',
      'lead',
    ])
  })

  it('accepts a claim with only a name', () => {
    const r = validateProposal(everyType, { lead: field({ name: 'Acme' }) })
    expect(r.ok).toBe(true)
  })
})

describe('toPatch', () => {
  it('keeps a person claim’s role and LinkedIn for the identity row', () => {
    const reg = [
      def('people', 'record_reference', { targetKind: 'person', multi: true }),
    ]
    const r = validateProposal(reg, {
      people: field([
        { name: 'Ada', role: 'CEO', linkedin: 'linkedin.com/in/ada' },
      ]),
    })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    expect(toPatch(reg, r.proposal).claims).toEqual({
      people: [{ name: 'Ada', role: 'CEO', linkedin: 'linkedin.com/in/ada' }],
    })
  })

  it('splits values from identity claims, and unions refs for the suggestion row', () => {
    const r = validateProposal(everyType, {
      headcount: field(40, ['doc:1#p2']),
      sector: field('fintech', ['doc:1#p4', 'doc:1#p2']),
      lead: field({ name: 'Acme', domain: 'acme.com' }, ['doc:1#p9']),
    })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    expect(toPatch(everyType, r.proposal)).toEqual({
      patch: { headcount: 40, sector: 'fintech' },
      claims: { lead: [{ name: 'Acme', domain: 'acme.com' }] },
    })
    expect(proposalRefs(r.proposal)).toEqual([
      'doc:1#p2',
      'doc:1#p4',
      'doc:1#p9',
    ])
  })
})

describe('purity', () => {
  it('imports neither drizzle nor the app database', () => {
    const text = readFileSync(
      fileURLToPath(new URL('./schema.ts', import.meta.url)),
      'utf8',
    )
    const specs = [...text.matchAll(/^import .*from '([^']+)'$/gm)].map(
      (m) => m[1],
    )
    expect(specs).toEqual([
      'zod',
      '../attributes/options',
      '../attributes/registry',
      '../attributes/registry',
    ])
  })
})
