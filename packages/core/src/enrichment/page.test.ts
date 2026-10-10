import { describe, expect, it } from 'vitest'
import { askWords, keyWord, linkableKeys } from './link'
import { answersOf, fillableCount, fillsWhat, whereFromOf } from './page'
import type { GridSource, ValueEvent } from './page'
import {
  enrichmentSettingsOf,
  scopeFor,
  withBuiltIn,
  withEnrichment,
} from './settings'

const WEB = '00000000-0000-4000-8000-000000000001'
const APOLLO = '00000000-0000-4000-8000-000000000002'
const EXA = '00000000-0000-4000-8000-000000000003'

const manifest = (answers?: Array<string>) => ({
  manifestVersion: 1,
  id: 'apollo',
  version: '1.0.0',
  sdk: '^1.4',
  name: 'Apollo',
  description: 'x',
  settings: {},
  jobs: { enrichCompany: { trigger: 'action', uses: ['Facts'] } },
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
      ...(answers === undefined ? {} : { answers }),
    },
  ],
})

describe('answersOf', () => {
  it('reads the declared keys, else every key of the kind', () => {
    expect([...answersOf(manifest(['company.headcount']), 'company')]).toEqual([
      'company.headcount',
    ])
    const all = answersOf(manifest(), 'company')
    expect(all.has('company.headcount')).toBe(true)
    expect(all.has('person.title')).toBe(false)
    expect(answersOf(manifest(), 'person').size).toBe(0)
    expect(answersOf({ nonsense: true }, 'company').size).toBe(0)
  })
})

describe('fillsWhat', () => {
  const sources: Array<GridSource> = [
    {
      id: WEB,
      name: 'Website',
      on: true,
      answers: new Set(['company.description']),
    },
    {
      id: APOLLO,
      name: 'Apollo',
      on: true,
      answers: new Set(['company.description', 'company.headcount']),
    },
    {
      id: EXA,
      name: 'Exa',
      on: false,
      answers: new Set(['company.headcount']),
    },
  ]

  it('names the first source on, in order, that answers each linked attribute', () => {
    const rows = fillsWhat(
      [
        { slug: 'description', key: 'company.description' },
        { slug: 'employees', key: 'company.headcount' },
        { slug: 'notes', key: null },
      ],
      sources,
    )
    expect(rows.map((r) => [r.slug, r.filledBy, r.cells])).toEqual([
      ['description', 'Website', ['fills', 'next', 'none']],
      ['employees', 'Apollo', ['none', 'fills', 'could']],
      ['notes', null, ['none', 'none', 'none']],
    ])
  })

  it('follows the order it is given: Apollo above Website fills first', () => {
    const [first] = fillsWhat(
      [{ slug: 'description', key: 'company.description' }],
      [sources[1], sources[0]],
    )
    expect(first.filledBy).toBe('Apollo')
    expect(first.cells).toEqual(['fills', 'next'])
  })

  it('counts the linked keys a source can fill', () => {
    expect(
      fillableCount(
        ['company.description', 'company.headcount', 'company.headcount'],
        sources[1].answers,
      ),
    ).toBe(2)
  })
})

describe('whereFromOf', () => {
  const ev = (over: Partial<ValueEvent>): ValueEvent => ({
    slug: 'employees',
    to: null,
    from: null,
    at: '2026-01-01T00:00:00.000Z',
    actorType: 'integration',
    actorRef: APOLLO,
    ...over,
  })
  const names = new Map([[APOLLO, 'Apollo']])

  it('names the source and date, and a changing figure’s earlier value with its date', () => {
    const found = whereFromOf(
      [
        ev({ to: 42, at: '2026-07-12T09:00:00.000Z' }),
        ev({ to: 57, from: 42, at: '2026-10-04T09:00:00.000Z' }),
      ],
      names,
      new Set(['employees']),
    )
    expect(found.get('employees')).toEqual({
      source: 'Apollo',
      at: '2026-10-04T09:00:00.000Z',
      earlier: [{ value: '42', at: '2026-07-12T09:00:00.000Z' }],
    })
  })

  it('shows no history for a fixed field, and nothing for a person’s value', () => {
    const found = whereFromOf(
      [
        ev({ slug: 'founded', to: 2019, at: '2026-07-12T09:00:00.000Z' }),
        ev({ slug: 'founded', to: 2022, at: '2026-10-04T09:00:00.000Z' }),
        ev({
          slug: 'location',
          to: 'Pune',
          actorType: 'user',
          actorRef: null,
        }),
      ],
      names,
      new Set(['employees']),
    )
    expect(found.get('founded')?.earlier).toEqual([])
    expect(found.has('location')).toBe(false)
  })
})

describe('the settings the page writes', () => {
  it('round-trips through the reader the run and the auto checks use', () => {
    const written = withEnrichment(
      { base_currency: 'INR' },
      {
        sources: [APOLLO, WEB],
        reuseDays: 30,
        scope: {
          ids: [APOLLO],
          scope: { scopes: ['deal', 'space'], spaces: [] },
        },
      },
    )
    expect(written['base_currency']).toBe('INR')
    const read = enrichmentSettingsOf(written)
    expect(read.sources).toEqual([APOLLO, WEB])
    expect(read.reuseDays).toBe(30)
    expect(scopeFor(read, APOLLO, {}).scopes).toEqual(['deal', 'space'])
    expect(
      withBuiltIn(read, { id: WEB }, [{ id: APOLLO }]).map((s) => s.id),
    ).toEqual([APOLLO, WEB])
    const cleared = enrichmentSettingsOf(
      withEnrichment(written, { reuseDays: null }),
    )
    expect(cleared.reuseDays).toBe(null)
    expect(cleared.sources).toEqual([APOLLO, WEB])
  })
})

describe('Fill from', () => {
  it('offers the keys of the object’s kind that the type can hold', () => {
    const number = linkableKeys('number', 'company')
    expect(number).toContain('company.headcount')
    expect(number).not.toContain('company.description')
    expect(number).not.toContain('person.title')
    expect(linkableKeys('record_reference', 'person', 'company')).toEqual([
      'person.company',
    ])
    expect(keyWord('company.founded_year')).toBe('founded year')
    expect(askWords(['Website', 'Apollo'])).toBe('Website, then Apollo')
  })
})
