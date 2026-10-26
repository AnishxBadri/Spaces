import { describe, expect, it } from 'vitest'
import { linksPeople } from './head'

/** A custom object's head logs interactions only when it links people. */

const ref = (targetKind: 'person' | 'company' | 'deal', archived = false) => ({
  type: 'record_reference',
  options: { targetKind },
  archived,
})

describe('linksPeople', () => {
  it('is true for a relation attribute targeting person', () => {
    expect(linksPeople([{ type: 'text', options: {} }, ref('person')])).toBe(
      true,
    )
  })

  it('is false with relations to other kinds only, or none', () => {
    expect(linksPeople([ref('company'), ref('deal')])).toBe(false)
    expect(linksPeople([])).toBe(false)
  })

  it('ignores an archived relation to person', () => {
    expect(linksPeople([ref('person', true)])).toBe(false)
  })

  it('reads the type, not a target on some other attribute', () => {
    expect(
      linksPeople([
        { type: 'text', options: { targetKind: 'person' as const } },
      ]),
    ).toBe(false)
  })
})
