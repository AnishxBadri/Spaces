import { describe, expect, it } from 'vitest'
import { autoMap } from '../import/mapping'
import {
  csvLine,
  exportCell,
  exportColumns,
  exportRow,
  exportSummary,
  noteMarkdown,
  notePath,
  readExportSummary,
} from './workspace'
import type { MappingAttribute, MappingRegistry } from '../import/mapping'

/** The export's file shapes, against registries built by hand. */

const attr = (
  id: string,
  slug: string,
  name: string,
  type: MappingAttribute['type'],
  options: MappingAttribute['options'] = {},
): MappingAttribute => ({ id, slug, name, type, options, archived: false })

const lookups = {
  recordNames: new Map([['r1', 'Acme, Inc']]),
  memberEmails: new Map([['u1', 'anish@fund.example']]),
}

describe('exportColumns', () => {
  it('is the name, the identity keys, then the offered attributes, less derived ones', () => {
    const registry: MappingRegistry = {
      identityKeys: ['domain'],
      attributes: [
        attr('a1', 'domains', 'Domains', 'domain', {
          multi: true,
          identityKey: 'domain',
        }),
        attr('a2', 'stage', 'Stage', 'select'),
        attr('a3', 'team', 'Team', 'record_reference', { derived: true }),
        { ...attr('a4', 'old', 'Old', 'text'), archived: true },
      ],
    }
    const columns = exportColumns(registry)
    expect(columns.map((c) => c.header)).toEqual(['Name', 'Domain', 'Stage'])
    expect(columns.at(1)?.source).toEqual({
      kind: 'identity',
      key: 'domain',
      slug: 'domains',
    })
  })

  it('heads a column by its slug when its name would map elsewhere', () => {
    const registry: MappingRegistry = {
      identityKeys: [],
      attributes: [
        attr('a1', 'round_stage', 'Stage', 'text'),
        attr('a2', 'stage', 'Pipeline stage', 'text'),
      ],
    }
    const headers = exportColumns(registry).map((c) => c.header)
    expect(headers).toEqual(['Name', 'round_stage', 'Pipeline stage'])
    expect(autoMap(headers, registry)).toEqual([
      { target: 'name' },
      { target: 'attribute', attributeId: 'a1' },
      { target: 'attribute', attributeId: 'a2' },
    ])
  })
})

describe('exportCell', () => {
  it('writes options by label, references by name or email, lists joined', () => {
    const select = attr('s', 's', 'S', 'multi_select', {
      options: [
        { id: 'b2b', label: 'B2B' },
        { id: 'hw', label: 'Hardware, devices' },
      ],
    })
    expect(exportCell(select, ['b2b', 'hw'], lookups)).toBe(
      'B2B,"Hardware, devices"',
    )
    expect(
      exportCell(attr('r', 'r', 'R', 'record_reference'), ['r1'], lookups),
    ).toBe('"Acme, Inc"')
    expect(
      exportCell(attr('o', 'o', 'O', 'actor_reference'), 'u1', lookups),
    ).toBe('anish@fund.example')
    expect(exportCell(attr('n', 'n', 'N', 'number'), 12.5, lookups)).toBe(
      '12.5',
    )
    expect(exportCell(attr('c', 'c', 'C', 'checkbox'), false, lookups)).toBe(
      'false',
    )
    expect(exportCell(attr('t', 't', 'T', 'text'), undefined, lookups)).toBe('')
  })

  it('puts the first identity value in the key column', () => {
    const registry: MappingRegistry = {
      identityKeys: ['email'],
      attributes: [
        attr('e', 'emails', 'Emails', 'email', {
          multi: true,
          identityKey: 'email',
        }),
      ],
    }
    expect(
      exportRow(
        exportColumns(registry),
        { name: 'Ada', values: { emails: ['ada@x.com', 'ada@y.com'] } },
        lookups,
      ),
    ).toEqual(['Ada', 'ada@x.com'])
  })
})

describe('csvLine', () => {
  it('quotes a field only when it must', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', ' pad', 'x\ny'])).toBe(
      'a,"b,c","say ""hi"""," pad","x\ny"\r\n',
    )
  })
})

describe('notes', () => {
  const n = {
    id: '3f2a9c1e-0000-4000-8000-000000000000',
    title: 'Intro: "call"',
    kind: 'note',
    author: 'Anish <anish@fund.example>',
    filedOn: ['Acme'],
    createdAt: new Date('2026-11-18T09:00:00.000Z'),
    updatedAt: new Date('2026-11-18T10:00:00.000Z'),
    body: 'Body',
  }

  it('writes front matter, then the body', () => {
    expect(noteMarkdown(n)).toBe(
      [
        '---',
        'title: "Intro: \\"call\\""',
        'kind: note',
        'author: "Anish <anish@fund.example>"',
        'filed_on:',
        '  - "Acme"',
        'created: 2026-11-18T09:00:00.000Z',
        'updated: 2026-11-18T10:00:00.000Z',
        '---',
        'Body',
        '',
      ].join('\n'),
    )
  })

  it('names the file by day, title and id', () => {
    expect(notePath(n)).toBe('notes/2026-11-18-intro-call-3f2a9c1e.md')
  })
})

describe('the summary line', () => {
  it('reads back the digest and size it leads with', () => {
    const line = exportSummary({
      sha: 'a'.repeat(64),
      sizeBytes: 1234,
      objects: 3,
      records: 10,
      notes: 2,
      documents: 1,
    })
    expect(readExportSummary(line)).toEqual({
      sha: 'a'.repeat(64),
      sizeBytes: 1234,
    })
    expect(readExportSummary('fetched 3')).toBeNull()
  })
})
