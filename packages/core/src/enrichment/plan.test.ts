import { describe, expect, it } from 'vitest'
import type { AttributeDef } from '../attributes/registry'
import { decide, enrichedLine, linksOf, wantedKeys, written } from './plan'
import type { Holding, SourceAnswer } from './plan'
import { enrichmentSettingsOf, orderSources, scopeFor } from './settings'

const def = (
  slug: string,
  type: AttributeDef['type'],
  enrichmentKey: string | null,
): AttributeDef => ({
  id: slug,
  objectId: 'companies',
  slug,
  name: slug,
  type,
  options: { enrichmentKey },
  isSystem: false,
  archived: false,
  sortOrder: 0,
})

const links = linksOf([
  def('description', 'text', 'company.description'),
  def('employees', 'number', 'company.headcount'),
  def('tags', 'text', 'company.keywords'),
  def('notes', 'text', null),
])

const held = (
  value: Holding['value'],
  type: 'user' | 'integration',
  at = '2026-01-01T00:00:00.000Z',
  integrationId: string | null = type === 'integration' ? 'apollo' : null,
): Holding => ({ value, writer: { type, integrationId }, at })

const answer = (
  integrationId: string,
  answers: SourceAnswer['answers'],
  asOf = '2026-06-01T00:00:00.000Z',
): SourceAnswer => ({
  integrationId,
  receiptId: `${integrationId}-receipt`,
  asOf,
  answers,
})

describe('linksOf', () => {
  it('takes the attributes carrying a vocabulary key, and no unlinked one', () => {
    expect(links.map((l) => l.key)).toEqual([
      'company.description',
      'company.headcount',
      'company.keywords',
    ])
  })
})

describe('wantedKeys', () => {
  it('asks for blanks and machine-held changing figures, never a cleared or a person-held value, nor what was answered', () => {
    const holdings = new Map<string, Holding>([
      ['description', held(null, 'user')],
      ['employees', held(100, 'integration')],
    ])
    expect(wantedKeys(links, holdings, new Set())).toEqual([
      'company.headcount',
      'company.keywords',
    ])
    expect(wantedKeys(links, holdings, new Set(['company.keywords']))).toEqual([
      'company.headcount',
    ])
    const personHeld = new Map([['employees', held(80, 'user')]])
    expect(wantedKeys(links, personHeld, new Set())).not.toContain(
      'company.headcount',
    )
  })
})

describe('decide', () => {
  it('lets the first source win and keeps the later answer as a loser', () => {
    const d = decide(links, new Map(), [
      answer('website', { 'company.description': 'From the site' }),
      answer('apollo', { 'company.description': 'From Apollo' }),
    ])
    expect(written(d).map((f) => [f.slug, f.value, f.integrationId])).toEqual([
      ['description', 'From the site', 'website'],
    ])
    expect(d.losers).toEqual([
      expect.objectContaining({
        key: 'company.description',
        value: 'From Apollo',
      }),
    ])
  })

  it('joins a list for a text attribute and keeps an unlinked key aside', () => {
    const d = decide(links, new Map(), [
      answer('apollo', {
        'company.keywords': ['robots', 'warehouses'],
        'company.industry': 'Robotics',
      }),
    ])
    expect(written(d).at(0)?.value).toBe('robots, warehouses')
    expect(d.unlinked.map((u) => u.key)).toEqual(['company.industry'])
  })

  it('never writes over a person; another source stands unless an older changing figure', () => {
    const holdings = new Map<string, Holding>([
      ['description', held('Ours', 'user')],
      ['employees', held(100, 'integration')],
      ['tags', held('a, b', 'integration')],
    ])
    const d = decide(links, holdings, [
      answer('website', {
        'company.description': 'Theirs',
        'company.headcount': 150,
        'company.keywords': ['c'],
      }),
    ])
    expect(d.fields.map((f) => [f.slug, f.outcome])).toEqual([
      ['description', 'person'],
      ['employees', 'replaced'],
      ['tags', 'kept'],
    ])
    expect(d.fields[1]?.previous).toEqual({
      value: 100,
      at: '2026-01-01T00:00:00.000Z',
      integrationId: 'apollo',
    })
    const older = decide(links, holdings, [
      answer(
        'website',
        { 'company.headcount': 150 },
        '2025-01-01T00:00:00.000Z',
      ),
    ])
    expect(older.fields[0]?.outcome).toBe('kept')
  })

  it('leaves a value a person cleared, and calls an unchanged one the same', () => {
    const holdings = new Map<string, Holding>([
      ['description', held(null, 'user')],
      ['employees', held(100, 'integration')],
    ])
    const d = decide(links, holdings, [
      answer('apollo', {
        'company.description': 'Back again',
        'company.headcount': 100,
      }),
    ])
    expect(d.fields.map((f) => f.outcome)).toEqual(['cleared', 'same'])
    expect(written(d)).toEqual([])
  })
})

describe('enrichedLine', () => {
  it('names the sources, the fields and the credits, and leaves out a free run’s', () => {
    expect(
      enrichedLine({ sources: ['Website', 'Apollo'], fields: 6, credits: 1 }),
    ).toBe('Enriched · Website, Apollo · 6 fields · 1 credit')
    expect(enrichedLine({ sources: ['Website'], fields: 1, credits: 0 })).toBe(
      'Enriched · Website · 1 field',
    )
  })
})

describe('enrichment settings', () => {
  const a = '00000000-0000-4000-8000-00000000000a'
  const b = '00000000-0000-4000-8000-00000000000b'

  it('reads the order, the reuse window and the scopes, and falls back to the row', () => {
    const settings = enrichmentSettingsOf({
      enrichment: {
        sources: [b, a],
        reuseDays: 30,
        scopes: { [a]: { scopes: ['space'], spaces: [] } },
      },
    })
    expect(settings.sources).toEqual([b, a])
    expect(settings.reuseDays).toBe(30)
    expect(
      scopeFor(settings, a, { autoEnrichScopes: ['deal'] }).scopes,
    ).toEqual(['space'])
    expect(
      scopeFor(settings, b, { autoEnrichScopes: ['deal'] }).scopes,
    ).toEqual(['deal'])
    expect(orderSources(settings, [{ id: a }, { id: b }, { id: 'c' }])).toEqual(
      [{ id: b }, { id: a }],
    )
  })

  it('reads nothing set as unset, and a malformed part as unset', () => {
    const none = enrichmentSettingsOf({})
    expect(none).toEqual({ sources: null, reuseDays: null, scopes: new Map() })
    expect(orderSources(none, [{ id: a }])).toEqual([{ id: a }])
    expect(
      enrichmentSettingsOf({ enrichment: { sources: 'x', reuseDays: -1 } }),
    ).toMatchObject({ sources: null, reuseDays: null })
  })
})
