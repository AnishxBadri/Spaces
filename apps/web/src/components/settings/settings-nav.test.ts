import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  SETTINGS_CRUMBS,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  SETTINGS_LANDING,
  SETTINGS_SECTIONS,
  sectionAt,
} from './settings-nav'

/**
 * The settings nav grammar, the sibling of `nav-grammar.test.ts`.
 * `SETTINGS_SECTIONS` is the one place a settings section is declared; this
 * file makes a second section at one path, a stray group, a row filed out of
 * group order, or an eyebrow naming another group a failing test.
 */

/** D81's map as shipped: group crumb, then each row as label → path. */
const MAP: ReadonlyArray<
  readonly [crumb: string, rows: ReadonlyArray<readonly [string, string]>]
> = [
  [
    'You',
    [
      ['Email & calendar', '/settings/email-calendar'],
      ['Files', '/settings/files'],
      ['Meeting notes', '/settings/meeting-notes'],
      ['API tokens', '/settings/tokens'],
    ],
  ],
  [
    'Workspace',
    [
      ['General', '/settings/general'],
      ['Members', '/settings/members'],
      ['Objects', '/settings/objects'],
      ['Templates', '/settings/templates'],
      ['Currency & FX', '/settings/currency'],
    ],
  ],
  [
    'AI',
    [
      ['Models', '/settings/models'],
      ['Search', '/settings/search'],
      ['Usage & limits', '/settings/usage'],
    ],
  ],
  [
    'Integrations',
    [
      ['Plugins', '/settings/plugins'],
      ['Email forwarding', '/settings/email-forwarding'],
      ['Connection apps', '/settings/connection-apps'],
    ],
  ],
]

/** Where a row sits in the group order, by its `group` field. */
const rank = (group: (typeof SETTINGS_SECTIONS)[number]['group']) =>
  SETTINGS_GROUP_IDS.indexOf(group)

const webSrc = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string) => readFileSync(`${webSrc}${path}`, 'utf8')

/**
 * Every eyebrow a section's route prints: the `crumb="…"` literals in its
 * file, its drill-in page's, and the settings components either imports.
 */
function crumbsPrintedBy(to: string): Array<string> {
  const slug = to.replace('/settings/', '')
  const routes = [
    `routes/_app/settings/${slug}.tsx`,
    ...['$integrationId', '$objectSlug', '$connectionId']
      .map((p) => `routes/_app/settings/${slug}_.${p}.tsx`)
      .filter((f) => existsSync(`${webSrc}${f}`)),
  ]
  const sources = routes.map(read)
  for (const source of [...sources]) {
    for (const m of source.matchAll(
      /from '#\/components\/settings\/([a-z-]+)'/g,
    )) {
      if (m[1] !== 'settings-section' && m[1] !== 'settings-nav')
        sources.push(read(`components/settings/${m[1]}.tsx`))
    }
  }
  return sources.flatMap((s) =>
    [...s.matchAll(/crumb="([^"]+)"/g)].map((m) => m[1]),
  )
}

describe('the settings nav grammar', () => {
  it('holds four groups in D81 order, You · Workspace · AI · Integrations', () => {
    expect(SETTINGS_GROUP_IDS).toEqual([
      'you',
      'workspace',
      'ai',
      'integrations',
    ])
    expect(Object.keys(SETTINGS_GROUPS)).toEqual([...SETTINGS_GROUP_IDS])
    expect(SETTINGS_GROUP_IDS.map((id) => SETTINGS_CRUMBS[id])).toEqual(
      MAP.map(([crumb]) => crumb),
    )
  })

  it('gives every row of the map exactly one path, in map order', () => {
    expect(
      SETTINGS_GROUP_IDS.map((id) => [
        SETTINGS_CRUMBS[id],
        SETTINGS_GROUPS[id].map((row) => [row.label, row.to]),
      ]),
    ).toEqual(MAP)
  })

  it('gives each section exactly one path under the shell', () => {
    const owner = new Map<string, string>()
    const collisions: Array<string> = []
    for (const row of SETTINGS_SECTIONS) {
      const taken = owner.get(row.to)
      if (taken === undefined) owner.set(row.to, row.label)
      // A new section that reuses a path fails naming both.
      else collisions.push(`${row.to} — ${taken} and ${row.label}`)
    }
    expect(collisions).toEqual([])
    for (const row of SETTINGS_SECTIONS) {
      expect(`${row.label}: ${row.to}`).toMatch(/^.+: \/settings\/[a-z-]+$/)
    }
  })

  it("prints its group's crumb as every row's eyebrow", () => {
    const wrong: Array<string> = []
    for (const row of SETTINGS_SECTIONS) {
      const printed = crumbsPrintedBy(row.to)
      expect(printed.length, `${row.label} prints no eyebrow`).toBeGreaterThan(
        0,
      )
      for (const crumb of printed)
        if (crumb !== SETTINGS_CRUMBS[row.group])
          wrong.push(`${row.label}: ${crumb}`)
    }
    expect(wrong).toEqual([])
  })

  it('keeps the groups contiguous and in order', () => {
    const misplaced: Array<string> = []
    let reached = 0
    for (const row of SETTINGS_SECTIONS) {
      if (rank(row.group) < reached) {
        misplaced.push(
          `${row.label} (${row.group}) sits after ${SETTINGS_GROUP_IDS[reached]}`,
        )
      } else reached = rank(row.group)
    }
    expect(misplaced).toEqual([])
    expect(
      SETTINGS_GROUP_IDS.flatMap((id) => [...SETTINGS_GROUPS[id]]),
    ).toEqual([...SETTINGS_SECTIONS])
  })

  it('lands /settings on General, a row of the map', () => {
    expect(SETTINGS_LANDING).toBe('/settings/general')
    expect(SETTINGS_SECTIONS.map((row) => row.to)).toContain(SETTINGS_LANDING)
  })

  it('finds the row a page belongs to, a drill-in page included', () => {
    expect(sectionAt('/settings/models')?.label).toBe('Models')
    expect(sectionAt('/settings/plugins/0b5cbe3e')?.label).toBe('Plugins')
    expect(sectionAt('/settings/objects/companies')?.label).toBe('Objects')
    expect(sectionAt('/settings/files/7a3c1b52')?.label).toBe('Files')
    expect(sectionAt('/settings/email-calendar/7a3c1b52')?.label).toBe(
      'Email & calendar',
    )
    // A prefix of another path is not that row.
    expect(sectionAt('/settings/pluginsx')).toBeUndefined()
    expect(sectionAt('/deals')).toBeUndefined()
  })

  it('marks exactly the admin-only pages a member reads disabled', () => {
    // Usage & limits is not one: the run log is every member's provenance,
    // and only its Caps section is the admin's.
    expect(
      SETTINGS_SECTIONS.filter((row) => row.admin).map((row) => row.label),
    ).toEqual([
      'Models',
      'Search',
      'Plugins',
      'Email forwarding',
      'Connection apps',
    ])
  })
})
