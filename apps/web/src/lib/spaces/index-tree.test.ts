import { describe, expect, it } from 'vitest'
import { spacePaths, treeRows } from './index-tree'

const row = (id: string, parentId: string | null, depth: number) => ({
  id,
  name: id,
  parentId,
  depth,
})

// Proptech › (Property ops › (Leasing, Maintenance), Construction tech),
// Fintech › Lending infra, Real estate — the sheet's tree.
const rows = [
  row('proptech', null, 0),
  row('ops', 'proptech', 1),
  row('leasing', 'ops', 2),
  row('maintenance', 'ops', 2),
  row('construction', 'proptech', 1),
  row('fintech', null, 0),
  row('lending', 'fintech', 1),
  row('real-estate', null, 0),
]

describe('treeRows', () => {
  it('draws ├ before a later sibling and └ on the last child', () => {
    expect(treeRows(rows).map((r) => [r.id, r.mark])).toEqual([
      ['proptech', null],
      ['ops', '├'],
      ['leasing', '├'],
      ['maintenance', '└'],
      ['construction', '└'],
      ['fintech', null],
      ['lending', '└'],
      ['real-estate', null],
    ])
  })

  it('rules only the last row of each top-level group', () => {
    expect(
      treeRows(rows)
        .filter((r) => r.groupEnd)
        .map((r) => r.id),
    ).toEqual(['construction', 'lending', 'real-estate'])
  })
})

describe('spacePaths', () => {
  it('names each space by its path', () => {
    const paths = spacePaths(rows)
    expect(paths.get('proptech')).toBe('proptech')
    expect(paths.get('leasing')).toBe('proptech / ops / leasing')
  })
})
