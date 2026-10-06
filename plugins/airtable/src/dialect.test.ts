import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { airtableGrid, columnKind, parseCsv, readList } from './dialect.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

describe('parseCsv', () => {
  it('reads quotes, escaped quotes, CRLF and a BOM', () => {
    expect(
      parseCsv('﻿Name,Note\r\n"Acme, Inc","He said ""hi"""\r\nBeta,\r\n'),
    ).toEqual([
      ['Name', 'Note'],
      ['Acme, Inc', 'He said "hi"'],
      ['Beta', ''],
    ])
  })

  it('keeps a line break inside a quoted cell', () => {
    expect(parseCsv('a,"two\nlines"\n')).toEqual([['a', 'two\nlines']])
  })
})

describe('readList', () => {
  it('splits on a bare comma and reads a quoted item whole', () => {
    expect(readList('B2B,Marketplace')).toEqual({
      items: ['B2B', 'Marketplace'],
      prose: false,
    })
    expect(readList('"Doe, Jane",Ada Park')).toEqual({
      items: ['Doe, Jane', 'Ada Park'],
      prose: false,
    })
  })

  it('marks a comma followed by a space as prose', () => {
    expect(readList('Berlin, Germany')?.prose).toBe(true)
  })

  it('answers null for a quote that is not closed cleanly', () => {
    expect(readList('"open')).toBeNull()
    expect(readList('"Best" product,ever')).toBeNull()
  })
})

describe('columnKind', () => {
  it('reads a column as a list only when a cell joins items and none is prose', () => {
    expect(columnKind(['B2B', 'B2B,Marketplace', ''])).toBe('list')
    expect(columnKind(['Berlin, Germany', 'Oslo'])).toBe('text')
    expect(columnKind(['Seed', 'Series A'])).toBe('text')
    expect(columnKind(['$1,250.00', '400'])).toBe('text')
  })

  it('reads a column of `name (url)` cells as attachments', () => {
    expect(
      columnKind([
        'deck.pdf (https://dl.airtable.com/a/deck.pdf)',
        '',
        'a.pdf (https://dl.airtable.com/b/a.pdf),b.png (https://dl.airtable.com/c/b.png)',
      ]),
    ).toBe('attachments')
  })
})

describe('airtableGrid', () => {
  it('reads the 30-row export: lists split, attachments reduced to URLs, prose left whole', () => {
    const grid = airtableGrid(fixture('Companies-Grid view.csv'))
    if (grid === null) throw new Error('no grid')
    expect(grid.columns).toEqual([
      'Name',
      'Website',
      'Business model',
      'Funding stage',
      'Location',
      'Founded',
      'Founders',
      'Deck',
    ])
    expect(grid.kinds).toEqual([
      'text',
      'text',
      'list',
      'text',
      'text',
      'text',
      'list',
      'attachments',
    ])
    expect(grid.rows).toHaveLength(30)
    expect(grid.rows.map((r) => r.ordinal)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    )
    expect(grid.rows.at(1)).toEqual({
      ordinal: 2,
      cells: [
        'Acme Fusion',
        'https://www.acme-fusion.example',
        ['B2B', 'Marketplace'],
        'Series A',
        'Boston, MA',
        '2021',
        ['Leo Brandt', 'Mia Okafor'],
        'https://dl.airtable.com/.attachments/att001/acme-fusion-deck.pdf',
      ],
    })
    expect(grid.rows.at(3)?.cells.at(7)).toBe('')
  })

  it('hands several attachments over as a list of URLs', () => {
    const grid = airtableGrid(
      'Name,Files\nAcme,"a.pdf (https://dl.airtable.com/1/a.pdf),b.pdf (https://dl.airtable.com/2/b.pdf)"\n',
    )
    expect(grid?.rows.at(0)?.cells.at(1)).toEqual([
      'https://dl.airtable.com/1/a.pdf',
      'https://dl.airtable.com/2/b.pdf',
    ])
  })

  it('answers null for a file with no header', () => {
    expect(airtableGrid('\n\n')).toBeNull()
  })
})
