import { describe, expect, it } from 'vitest'
import {
  CORE_IDENTITY_KEYS,
  CORE_ONLY_IDENTITY_KEYS,
  identityKeysOf,
} from '../attributes/registry'
import {
  assignColumn,
  autoMap,
  columnName,
  columnStatus,
  fitMapping,
  mappableAttributes,
  optionLabelsFrom,
  readCell,
  specFor,
  summarizeSpec,
  unparsedColumns,
  validateMapping,
} from './mapping'
import type {
  ColumnTarget,
  Mapping,
  MappingAttribute,
  MappingRegistry,
} from './mapping'

/**
 * SPA-165. The mapping's rules, with no database: @spaces/core's vitest
 * config loads no env, so this file runs with Postgres stopped.
 */

const attr = (
  id: string,
  slug: string,
  name: string,
  type: MappingAttribute['type'],
  extra: Partial<MappingAttribute> = {},
): MappingAttribute => ({
  id,
  slug,
  name,
  type,
  options: {},
  archived: false,
  ...extra,
})

const stage = attr('a-stage', 'stage', 'Stage', 'status', {
  options: {
    options: [
      { id: 'seed', label: 'Seed' },
      { id: 'series_a', label: 'Series A' },
    ],
  },
})

const deals: MappingRegistry = {
  identityKeys: identityKeysOf({
    slug: 'deals',
    isSystem: true,
    identityKeys: [],
  }),
  attributes: [
    stage,
    attr('a-value', 'value', 'Value', 'currency', {
      options: { code: 'USD' },
    }),
    attr('a-company', 'company', 'Company', 'record_reference', {
      options: { targetKind: 'company' },
    }),
    attr('a-owner', 'owner', 'Owner', 'actor_reference'),
    attr('a-close', 'close_date', 'Close date', 'date'),
    attr('a-old', 'old_notes', 'Old notes', 'text', { archived: true }),
  ],
}

/** A custom object built in settings: three attributes and a declared domain. */
const funds: MappingRegistry = {
  identityKeys: identityKeysOf({
    slug: 'funds',
    isSystem: false,
    identityKeys: ['domain'],
  }),
  attributes: [
    attr('f-domain', 'domain', 'Domain', 'domain', {
      options: { identityKey: 'domain' },
    }),
    attr('f-vintage', 'vintage', 'Vintage', 'number'),
    attr('f-strategy', 'strategy', 'Strategy', 'select', {
      options: { options: [{ id: 'venture', label: 'Venture' }] },
    }),
    attr('f-size', 'fund_size', 'Fund size', 'currency'),
  ],
}

describe('identity keys come from one helper', () => {
  it('gives company and person the core four, a deal none, a custom object its declaration', () => {
    const core = { isSystem: true, identityKeys: [] }
    expect(identityKeysOf({ ...core, slug: 'companies' })).toEqual([
      'domain',
      'email',
      'linkedin',
      'cin',
    ])
    expect(identityKeysOf({ ...core, slug: 'people' })).toEqual(
      CORE_IDENTITY_KEYS,
    )
    expect(identityKeysOf({ ...core, slug: 'deals' })).toEqual([])
    expect(
      identityKeysOf({
        slug: 'funds',
        isSystem: false,
        identityKeys: ['linkedin'],
      }),
    ).toEqual(['linkedin'])
    // A custom object that happens to take a core slug is still custom.
    expect(
      identityKeysOf({ slug: 'companies', isSystem: false, identityKeys: [] }),
    ).toEqual([])
  })

  it('derives the core-only keys from the core four', () => {
    expect(CORE_ONLY_IDENTITY_KEYS).toEqual(['email', 'cin'])
  })
})

describe('what a column may map onto', () => {
  it('offers live attributes, references included since SPA-168, never an archived one', () => {
    expect(mappableAttributes(deals).map((a) => a.slug)).toEqual([
      'stage',
      'value',
      'company',
      'owner',
      'close_date',
    ])
  })

  it("offers a custom object's declared key as identity, not as its backing attribute", () => {
    expect(mappableAttributes(funds).map((a) => a.slug)).toEqual([
      'vintage',
      'strategy',
      'fund_size',
    ])
    expect(funds.identityKeys).toEqual(['domain'])
  })
})

describe('autoMap', () => {
  it('maps a custom object from its registry alone', () => {
    expect(
      autoMap(['Name', 'Website', 'Vintage', 'Fund size', 'Strategy'], funds),
    ).toEqual([
      { target: 'name' },
      { target: 'identity', key: 'domain' },
      { target: 'attribute', attributeId: 'f-vintage' },
      { target: 'attribute', attributeId: 'f-size' },
      { target: 'attribute', attributeId: 'f-strategy' },
    ])
  })

  it('matches a slug, then a name, then an alias, and ignores the rest', () => {
    expect(
      autoMap(['Deal', 'Round', 'close_date', 'Value', 'Notes', ''], deals),
    ).toEqual([
      { target: 'ignore' },
      { target: 'attribute', attributeId: 'a-stage' },
      { target: 'attribute', attributeId: 'a-close' },
      { target: 'attribute', attributeId: 'a-value' },
      { target: 'ignore' },
      { target: 'ignore' },
    ])
  })

  it("on a deal, Company and Owner find the references before Company's name alias", () => {
    expect(autoMap(['Company', 'Owner', 'Deal name'], deals)).toEqual([
      { target: 'attribute', attributeId: 'a-company' },
      { target: 'attribute', attributeId: 'a-owner' },
      { target: 'ignore' },
    ])
  })

  it('lets an exact Name column win over the Company alias', () => {
    const people: MappingRegistry = {
      identityKeys: CORE_IDENTITY_KEYS,
      attributes: [],
    }
    expect(autoMap(['Company', 'Name', 'Email'], people)).toEqual([
      { target: 'ignore' },
      { target: 'name' },
      { target: 'identity', key: 'email' },
    ])
  })

  it('never maps two headers onto one target — the second is ignored', () => {
    expect(autoMap(['Stage', 'stage', 'Round'], deals)).toEqual([
      { target: 'attribute', attributeId: 'a-stage' },
      { target: 'ignore' },
      { target: 'ignore' },
    ])
  })

  it('does not offer a key the object lacks: Website on a deal is ignored', () => {
    expect(autoMap(['Website'], deals)).toEqual([{ target: 'ignore' }])
  })

  it('does not map a header onto an archived attribute', () => {
    expect(autoMap(['Old notes'], deals)).toEqual([{ target: 'ignore' }])
  })
})

describe('assignColumn', () => {
  it('takes a target from the column that held it and names that column', () => {
    const mapping: Mapping = [
      { target: 'attribute', attributeId: 'a-stage' },
      { target: 'ignore' },
    ]
    const out = assignColumn(mapping, 1, {
      target: 'attribute',
      attributeId: 'a-stage',
    })
    expect(out.mapping).toEqual([
      { target: 'ignore' },
      { target: 'attribute', attributeId: 'a-stage' },
    ])
    expect(out.replaced).toEqual([
      { column: 0, previous: { target: 'attribute', attributeId: 'a-stage' } },
    ])
  })

  it('moves the name the same way, and leaves unrelated columns alone', () => {
    const out = assignColumn(
      [{ target: 'name' }, { target: 'ignore' }, { target: 'ignore' }],
      2,
      { target: 'name' },
    )
    expect(out.mapping.map((t) => t.target)).toEqual([
      'ignore',
      'ignore',
      'name',
    ])
    expect(out.replaced.map((r) => r.column)).toEqual([0])
  })

  it('replaces nothing when the target is ignore', () => {
    const out = assignColumn([{ target: 'ignore' }, { target: 'ignore' }], 0, {
      target: 'ignore',
    })
    expect(out.replaced).toEqual([])
  })
})

describe('validateMapping', () => {
  const headers = ['Company', 'Stage', 'Round']

  it('refuses a mapping with no name, with a reason', () => {
    const problems = validateMapping(
      [{ target: 'ignore' }, { target: 'ignore' }, { target: 'ignore' }],
      deals,
      headers,
    )
    expect(problems).toEqual([
      { column: null, reason: 'Map one column to the name' },
    ])
  })

  it('refuses two names and two columns on one attribute', () => {
    const problems = validateMapping(
      [
        { target: 'name' },
        { target: 'attribute', attributeId: 'a-stage' },
        { target: 'attribute', attributeId: 'a-stage' },
        { target: 'name' },
      ],
      deals,
      [...headers, 'Deal'],
    )
    expect(problems.map((p) => p.reason)).toEqual([
      'Only one column can be the name — A · Company and D · Deal both are',
      'B · Stage and C · Round map to the same field',
    ])
  })

  it('refuses an archived attribute, a key the object lacks and an unconfirmed new attribute — a reference passes', () => {
    const problems = validateMapping(
      [
        { target: 'name' },
        { target: 'attribute', attributeId: 'a-old' },
        { target: 'attribute', attributeId: 'a-company' },
        { target: 'identity', key: 'domain' },
        { target: 'new', name: 'Sector', type: 'text' },
      ],
      deals,
      null,
    )
    expect(problems.map((p) => p.column)).toEqual([1, 3, 4])
    expect(problems[2].reason).toBe(
      'E: create the new attribute or skip the column',
    )
  })

  it('accepts one name and distinct targets', () => {
    expect(
      validateMapping(
        [
          { target: 'name' },
          { target: 'attribute', attributeId: 'a-stage' },
          { target: 'ignore' },
        ],
        deals,
        headers,
      ),
    ).toEqual([])
  })
})

describe('reading a mapped column', () => {
  it('counts what parses and names what does not', () => {
    const spec = specFor({ target: 'attribute', attributeId: 'a-value' }, deals)
    if (!spec) throw new Error('value is mapped')
    const summary = summarizeSpec(spec, ['$1,250', '(400)', 'TBD', ''])
    expect(summary.parsed).toBe(2)
    expect(summary.total).toBe(3)
    expect(summary.failures).toEqual([
      { row: 2, raw: 'TBD', reason: '"TBD" is not a number' },
    ])
    expect(
      columnStatus(
        { target: 'attribute', attributeId: 'a-value' },
        spec,
        summary,
        1,
      ),
    ).toBe('fail')
  })

  it('reads an unknown option as a choice to make, not a broken cell', () => {
    const target: ColumnTarget = { target: 'attribute', attributeId: 'a-stage' }
    const spec = specFor(target, deals)
    if (!spec) throw new Error('stage is mapped')
    const summary = summarizeSpec(spec, ['seed', 'Pre-seed'])
    expect(readCell(spec, 'seed')).toEqual({ ok: true, value: 'seed' })
    expect(summary.parsed).toBe(1)
    expect(columnStatus(target, spec, summary, 0)).toBe('warn')
  })

  it('passes the declared date order through, never sniffing one', () => {
    const undeclared = specFor(
      { target: 'attribute', attributeId: 'a-close' },
      deals,
    )
    const dayFirst = specFor(
      { target: 'attribute', attributeId: 'a-close', dateOrder: 'dmy' },
      deals,
    )
    if (!undeclared || !dayFirst) throw new Error('close date is mapped')
    expect(readCell(undeclared, '03/04/2026').ok).toBe(false)
    expect(readCell(dayFirst, '03/04/2026')).toEqual({
      ok: true,
      value: '2026-04-03',
    })
  })

  it('warns on an identity key with blanks and reads a CIN through its normalizer', () => {
    const target: ColumnTarget = { target: 'identity', key: 'cin' }
    const spec = specFor(target, {
      identityKeys: CORE_IDENTITY_KEYS,
      attributes: [],
    })
    if (!spec) throw new Error('cin is mapped')
    const summary = summarizeSpec(spec, ['U72900KA2015PTC082123', '', 'nope'])
    expect(summary.parsed).toBe(1)
    expect(summary.failures.map((f) => f.raw)).toEqual(['nope'])
    const clean = summarizeSpec(spec, ['U72900KA2015PTC082123', ''])
    expect(columnStatus(target, spec, clean, 1)).toBe('warn')
    expect(columnStatus(target, spec, clean, 0)).toBe('ok')
  })

  it('reads a draft select against the labels it will be born with', () => {
    const spec = specFor(
      { target: 'new', name: 'Sector', type: 'select', options: ['Fintech'] },
      deals,
    )
    if (!spec) throw new Error('draft is mapped')
    expect(readCell(spec, 'fintech').ok).toBe(true)
    expect(readCell(spec, 'Health').ok).toBe(false)
  })

  it('calls out a mapped column where nothing parses', () => {
    const mapping: Mapping = [
      { target: 'name' },
      { target: 'attribute', attributeId: 'a-value' },
      { target: 'ignore' },
    ]
    const problems = unparsedColumns(
      mapping,
      [
        { parsed: 3, total: 3, failures: [] },
        { parsed: 0, total: 2, failures: [] },
        null,
      ],
      ['Name', 'Amount', 'Notes'],
    )
    expect(problems.map((p) => p.column)).toEqual([1])
    expect(problems[0].reason).toContain('B · Amount')
  })
})

describe('helpers', () => {
  it('offers the distinct column values as new options, first spelling kept', () => {
    expect(
      optionLabelsFrom('select', ['Fintech', 'fintech', '', null, 'Health']),
    ).toEqual(['Fintech', 'Health'])
    expect(
      optionLabelsFrom('multi_select', ['AI, SaaS', 'saas; Infra']),
    ).toEqual(['AI', 'SaaS', 'Infra'])
  })

  it('fits a stored mapping to the sheet width', () => {
    expect(fitMapping([{ target: 'name' }], 2)).toEqual([
      { target: 'name' },
      { target: 'ignore' },
    ])
  })

  it('names a column by letter and header', () => {
    expect(columnName(0, ['Company'])).toBe('A · Company')
    expect(columnName(27, null)).toBe('AB')
  })
})
