import { describe, expect, it } from 'vitest'
import { ROLES, manifestSchema } from '@spaces/sdk'
import type { Manifest } from '@spaces/sdk'
import {
  ROLE_LABEL,
  ROLE_ORDER,
  capabilitiesOf,
  catalogueTabs,
  durationOf,
  figureOf,
  inTab,
  jobOfQueue,
  roleWords,
  sendsOf,
} from './catalogue'

/**
 * The catalogue's pure half: Available's tabs by role, the ledger's one
 * number, and what the plugin page says a plugin sends and switches on.
 */

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  manifestSchema.parse({
    manifestVersion: 1,
    id: 'probe',
    version: '0.1.0',
    sdk: '^1.4',
    name: 'Probe',
    description: 'A probe.',
    settings: {},
    jobs: { run: { trigger: 'action', uses: ['Log'] } },
    ...over,
  })

describe('roles', () => {
  it('labels every SDK role, in the SDK order', () => {
    expect(ROLE_ORDER).toEqual(ROLES)
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...ROLES].sort())
    expect(roleWords(['research', 'enrichment'])).toBe('Research · Enrichment')
  })
})

describe('catalogueTabs', () => {
  it('runs All, then each role some entry names with its count', () => {
    const plugins = [
      { roles: ['email-calendar', 'files'] as const },
      { roles: ['import'] as const },
      { roles: ['feeds'] as const },
    ]
    expect(catalogueTabs(plugins)).toEqual([
      { id: 'all', label: 'All', count: 3 },
      { id: 'email-calendar', label: 'Email & calendar', count: 1 },
      { id: 'files', label: 'Files', count: 1 },
      { id: 'import', label: 'Import', count: 1 },
      { id: 'feeds', label: 'Feeds', count: 1 },
    ])
  })

  it('adds Other only when an entry names no role', () => {
    expect(
      catalogueTabs([{ roles: ['feeds'] }]).map((t) => t.id),
    ).not.toContain('other')
    const withPlain = [{ roles: ['feeds'] as const }, { roles: [] }]
    expect(catalogueTabs(withPlain).at(-1)).toEqual({
      id: 'other',
      label: 'Other',
      count: 1,
    })
    expect(inTab({ roles: [] }, 'other')).toBe(true)
    expect(inTab({ roles: ['feeds'] }, 'other')).toBe(false)
    expect(inTab({ roles: ['feeds'] }, 'feeds')).toBe(true)
    expect(inTab({ roles: [] }, 'all')).toBe(true)
  })
})

describe('figureOf', () => {
  const none = {
    requires: undefined,
    credits: { used: 0, cap: null },
    signals: 0,
    people: 0,
  }
  it('counts credits for an enrichment source, signals for a feed or researcher, people for an account', () => {
    expect(
      figureOf({
        ...none,
        roles: ['enrichment'],
        credits: { used: 12, cap: 100 },
      }),
    ).toBe('12 / 100 credits')
    expect(
      figureOf({ ...none, roles: ['research', 'enrichment'], signals: 5 }),
    ).toBe('5 signals')
    expect(figureOf({ ...none, roles: ['feeds'], signals: 1 })).toBe('1 signal')
    expect(figureOf({ ...none, roles: ['files'], people: 1 })).toBe('1 person')
    expect(
      figureOf({ ...none, roles: ['email-calendar', 'files'], people: 3 }),
    ).toBe('3 people')
  })

  it('falls back on what the manifest asks for, else a dash', () => {
    expect(
      figureOf({
        ...none,
        roles: [],
        requires: {
          connection: { provider: 'google', scopes: ['drive.file'] },
        },
        people: 2,
      }),
    ).toBe('2 people')
    expect(
      figureOf({
        ...none,
        roles: [],
        requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
        credits: { used: 3, cap: null },
      }),
    ).toBe('3 credits')
    expect(figureOf({ ...none, roles: ['import'] })).toBe('—')
  })
})

describe('sendsOf', () => {
  it('names the lookup keys an enrichment source is handed, by the records it acts on', () => {
    const enrichment = {
      requires: {
        credential: {
          kind: 'enrichment' as const,
          scope: 'workspace' as const,
        },
      },
      jobs: {
        enrichCompany: { trigger: 'action' as const, uses: ['Facts' as const] },
      },
    }
    expect(
      sendsOf(
        manifest({
          ...enrichment,
          actions: [
            { id: 'e', label: 'Enrich', on: 'company', job: 'enrichCompany' },
          ],
        }),
      ),
    ).toEqual(['domain'])
    expect(sendsOf(manifest(enrichment))).toEqual([
      'domain',
      'email',
      'LinkedIn URL',
    ])
  })

  it('says a connection sends nothing out, and a plugin with no Http nothing at all', () => {
    expect(
      sendsOf(
        manifest({
          requires: {
            connection: { provider: 'google', scopes: ['drive.file'] },
          },
        }),
      ),
    ).toEqual(['nothing out · reads drive.file'])
    expect(sendsOf(manifest())).toEqual(['nothing out'])
    expect(
      sendsOf(
        manifest({ jobs: { poll: { trigger: 'action', uses: ['Http'] } } }),
      ),
    ).toEqual(['only the addresses its settings name'])
    expect(sendsOf(null)).toEqual([])
  })
})

describe('capabilitiesOf', () => {
  it('names one owned capability per role, and none without roles', () => {
    expect(
      capabilitiesOf(
        manifest({
          roles: ['enrichment'],
          jobs: { enrichCompany: { trigger: 'action', uses: ['Facts'] } },
          actions: [
            { id: 'e', label: 'Enrich', on: 'company', job: 'enrichCompany' },
          ],
        }),
      ),
    ).toEqual([{ what: 'Fills company fields', owner: 'enrichment' }])
    expect(
      capabilitiesOf(manifest({ roles: ['import', 'feeds'] })).map(
        (c) => c.owner,
      ),
    ).toEqual(['import', 'watching'])
    expect(capabilitiesOf(manifest())).toEqual([])
  })
})

describe('run lines', () => {
  it('reads the job from the queue and the duration in words', () => {
    expect(jobOfQueue('plugin.apollo.enrichCompany')).toBe('enrichCompany')
    expect(durationOf(340)).toBe('340ms')
    expect(durationOf(1250)).toBe('1.3s')
    expect(durationOf(184_000)).toBe('3m 4s')
    expect(durationOf(null)).toBeNull()
  })
})
