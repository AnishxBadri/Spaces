import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  CONTINUE_REFUSED_TOAST,
  objectForSearch,
  refuseContinue,
} from './import-wizard'
import { footLine } from './mapping-grid'

/**
 * SPA-173, the wizard's nits: the object a `?object=` link names, the foot
 * line's column range, and the refused-Continue toast that must not outlive
 * the Continue that goes through. `sonner` is mocked, so the toast calls are
 * asserted rather than drawn.
 */

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }),
}))

const OBJECTS = [
  { id: 'o-c', slug: 'companies', singular: 'Company', plural: 'Companies' },
  { id: 'o-p', slug: 'people', singular: 'Person', plural: 'People' },
  { id: 'o-d', slug: 'deals', singular: 'Deal', plural: 'Deals' },
]

describe('the object a link names', () => {
  it('finds it by slug, singular or plural, in any case', () => {
    expect(objectForSearch(OBJECTS, 'deals')?.id).toBe('o-d')
    expect(objectForSearch(OBJECTS, 'deal')?.id).toBe('o-d')
    expect(objectForSearch(OBJECTS, 'Deals')?.id).toBe('o-d')
    expect(objectForSearch(OBJECTS, 'person')?.id).toBe('o-p')
  })

  it('is no object when nothing matches or nothing was named', () => {
    expect(objectForSearch(OBJECTS, 'funds')).toBeNull()
    expect(objectForSearch(OBJECTS, undefined)).toBeNull()
    expect(objectForSearch(OBJECTS, '  ')).toBeNull()
  })
})

describe('the mapping foot line', () => {
  it('prints one off-screen column as one letter, and two as a range', () => {
    expect(footLine(20, 46, 6, { first: 0, last: 4 })).toBe(
      '20 of 46 rows · 5 of 6 columns · scroll → for F',
    )
    expect(footLine(20, 46, 7, { first: 0, last: 4 })).toBe(
      '20 of 46 rows · 5 of 7 columns · scroll → for F–G',
    )
    expect(footLine(20, 46, 7, { first: 1, last: 6 })).toBe(
      '20 of 46 rows · 6 of 7 columns · scroll ← for A',
    )
  })
})

describe('a refused Continue', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.dismiss).mockClear()
  })

  it('raises one toast under a stable id, and the next Continue that goes through dismisses it', () => {
    const problems = [
      { reason: 'Map a column to the name' },
      { reason: 'Stage is mapped twice' },
    ]
    expect(refuseContinue(problems)).toBe(true)
    expect(toast.error).toHaveBeenCalledWith('Map a column to the name', {
      id: CONTINUE_REFUSED_TOAST,
      description: 'Stage is mapped twice',
    })
    expect(toast.dismiss).not.toHaveBeenCalled()

    expect(refuseContinue([])).toBe(false)
    expect(toast.dismiss).toHaveBeenCalledWith(CONTINUE_REFUSED_TOAST)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
