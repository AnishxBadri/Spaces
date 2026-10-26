import { describe, expect, it } from 'vitest'
import type { AttributeDef } from '../attributes/registry'
import {
  UnknownVariable,
  checkVariables,
  parseVariables,
  resolveVariables,
} from './variables'
import type { VariableContext, VariableRecord } from './variables'

/** The variable grammar and its resolver: every path family, blanks, refusals. */

const def = (
  slug: string,
  type: AttributeDef['type'],
  options: AttributeDef['options'] = {},
): AttributeDef => ({
  id: `attr-${slug}`,
  objectId: 'obj-person',
  slug,
  name: slug,
  type,
  options,
  isSystem: true,
  archived: false,
  sortOrder: 0,
})

const ATTRIBUTES: Array<AttributeDef> = [
  def('first_name', 'text'),
  def('last_name', 'text'),
  def('job_title', 'text'),
  def('seniority', 'select', {
    options: [{ id: 'opt-1', label: 'Founder' }],
  }),
  def('companies', 'record_reference', { targetKind: 'company', multi: true }),
  { ...def('old_field', 'text'), archived: true },
]

const dana: VariableRecord = {
  canonicalName: 'Dana Moreau',
  values: {
    first_name: 'Dana',
    last_name: 'Moreau',
    job_title: 'CEO',
    seniority: 'opt-1',
    companies: ['co-flent'],
  },
  company: 'Flent',
  stats: {
    last_interaction: '2026-10-12T10:00:00.000Z',
    last_email: '2026-10-12T10:00:00.000Z',
    next_meeting: null,
  },
}

const ctx = (record: VariableRecord | null): VariableContext => ({
  attributes: ATTRIBUTES,
  record,
  names: (id) => (id === 'co-flent' ? 'Flent' : undefined),
})

const resolved = (text: string, record: VariableRecord | null) => {
  const r = resolveVariables(text, ctx(record))
  if (r instanceof UnknownVariable) throw new Error(r.message)
  return r
}

describe('parseVariables', () => {
  it('reads each {{path}} once, in the order first written', () => {
    expect(
      parseVariables(
        'Hi {{name.first}}, about {{company.name}}. {{name.first}} again',
      ),
    ).toEqual(['name.first', 'company.name'])
  })

  it('reads nothing from text with no braces, and keeps a malformed token whole', () => {
    expect(parseVariables('Plain text, {single} braces')).toEqual([])
    expect(parseVariables('{{ Name.First }}')).toEqual([' Name.First '])
  })
})

describe('resolveVariables', () => {
  it('reads the name parts from the attributes, the full name from the record', () => {
    const r = resolved('{{name.first}} / {{name.last}} / {{name.full}}', dana)
    expect(r.text).toBe('Dana / Moreau / Dana Moreau')
    expect(r.blanks).toEqual([])
  })

  it('reads the current company and the interaction stats', () => {
    const r = resolved(
      '{{company.name}} · {{last_interaction.when}} · {{last_email.when}}',
      dana,
    )
    expect(r.text).toBe('Flent · 12 Oct 2026 · 12 Oct 2026')
  })

  it('reads any live attribute by slug, rendered as the record shows it', () => {
    const r = resolved('{{job_title}}, {{seniority}} at {{companies}}', dana)
    expect(r.text).toBe('CEO, Founder at Flent')
  })

  it('reports a path that holds nothing as a blank, filled or left empty', () => {
    const noFirst: VariableRecord = {
      ...dana,
      values: { ...dana.values, first_name: '  ' },
    }
    const r = resolveVariables(
      'Hi {{name.first}}, see you {{next_meeting.when}}',
      ctx(noFirst),
      { 'name.first': 'Dana' },
    )
    if (r instanceof UnknownVariable) throw new Error(r.message)
    expect(r.blanks).toEqual(['name.first', 'next_meeting.when'])
    expect(r.values['name.first']).toBeNull()
    expect(r.text).toBe('Hi Dana, see you ')
  })

  it('never parses a first name out of the full name', () => {
    const r = resolved('{{name.first}}', {
      ...dana,
      values: { last_name: 'Moreau' },
    })
    expect(r.blanks).toEqual(['name.first'])
  })

  it('reads every known path of an address no record holds as a blank', () => {
    const r = resolved('{{name.first}} {{job_title}}', null)
    expect(r.blanks).toEqual(['name.first', 'job_title'])
  })

  it('refuses a path no slug matches, naming it', () => {
    for (const path of [
      'favourite_colour',
      'old_field',
      'name.middle',
      'job_title.short',
      ' Name.First ',
    ]) {
      const r = resolveVariables(`Hi {{${path}}}`, ctx(dana))
      expect(r).toBeInstanceOf(UnknownVariable)
      if (!(r instanceof UnknownVariable)) continue
      expect(r.path).toBe(path)
      expect(r.message).toBe(`No attribute matches {{${path}}}`)
    }
  })

  it('checks a set of paths without a record', () => {
    expect(checkVariables(['name.first', 'job_title'], ATTRIBUTES)).toBeNull()
    expect(checkVariables(['name.first', 'nope'], ATTRIBUTES)?.path).toBe(
      'nope',
    )
  })
})
