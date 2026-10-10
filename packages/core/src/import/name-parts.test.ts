import { describe, expect, it } from 'vitest'
import { autoMap, validateMapping } from './mapping'
import type { MappingAttribute, MappingRegistry } from './mapping'
import { readRow } from './plan'

/**
 * Import onto a person's name (D67): First name and Last name columns map
 * onto the two parts and make the name; a Name column maps onto the join.
 * No database.
 */

const attr = (
  id: string,
  slug: string,
  name: string,
  type: MappingAttribute['type'],
): MappingAttribute => ({ id, slug, name, type, options: {}, archived: false })

const people: MappingRegistry = {
  identityKeys: ['email'],
  attributes: [
    attr('a-first', 'first_name', 'First name', 'text'),
    attr('a-last', 'last_name', 'Last name', 'text'),
    attr('a-title', 'job_title', 'Job title', 'text'),
  ],
}

describe('import onto the name parts', () => {
  it('guesses First name and Last name onto the parts, Name onto the join', () => {
    expect(autoMap(['First name', 'Surname', 'Email'], people)).toEqual([
      { target: 'attribute', attributeId: 'a-first' },
      { target: 'attribute', attributeId: 'a-last' },
      { target: 'identity', key: 'email' },
    ])
    expect(autoMap(['Name', 'Email'], people)).toEqual([
      { target: 'name' },
      { target: 'identity', key: 'email' },
    ])
  })

  it('takes the parts in place of a name column', () => {
    const parts = autoMap(['First name', 'Last name'], people)
    expect(validateMapping(parts, people, null)).toEqual([])
    const neither = autoMap(['Job title'], people)
    expect(validateMapping(neither, people, null).at(0)?.reason).toBe(
      'Map one column to the name',
    )
  })

  it('reads a row with no name column as the join of its parts', () => {
    const mapping = autoMap(['First name', 'Last name'], people)
    const row = readRow(['Dana', 'Moreau-Iyer'], mapping, people)
    expect(row.name).toBe('Dana Moreau-Iyer')
    expect(row.patch).toEqual({ 'a-first': 'Dana', 'a-last': 'Moreau-Iyer' })
    expect(readRow(['Prince', ''], mapping, people).name).toBe('Prince')
    expect(readRow(['', ''], mapping, people).name).toBeNull()
  })

  it('keeps a Name column as the name when the parts are mapped too', () => {
    const mapping = autoMap(['Name', 'First name', 'Last name'], people)
    const row = readRow(['Dana M. Iyer', 'Dana', 'Iyer'], mapping, people)
    expect(row.name).toBe('Dana M. Iyer')
  })
})
