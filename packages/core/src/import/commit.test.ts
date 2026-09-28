import { describe, expect, it } from 'vitest'
import {
  commitOutcomeOf,
  commitRunLine,
  createKeysOf,
  foldMerged,
} from './commit'
import type { RowPlan } from './plan'

const plan = (over: Partial<RowPlan> = {}): RowPlan => ({
  verdict: 'create',
  creator: 'resolveEntity',
  name: 'Acme',
  patch: {},
  identity: {},
  errors: [],
  skippedCells: [],
  ...over,
})

describe('folding merged rows', () => {
  it('fills blanks only, the survivor first and then the earlier folded row', () => {
    const folds = foldMerged([
      {
        rowNum: 3,
        plan: plan({
          verdict: 'merged',
          mergedInto: 1,
          patch: { a: 'third', c: 'third' },
        }),
      },
      {
        rowNum: 1,
        plan: plan({ patch: { a: 'first' }, identity: { domain: 'acme.com' } }),
      },
      {
        rowNum: 2,
        plan: plan({
          verdict: 'merged',
          mergedInto: 1,
          patch: { a: 'second', b: 'second' },
          identity: { linkedin: 'linkedin.com/company/acme' },
        }),
      },
      { rowNum: 4, plan: plan({ verdict: 'skip' }) },
    ])
    expect([...folds.keys()]).toEqual([1])
    const one = folds.get(1)
    expect(one?.folded).toEqual([2, 3])
    expect(one?.plan.patch).toEqual({ a: 'first', b: 'second', c: 'third' })
    expect(one?.plan.identity).toEqual({
      domain: 'acme.com',
      linkedin: 'linkedin.com/company/acme',
    })
  })

  it('carries a create only a folded row referenced', () => {
    const create = {
      to: 'create' as const,
      column: 2,
      attributeId: 'company',
      key: 'obj|name:ohmium',
      name: 'Ohmium',
      objectId: 'obj',
      creator: 'resolveEntity' as const,
      createName: 'Ohmium',
      identity: {},
    }
    const folds = foldMerged([
      { rowNum: 1, plan: plan() },
      {
        rowNum: 2,
        plan: plan({ verdict: 'merged', mergedInto: 1, references: [create] }),
      },
    ])
    const survivor = folds.get(1)?.plan
    expect(survivor && createKeysOf(survivor)).toEqual(['obj|name:ohmium'])
  })
})

describe('a row’s outcome', () => {
  it('names what the commit did, and what it did instead of the plan', () => {
    expect(
      commitOutcomeOf({ plan: plan(), entityId: null, error: null }),
    ).toEqual({ kind: 'pending' })
    expect(
      commitOutcomeOf({ plan: plan(), entityId: 'e1', error: null }),
    ).toEqual({
      kind: 'created',
      entityId: 'e1',
    })
    expect(
      commitOutcomeOf({
        plan: plan({ committedAs: 'attach' }),
        entityId: 'e1',
        error: null,
      }),
    ).toEqual({ kind: 'attached', entityId: 'e1' })
    expect(
      commitOutcomeOf({ plan: plan(), entityId: null, error: 'stage: no' }),
    ).toEqual({
      kind: 'failed',
      reason: 'stage: no',
    })
    expect(
      commitOutcomeOf({
        plan: plan({ verdict: 'merged', mergedInto: 4 }),
        entityId: 'e4',
        error: null,
      }),
    ).toEqual({ kind: 'folded', into: 4, entityId: 'e4' })
    expect(
      commitOutcomeOf({
        plan: plan({ verdict: 'skip' }),
        entityId: null,
        error: null,
      }),
    ).toEqual({
      kind: 'skipped',
      reason: 'both rows skipped by decision',
    })
  })

  it('writes a run line the batch page can find by its batch', () => {
    expect(
      commitRunLine('b1', {
        written: 0,
        attached: 0,
        failed: 0,
        unchanged: 46,
      }),
    ).toBe('batch b1 · 0 written · 0 attached · 0 failed · 46 unchanged')
  })
})
