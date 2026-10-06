import { describe, expect, it } from 'vitest'
import {
  joinImportList,
  landImportGrid,
  splitImportList,
} from './import-grid.ts'

describe('joinImportList and splitImportList', () => {
  it('joins plain items with a bare comma, as a dialect export does', () => {
    expect(joinImportList(['B2B', 'Marketplace'])).toBe('B2B,Marketplace')
    expect(joinImportList(['1', '000'])).toBe('1,000')
  })

  it('round-trips items holding a separator or opening with a quote', () => {
    const items = ['Health, Wellness', 'R;D', '"Quoted" label', 'He said "hi"']
    const joined = joinImportList(items)
    expect(joined).toBe(
      '"Health, Wellness","R;D","""Quoted"" label",He said "hi"',
    )
    expect(splitImportList(joined)).toEqual(items)
  })

  it('splits on commas and semicolons, trimming and dropping blanks', () => {
    expect(splitImportList('B2B, Marketplace ;Hardware,,')).toEqual([
      'B2B',
      'Marketplace',
      'Hardware',
    ])
    expect(splitImportList('')).toEqual([])
  })

  it('answers null for a quote that is not closed cleanly', () => {
    expect(splitImportList('"open, never closed')).toBeNull()
    expect(splitImportList('"Best" product,ever')).toBeNull()
  })
})

describe('landImportGrid', () => {
  it('pads rows to the width and lands a list cell as its joined text', () => {
    const landed = landImportGrid({
      columns: ['Name', 'Business model', 'Notes'],
      rows: [
        { ordinal: 2, cells: ['Beta', ['B2C']] },
        { ordinal: 1, cells: ['Acme', ['B2B', 'Marketplace'], 'x'] },
      ],
    })
    expect(landed).toEqual({
      columns: ['Name', 'Business model', 'Notes'],
      rows: [
        { rowNum: 1, cells: ['Acme', 'B2B,Marketplace', 'x'], reason: null },
        { rowNum: 2, cells: ['Beta', 'B2C', ''], reason: null },
      ],
      refused: [],
    })
  })

  it('fails a malformed row alone, keeping its ordinal', () => {
    const landed = landImportGrid({
      columns: ['Name'],
      rows: [
        { ordinal: 1, cells: ['Acme'] },
        { ordinal: 2, cells: [42] },
        { ordinal: 3, cells: ['Beta', 'extra'] },
        { ordinal: 4, cells: 'Gamma' },
        { ordinal: 5, cells: [['ok', 7]] },
      ],
    })
    expect('rows' in landed ? landed.rows : null).toEqual([
      { rowNum: 1, cells: ['Acme'], reason: null },
      {
        rowNum: 2,
        cells: null,
        reason: 'cell 1 is neither text nor a list of text',
      },
      { rowNum: 3, cells: null, reason: 'the row has 2 cells for 1 columns' },
      { rowNum: 4, cells: null, reason: 'the row has no list of cells' },
      {
        rowNum: 5,
        cells: null,
        reason: 'cell 1 is neither text nor a list of text',
      },
    ])
  })

  it('refuses a row it cannot place, and the second use of an ordinal', () => {
    const landed = landImportGrid({
      columns: ['Name'],
      rows: [
        { ordinal: 1, cells: ['Acme'] },
        { ordinal: 1, cells: ['Again'] },
        { ordinal: 0, cells: ['Zero'] },
        { ordinal: 2.5, cells: ['Half'] },
        { cells: ['None'] },
      ],
    })
    expect('refused' in landed ? landed.refused : null).toEqual([
      { ordinal: 1, reason: 'ordinal 1 is used twice' },
      {
        ordinal: 0,
        reason:
          'row 3 of the grid has no ordinal that is a positive whole number',
      },
      {
        ordinal: 2.5,
        reason:
          'row 4 of the grid has no ordinal that is a positive whole number',
      },
      {
        ordinal: 0,
        reason:
          'row 5 of the grid has no ordinal that is a positive whole number',
      },
    ])
  })

  it('names a grid with no header or no rows as unreadable', () => {
    expect(landImportGrid(null)).toEqual({
      unreadable: 'the grid is not an object',
    })
    expect(landImportGrid({ columns: [], rows: [] })).toEqual({
      unreadable: 'the grid names no columns',
    })
    expect(landImportGrid({ columns: ['Name'] })).toEqual({
      unreadable: 'the grid has no rows',
    })
  })
})
