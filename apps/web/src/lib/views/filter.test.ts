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

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('view store', () => {
  it('lists shared + own, guards edits to author or admin', async () => {
    const { Effect } = await import('effect')
    const {
      listViewsProgram,
      saveViewProgram,
      deleteViewProgram,
      ViewForbidden,
    } = await import('./store')
    const { objectIdForKindAsync } = await import('../attributes/objects')
    const { db } = await import('#/db')
    const { user } = await import('#/db/schema/auth')
    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const objectId = await objectIdForKindAsync('company')
    const stranger = {
      id: '00000000-0000-4000-8000-000000000000',
      isAdmin: false,
    }
    const base = {
      objectId,
      filter: [{ slug: 'funding_stage', op: 'is' as const, value: 'seed' }],
      sort: { id: 'name', desc: false },
      columns: { spaces: false },
      extra: {},
    }
    const mine = { id: me.id, isAdmin: false }
    const priv = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Seed watch (private)', visibility: 'private' },
        mine,
      ),
    )
    const shared = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Seed watch (shared)', visibility: 'shared' },
        mine,
      ),
    )
    try {
      const forMe = await Effect.runPromise(listViewsProgram(objectId, me.id))
      expect(forMe.map((v) => v.id)).toEqual(
        expect.arrayContaining([priv.id, shared.id]),
      )
      const forStranger = await Effect.runPromise(
        listViewsProgram(objectId, stranger.id),
      )
      expect(forStranger.map((v) => v.id)).toContain(shared.id)
      expect(forStranger.map((v) => v.id)).not.toContain(priv.id)

      // A stranger can't edit or delete; an admin can.
      await expect(
        Effect.runPromise(
          saveViewProgram(
            { ...base, id: shared.id, name: 'hijack', visibility: 'shared' },
            stranger,
          ),
        ),
      ).rejects.toThrow(ViewForbidden)
      await expect(
        Effect.runPromise(deleteViewProgram(shared.id, stranger)),
      ).rejects.toThrow(ViewForbidden)
      const renamed = await Effect.runPromise(
        saveViewProgram(
          {
            ...base,
            id: shared.id,
            name: 'Seed watch (renamed)',
            visibility: 'shared',
          },
          { ...stranger, isAdmin: true },
        ),
      )
      expect(renamed.name).toBe('Seed watch (renamed)')
      expect(renamed.filter).toEqual(base.filter)
    } finally {
      await Effect.runPromise(deleteViewProgram(priv.id, mine))
      await Effect.runPromise(
        deleteViewProgram(shared.id, { ...mine, isAdmin: true }),
      )
    }
  })
})
