import { describe, expect, it } from 'vitest'
import { matchesCondition, matchesConditions, opsFor, sameJson } from './filter'

describe('view filter (pure)', () => {
  it('offers ops by type', () => {
    expect(opsFor('text')).toContain('contains')
    expect(opsFor('number')).toEqual(['is', 'gt', 'lt', 'empty', 'not_empty'])
    expect(opsFor('checkbox')).toEqual(['is'])
    expect(opsFor('select')).not.toContain('gt')
  })

  it('evaluates each op against typed values', () => {
    const v = {
      stage: 'seed',
      tags: ['a', 'b'],
      score: 4,
      founded: '2021-03-01',
      note: 'Hyperspectral imaging',
      flag: true,
    }
    expect(
      matchesCondition(v, { slug: 'stage', op: 'is', value: 'seed' }, 'select'),
    ).toBe(true)
    expect(
      matchesCondition(
        v,
        { slug: 'stage', op: 'is_not', value: 'seed' },
        'select',
      ),
    ).toBe(false)
    expect(
      matchesCondition(
        v,
        { slug: 'tags', op: 'is', value: 'b' },
        'multi_select',
      ),
    ).toBe(true)
    expect(
      matchesCondition(v, { slug: 'score', op: 'gt', value: 3 }, 'rating'),
    ).toBe(true)
    expect(
      matchesCondition(v, { slug: 'score', op: 'lt', value: '3' }, 'rating'),
    ).toBe(false)
    expect(
      matchesCondition(
        v,
        { slug: 'founded', op: 'gt', value: '2020-12-31' },
        'date',
      ),
    ).toBe(true)
    expect(
      matchesCondition(
        v,
        { slug: 'note', op: 'contains', value: 'IMAGING' },
        'text',
      ),
    ).toBe(true)
    expect(
      matchesCondition(v, { slug: 'flag', op: 'is', value: false }, 'checkbox'),
    ).toBe(false)
    expect(matchesCondition(v, { slug: 'missing', op: 'empty' }, 'text')).toBe(
      true,
    )
    expect(matchesCondition(v, { slug: 'note', op: 'not_empty' }, 'text')).toBe(
      true,
    )
  })

  it('ANDs conditions and ignores unknown attributes', () => {
    const typeOf = (slug: string) =>
      ({ stage: 'select', score: 'rating' })[slug]
    const v = { stage: 'seed', score: 4 }
    expect(
      matchesConditions(
        v,
        [
          { slug: 'stage', op: 'is', value: 'seed' },
          { slug: 'score', op: 'gt', value: 3 },
          { slug: 'ghost', op: 'is', value: 'x' },
        ],
        typeOf,
      ),
    ).toBe(true)
    expect(
      matchesConditions(v, [{ slug: 'score', op: 'lt', value: 3 }], typeOf),
    ).toBe(false)
  })

  it('compares snapshots regardless of key order', () => {
    expect(
      sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
    ).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
  })
})
