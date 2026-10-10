import { describe, expect, it } from 'vitest'
import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import {
  DEFAULT_SPACE_TAB,
  filterCompanies,
  openSpaceTab,
  sortCompanies,
  spacePeople,
  spaceSearch,
  stageLabel,
  stageMix,
  stageOrder,
} from './page'

/** The seeded `funding_stage` options, read from the registry as the page does. */
const seeded = (
  SYSTEM_ATTRIBUTES.company.find((a) => a.slug === 'funding_stage')?.options
    ?.options ?? []
).map((o) => ({ id: o.id, label: o.label }))

describe('the funding-stage mix', () => {
  it('reads real options from the registry', () => {
    expect(seeded.map((o) => o.id)).toContain('bootstrapped')
    expect(seeded.length).toBeGreaterThan(2)
  })

  it('orders as the registry orders, bootstrapped last', () => {
    // Bootstrapped first in the options still lands last in the bar.
    const reordered = [
      { id: 'bootstrapped', label: 'Bootstrapped' },
      { id: 'series_a', label: 'Series A' },
      { id: 'seed', label: 'Seed' },
    ]
    expect(stageOrder(reordered).map((o) => o.id)).toEqual([
      'series_a',
      'seed',
      'bootstrapped',
    ])
    const mix = stageMix(
      ['seed', 'bootstrapped', 'series_a', 'seed'],
      reordered,
    )
    expect(mix.map((s) => s.id)).toEqual(['series_a', 'seed', 'bootstrapped'])
  })

  it('sums to the companies counted, the unstaged included', () => {
    const stages = [
      'seed',
      'series_a',
      null,
      'Seed', // imported as a label
      'bootstrapped',
      'not_an_option',
      'pre_seed',
    ]
    const mix = stageMix(stages, seeded)
    expect(mix.reduce((n, s) => n + s.count, 0)).toBe(stages.length)
    expect(mix.find((s) => s.id === 'seed')?.count).toBe(2)
    expect(mix.at(-1)).toMatchObject({ id: null, count: 2, level: 0 })
    const order = seeded.map((o) => o.id).filter((id) => id !== 'bootstrapped')
    const funded = mix.filter((s) => s.id !== null && s.id !== 'bootstrapped')
    expect(funded.map((s) => order.indexOf(s.id ?? ''))).toEqual(
      [...funded.map((s) => order.indexOf(s.id ?? ''))].sort((a, b) => a - b),
    )
    expect(mix.at(-2)?.id).toBe('bootstrapped')
  })

  it('is denser at each later stage, bootstrapped lightest', () => {
    const mix = stageMix(
      seeded.map((o) => o.id),
      seeded,
    )
    const levels = mix.map((s) => s.level)
    const funded = levels.slice(0, -1)
    expect(funded).toEqual([...funded].sort((a, b) => a - b))
    expect(new Set(funded).size).toBe(funded.length)
    expect(levels.at(-1)).toBeLessThan(Math.min(...funded))
  })

  it('is empty for a space with no companies', () => {
    expect(stageMix([], seeded)).toEqual([])
  })

  it('labels a stored id by its option', () => {
    expect(stageLabel('series_a', seeded)).toBe('Series A')
    expect(stageLabel('odd', seeded)).toBe('odd')
    expect(stageLabel(null, seeded)).toBeNull()
  })
})

describe('the tabs', () => {
  it('opens on Notes, else the remembered tab, and a link wins', () => {
    expect(DEFAULT_SPACE_TAB).toBe('notes')
    expect(openSpaceTab(undefined, null)).toBe('notes')
    expect(openSpaceTab(undefined, 'files')).toBe('files')
    expect(openSpaceTab(undefined, 'interactions')).toBe('notes')
    expect(openSpaceTab('companies', 'files')).toBe('companies')
  })

  it('reads ?tab= and drops what is not a tab', () => {
    expect(spaceSearch.parse({ tab: 'companies' })).toEqual({
      tab: 'companies',
    })
    expect(spaceSearch.parse({ tab: 'referenced' }).tab).toBeUndefined()
    expect(spaceSearch.parse({}).tab).toBeUndefined()
  })
})

describe('the Companies tab', () => {
  const rows = [
    { name: 'Tenantry', stage: 'seed', deals: 0, filedAt: '2026-10-01' },
    { name: 'Arbor', stage: 'series_a', deals: 2, filedAt: '2026-10-06' },
    { name: 'Bricks', stage: null, deals: 1, filedAt: '2026-09-20' },
    { name: 'Corbel', stage: 'bootstrapped', deals: 0, filedAt: '2026-10-03' },
    { name: 'Atrium', stage: 'pre_seed', deals: 0, filedAt: '2026-10-02' },
  ]

  it('filters to the pipeline or to the watched', () => {
    expect(filterCompanies(rows, 'all')).toHaveLength(5)
    expect(filterCompanies(rows, 'pipeline').map((r) => r.name)).toEqual([
      'Arbor',
      'Bricks',
    ])
    expect(filterCompanies(rows, 'watching').map((r) => r.name)).toEqual([
      'Tenantry',
      'Corbel',
      'Atrium',
    ])
  })

  it('sorts by funding stage by default order, then name or filing', () => {
    expect(sortCompanies(rows, 'stage', seeded).map((r) => r.name)).toEqual([
      'Atrium',
      'Tenantry',
      'Arbor',
      'Corbel',
      'Bricks',
    ])
    expect(sortCompanies(rows, 'name', seeded).map((r) => r.name)).toEqual([
      'Arbor',
      'Atrium',
      'Bricks',
      'Corbel',
      'Tenantry',
    ])
    expect(sortCompanies(rows, 'filed', seeded).at(0)?.name).toBe('Arbor')
  })
})

describe('the People tab', () => {
  it('lists the filed, then the companies’ people, once each', () => {
    const people = spacePeople(
      [{ id: 'p1', name: 'Ada' }],
      [
        { id: 'p1', name: 'Ada', companyName: 'Arbor' },
        { id: 'p2', name: 'Ben', companyName: 'Arbor' },
        { id: 'p2', name: 'Ben', companyName: 'Corbel' },
      ],
    )
    expect(people.map((p) => [p.person.id, p.kind])).toEqual([
      ['p1', 'filed'],
      ['p2', 'company'],
    ])
  })
})
