import { describe, expect, it } from 'vitest'
import { CORE_IDENTITY_KEYS } from '../attributes/registry'
import {
  NEEDS_NAME,
  alsoCreateWhy,
  applyDecision,
  assignCreates,
  awaitingDecision,
  countPlans,
  creatorFor,
  landingRows,
  planRows,
  readRow,
  referenceLands,
  verdictSentence,
  whyOf,
  withReferences,
} from './plan'
import type { Mapping, MappingAttribute, MappingRegistry } from './mapping'
import type { PlannedRow, Resolved, RowInput } from './plan'
import type { ReferenceColumn, ReferenceOutcome } from './references'

/**
 * SPA-167. The preview's pure half: reading a row under the mapping, the
 * in-file collision rule `resolveEntity` cannot see, decisions, the counts.
 * No database — the identity lookup is handed in as `resolved`.
 */

const attr = (
  id: string,
  slug: string,
  type: MappingAttribute['type'],
  extra: Partial<MappingAttribute> = {},
): MappingAttribute => ({
  id,
  slug,
  name: slug,
  type,
  options: {},
  archived: false,
  ...extra,
})

const companies: MappingRegistry = {
  identityKeys: [...CORE_IDENTITY_KEYS],
  attributes: [
    attr('a-size', 'size', 'number'),
    attr('a-owner', 'owner', 'actor_reference'),
    attr('a-stage', 'stage', 'status', {
      options: { options: [{ id: 'seed', label: 'Seed' }] },
    }),
  ],
}

const mapping: Mapping = [
  { target: 'name' },
  { target: 'identity', key: 'domain' },
  { target: 'attribute', attributeId: 'a-size' },
  { target: 'attribute', attributeId: 'a-owner' },
  { target: 'attribute', attributeId: 'a-stage' },
]

const create: Resolved = { verdict: 'create' }

function input(
  rowNum: number,
  name: string | null,
  domain: string | null,
  resolved: Resolved | null = create,
): RowInput {
  return {
    rowNum,
    read: {
      name,
      keys: {},
      patch: {},
      errors: [],
      skippedCells: [],
      refs: [],
      references: [],
    },
    identity: domain === null ? {} : { domain },
    resolved,
  }
}

const verdicts = (rows: Array<PlannedRow>) => rows.map((r) => r.plan.verdict)

describe('reading a row', () => {
  it('reads name, key and attributes into the write shapes', () => {
    const out = readRow(
      ['  Acme  ', 'https://Acme.com/', '1,200', '', 'seed'],
      mapping,
      companies,
    )
    expect(out.name).toBe('Acme')
    expect(out.keys.domain).toBe('acme.com')
    expect(out.patch).toEqual({ 'a-size': 1200, 'a-stage': 'seed' })
    expect(out.errors).toEqual([])
  })

  it('a cell that does not read is a skipped cell with its reason, never a row error', () => {
    const out = readRow(['Acme', 'acme.com', 'TBD', '', ''], mapping, companies)
    expect(out.errors).toEqual([])
    expect(out.skippedCells).toEqual([
      { column: 2, raw: 'TBD', reason: 'not a number' },
    ])
    expect(out.patch).toEqual({})
  })

  it('an identity cell that does not read is skipped too; the row keeps its other keys', () => {
    const out = readRow(['Acme', 'gmail.com', '', '', ''], mapping, companies)
    expect(out.errors).toEqual([])
    expect(out.keys).toEqual({})
    expect(out.skippedCells).toEqual([
      {
        column: 1,
        raw: 'gmail.com',
        reason: 'free mail and identifies no record',
      },
    ])
  })

  it('a bad currency cell plans as create with one skipped cell, named in the why lane', () => {
    const deals: MappingRegistry = {
      identityKeys: [],
      attributes: [attr('a-value', 'value', 'currency')],
    }
    const read = readRow(
      ['Acme seed', 'TBD'],
      [{ target: 'name' }, { target: 'attribute', attributeId: 'a-value' }],
      deals,
    )
    const [row] = planRows(
      [{ rowNum: 1, read, identity: {}, resolved: create }],
      'resolveEntity',
      0,
    )
    expect(row.plan.verdict).toBe('create')
    expect(row.plan.skippedCells).toEqual([
      { column: 1, raw: 'TBD', reason: 'not money' },
    ])
    expect(whyOf(row.plan, ['Name', 'Raise'])).toBe(
      'Raise "TBD" skipped · not money',
    )
    const counts = countPlans([row.plan])
    expect(counts).toMatchObject({ create: 1, noLand: 0, cellsSkipped: 1 })
  })

  it('a name cell that does not read is the one row error', () => {
    const out = readRow(
      ['x'.repeat(5000), 'acme.com', '', '', ''],
      mapping,
      companies,
    )
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].column).toBe(0)
  })

  it('a reference cell is set aside for its lookup, neither read nor skipped', () => {
    const out = readRow(
      ['Acme', 'acme.com', '', 'anish@fund.example', ''],
      mapping,
      companies,
    )
    expect(out.errors).toEqual([])
    expect(out.skippedCells).toEqual([])
    expect(out.refs).toEqual([
      { column: 3, attributeId: 'a-owner', raw: 'anish@fund.example' },
    ])
  })
})

describe('three creators', () => {
  it('names the door by target object kind', () => {
    expect(creatorFor('company')).toBe('resolveEntity')
    expect(creatorFor('person')).toBe('resolveEntity')
    expect(creatorFor('deal')).toBe('dealBirth')
    expect(creatorFor(null)).toBe('createRecordProgram')
  })

  it('the why lane says which when it is not the resolver', () => {
    const [deal] = planRows([input(1, 'Seed round', null)], 'dealBirth', 0)
    expect(deal.plan.creator).toBe('dealBirth')
    expect(whyOf(deal.plan, null)).toContain('deal birth')
    const [co] = planRows([input(1, 'Acme', 'acme.com')], 'resolveEntity', 0)
    expect(whyOf(co.plan, null)).not.toContain('resolveEntity')
  })
})

describe('in-file collisions', () => {
  it('same key, different names: both collide and neither is a create', () => {
    const rows = planRows(
      [
        input(1, 'Acme', 'acme.com'),
        input(2, 'Beta', 'beta.com'),
        input(3, 'Acme Robotics', 'acme.com'),
      ],
      'resolveEntity',
      0,
    )
    expect(verdicts(rows)).toEqual(['collide', 'create', 'collide'])
    expect(rows[0].plan.collidesWith).toEqual([3])
    expect(rows[2].plan.collidesWith).toEqual([1])
    const counts = countPlans(rows.map((r) => r.plan))
    expect(counts.create).toBe(1)
    expect(counts.collide).toBe(2)
    expect(awaitingDecision(counts)).toBe(true)
  })

  it('same key, same name: merges silently into the first and counts once', () => {
    const rows = planRows(
      [input(1, 'Acme Inc.', 'acme.com'), input(2, 'acme', 'acme.com')],
      'resolveEntity',
      0,
    )
    expect(verdicts(rows)).toEqual(['create', 'merged'])
    expect(rows[1].plan.mergedInto).toBe(1)
    const counts = countPlans(rows.map((r) => r.plan))
    expect(landingRows(counts)).toBe(1)
    expect(awaitingDecision(counts)).toBe(false)
  })

  it('a no-land row never takes part in a collision', () => {
    const rows = planRows(
      [
        input(1, 'Acme', 'acme.com'),
        { ...input(2, 'Other', 'acme.com'), resolved: null },
      ],
      'resolveEntity',
      0,
    )
    expect(verdicts(rows)).toEqual(['create', 'no-land'])
  })
})

describe('decisions', () => {
  const attachFirst: Resolved = {
    verdict: 'attach',
    entityId: 'e-1',
    matchedOn: { kind: 'domain', value: 'acme.com' },
  }
  const planned = () =>
    planRows(
      [
        input(1, 'Acme', 'acme.com', attachFirst),
        input(2, 'Acme Robotics', 'acme.com', attachFirst),
        input(3, 'ACME', 'acme.com', attachFirst),
      ],
      'resolveEntity',
      0,
    )

  it('keep-first lands row 1 as the lookup said and folds the other', () => {
    const rows = planned()
    expect(verdicts(rows)).toEqual(['collide', 'collide', 'merged'])
    const changed = applyDecision(rows, 2, 'keep-first')
    const by = new Map(changed.map((r) => [r.rowNum, r.plan]))
    expect(by.get(1)?.verdict).toBe('attach')
    expect(by.get(1)?.decision).toBe('keep-first')
    expect(by.get(2)?.verdict).toBe('merged')
    expect(by.get(2)?.mergedInto).toBe(1)
    expect(by.get(2)?.decision).toBe('keep-first')
  })

  it('keep-second lands row 2; skip-both lands neither, nor what merged into them', () => {
    const rows = planned()
    const second = new Map(
      applyDecision(rows, 1, 'keep-second').map((r) => [r.rowNum, r.plan]),
    )
    expect(second.get(2)?.verdict).toBe('attach')
    expect(second.get(1)?.mergedInto).toBe(2)
    const skipped = applyDecision(rows, 1, 'skip-both')
    expect(skipped.map((r) => r.plan.verdict)).toEqual(['skip', 'skip', 'skip'])
  })

  it('a row outside any collision changes nothing', () => {
    const rows = planRows([input(1, 'Acme', 'acme.com')], 'resolveEntity', 0)
    expect(applyDecision(rows, 1, 'keep-first')).toEqual([])
  })
})

describe('refusals and the report', () => {
  it('a creator refusal is a no-land row carrying its reason', () => {
    const [row] = planRows(
      [input(1, null, null, { verdict: 'refused', reason: NEEDS_NAME })],
      'createRecordProgram',
      0,
    )
    expect(row.plan.verdict).toBe('no-land')
    expect(row.plan.errors[0].reason).toBe(NEEDS_NAME)
  })

  it('the title leaves out the zero terms after create and attach', () => {
    const counts = {
      create: 31,
      referenceCreates: 0,
      attach: 12,
      noLand: 3,
      collide: 0,
      merged: 0,
      skip: 0,
      cellsSkipped: 0,
      total: 46,
    }
    expect(verdictSentence(counts)).toBe(
      '31 create · 12 attach · 3 will not land.',
    )
    expect(verdictSentence({ ...counts, collide: 2 })).toBe(
      '31 create · 12 attach · 3 will not land · 2 collide.',
    )
  })
})

describe('reference cells (SPA-168)', () => {
  const deals: MappingRegistry = {
    identityKeys: [],
    attributes: [
      attr('a-company', 'company', 'record_reference', {
        options: { targetKind: 'company', required: true },
      }),
      attr('a-lead', 'lead', 'record_reference', {
        options: { targetKind: 'company' },
      }),
      attr('a-owner', 'owner', 'actor_reference'),
    ],
  }
  const target = {
    objectId: 'o-companies',
    kind: 'company' as const,
    singular: 'Company',
    plural: 'Companies',
    identityKeys: [...CORE_IDENTITY_KEYS],
    creator: 'resolveEntity' as const,
  }
  const columns = (createMissing: boolean) =>
    new Map<number, ReferenceColumn>([
      [
        1,
        {
          type: 'record',
          column: 1,
          attributeId: 'a-company',
          multi: false,
          required: true,
          createMissing,
          target,
        },
      ],
      [
        2,
        {
          type: 'record',
          column: 2,
          attributeId: 'a-lead',
          multi: false,
          required: false,
          createMissing,
          target,
        },
      ],
      [
        3,
        { type: 'member', column: 3, attributeId: 'a-owner', required: false },
      ],
    ])
  const dealMapping: Mapping = [
    { target: 'name' },
    { target: 'attribute', attributeId: 'a-company' },
    { target: 'attribute', attributeId: 'a-lead' },
    { target: 'attribute', attributeId: 'a-owner' },
  ]
  const lookup = new Map<number, Map<string, ReferenceOutcome>>([
    [
      1,
      new Map<string, ReferenceOutcome>([
        ['ohmium', { status: 'found', entityId: 'e-ohm', name: 'Ohmium' }],
        ['acme', { status: 'ambiguous', names: ['Acme Inc', 'Acme Labs'] }],
        ['newco', { status: 'missing', identity: null }],
      ]),
    ],
    [
      2,
      new Map<string, ReferenceOutcome>([
        ['acme', { status: 'ambiguous', names: ['Acme Inc', 'Acme Labs'] }],
        ['ohmium ltd', { status: 'missing', identity: null }],
        [
          'newco.io',
          {
            status: 'missing',
            identity: { kind: 'domain', value: 'newco.io' },
          },
        ],
      ]),
    ],
    [
      3,
      new Map<string, ReferenceOutcome>([
        [
          'anish@fund.example',
          { status: 'member', userId: 'u-1', name: 'Anish' },
        ],
        ['anish', { status: 'not-email' }],
        ['ghost@fund.example', { status: 'missing', identity: null }],
      ]),
    ],
  ])
  const read = (cells: Array<string>, createMissing = false) =>
    withReferences(
      readRow(cells, dealMapping, deals),
      columns(createMissing),
      lookup,
    )
  const one = (rowNum: number, r: ReturnType<typeof read>): RowInput => ({
    rowNum,
    read: r,
    identity: {},
    resolved: r.errors.length > 0 ? null : create,
  })

  it('a hit lands the record id and names it in what lands', () => {
    const out = read(['Seed', '  Ohmium ', '', 'Anish@Fund.example'])
    expect(out.patch).toEqual({ 'a-company': 'e-ohm', 'a-owner': 'u-1' })
    expect(out.errors).toEqual([])
    const [row] = planRows([one(1, out)], 'dealBirth', 0)
    expect(referenceLands(row.plan)).toBe('→ Ohmium +1')
  })

  it('an ambiguous or missing name on an optional reference is a skipped cell naming why', () => {
    const out = read(['Seed', '', 'Acme', ''])
    expect(out.errors).toEqual([])
    expect(out.skippedCells).toEqual([
      { column: 2, raw: 'Acme', reason: '2 matches: Acme Inc, Acme Labs' },
    ])
    const [row] = planRows(
      [one(1, read(['Seed', '', 'Ohmium Ltd', '']))],
      'dealBirth',
      0,
    )
    expect(row.plan.verdict).toBe('create')
    expect(whyOf(row.plan, ['Deal', 'Company', 'Lead', 'Owner'])).toBe(
      'Lead "Ohmium Ltd" skipped · no such company · deal birth',
    )
  })

  it('a required reference that finds nothing stops the row, naming the cell', () => {
    const out = read(['Seed', 'Acme', '', ''])
    expect(out.errors).toEqual([
      {
        column: 1,
        raw: 'Acme',
        reason: '"Acme" · 2 matches: Acme Inc, Acme Labs',
      },
    ])
    const [row] = planRows([one(1, out)], 'dealBirth', 0)
    expect(row.plan.verdict).toBe('no-land')
    expect(whyOf(row.plan, ['Deal', 'Company'])).toBe(
      'B · Company: "Acme" · 2 matches: Acme Inc, Acme Labs',
    )
  })

  it('a member is an email: a bare name and an unknown address are skipped', () => {
    expect(read(['Seed', '', '', 'Anish']).skippedCells).toEqual([
      { column: 3, raw: 'Anish', reason: "use the member's email" },
    ])
    const ghost = read(['Seed', '', '', 'ghost@fund.example'])
    expect(ghost.patch).toEqual({})
    expect(ghost.skippedCells[0].reason).toBe('no such member')
  })

  it('create missing plans one create per missing name, carried by the first landing row', () => {
    const planned = planRows(
      [
        one(1, read(['A', 'NewCo', '', ''], true)),
        one(2, read(['B', 'newco ', '', ''], true)),
        one(3, read(['C', 'Ohmium', 'newco.io', ''], true)),
      ],
      'dealBirth',
      0,
    )
    expect(planned.map((r) => r.plan.errors)).toEqual([[], [], []])
    expect(planned[0].plan.alsoCreates).toEqual([
      {
        key: 'o-companies|name:newco',
        column: 1,
        attributeId: 'a-company',
        objectId: 'o-companies',
        plan: {
          verdict: 'create',
          creator: 'resolveEntity',
          name: 'NewCo',
          patch: {},
          identity: {},
          errors: [],
          skippedCells: [],
        },
      },
    ])
    expect(planned[1].plan.alsoCreates).toBeUndefined()
    // A domain-shaped miss is born on its key, with no name.
    expect(planned[2].plan.alsoCreates?.[0].plan).toMatchObject({
      name: null,
      identity: { domain: 'newco.io' },
    })
    const byKey = planned[2].plan.alsoCreates?.at(0)
    if (!byKey) throw new Error('row 3 carries no create')
    expect(alsoCreateWhy(3, byKey, null)).toBe(
      "new domain newco.io · from row 3's C column",
    )
    const counts = countPlans(planned.map((r) => r.plan))
    expect(counts).toMatchObject({ create: 5, referenceCreates: 2 })
    expect(verdictSentence(counts)).toBe('5 create · 0 attach.')
  })

  it('a skipped carrier hands its create to the next row that names it', () => {
    const planned = planRows(
      [
        one(1, read(['A', 'NewCo', '', ''], true)),
        one(2, read(['B', 'NewCo', '', ''], true)),
      ],
      'dealBirth',
      0,
    )
    expect(planned[0].plan.alsoCreates).toHaveLength(1)
    const skipped = assignCreates([
      { rowNum: 1, plan: { ...planned[0].plan, verdict: 'skip' } },
      planned[1],
    ])
    expect(skipped[0].plan.alsoCreates).toBeUndefined()
    expect(skipped[1].plan.alsoCreates?.[0].key).toBe('o-companies|name:newco')
  })
})
