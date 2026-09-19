import { describe, expect, it } from 'vitest'

import {
  FIRST_SETTINGS_SECTION,
  SETTINGS_CRUMBS,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  SETTINGS_SECTIONS,
  sectionLocked,
} from './settings-nav'

/**
 * SPA-26: the settings nav grammar, the sibling of `nav-grammar.test.ts`.
 * `SETTINGS_SECTIONS` is the one place a settings section is declared — the
 * nav draws it, `/settings` redirects to its first row, and eleven pending
 * slices (Providers, Routing, Usage, Integrations, Connections, Binding
 * health, embeddings, install) each add one row. This file is what makes a
 * second section at one path, a stray group, or a row filed out of group
 * order a failing test instead of a nav that quietly draws it twice.
 */

/** Where a row sits in the group order, by its `group` field. */
const rank = (group: (typeof SETTINGS_SECTIONS)[number]['group']) =>
  SETTINGS_GROUP_IDS.indexOf(group)

describe('the settings nav grammar', () => {
  it('gives each section exactly one path under the shell', () => {
    const owner = new Map<string, string>()
    const collisions: Array<string> = []
    for (const row of SETTINGS_SECTIONS) {
      const taken = owner.get(row.to)
      if (taken === undefined) owner.set(row.to, row.label)
      // The message is the point: a new section that reuses
      // `/settings/objects` fails naming both, so the author knows.
      else collisions.push(`${row.to} — ${taken} and ${row.label}`)
    }
    expect(collisions).toEqual([])
    for (const row of SETTINGS_SECTIONS) {
      // A section is a child route of the shell; anything else escapes the
      // nav and the crumb with it.
      expect(`${row.label}: ${row.to}`).toMatch(/^.+: \/settings\/[a-z-]+$/)
    }
  })

  it('puts every row in one of the three known groups', () => {
    expect(SETTINGS_GROUP_IDS).toEqual(['workspace', 'objects', 'capital'])
    expect(Object.keys(SETTINGS_GROUPS)).toEqual([...SETTINGS_GROUP_IDS])
    // Every group also prints a crumb — a fourth id would print nothing.
    expect(Object.keys(SETTINGS_CRUMBS)).toEqual([...SETTINGS_GROUP_IDS])
    const strays = SETTINGS_SECTIONS.filter(
      (row) => !SETTINGS_GROUP_IDS.some((id) => id === row.group),
    )
    expect(strays.map((row) => `${row.label} — ${row.group}`)).toEqual([])
  })

  it('keeps the groups contiguous and in the order workspace → objects → capital', () => {
    // The groups are derived by filter, so a row filed out of its run would
    // still render — just under a rule that no longer means anything. Hold
    // the order and the derivation renders the array as written.
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
  })

  it('draws every row once, in SETTINGS_SECTIONS order', () => {
    for (const id of SETTINGS_GROUP_IDS) {
      const positions = SETTINGS_GROUPS[id].map((row) =>
        SETTINGS_SECTIONS.indexOf(row),
      )
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
    expect([
      ...SETTINGS_GROUPS.workspace,
      ...SETTINGS_GROUPS.objects,
      ...SETTINGS_GROUPS.capital,
    ]).toEqual([...SETTINGS_SECTIONS])
  })

  it('redirects /settings to the first row rather than to a literal path', () => {
    expect(FIRST_SETTINGS_SECTION).toBe(SETTINGS_SECTIONS[0])
    expect(FIRST_SETTINGS_SECTION.to).toBe('/settings/workspace')
  })

  it('locks a row for a member only when the section is admin-only', () => {
    for (const row of SETTINGS_SECTIONS) {
      // An admin is never shown a locked row.
      expect(sectionLocked(row, true)).toBe(false)
      expect(sectionLocked(row, false)).toBe(row.admin)
    }
    // None of the five sections moved by SPA-26 is admin-only at the route:
    // every one of them a member can read today, and the move changed no
    // guard. The lane exists for the pending admin-only sections (storage-1's
    // OAuth, ai-3a's providers), which declare `admin: true` and get the
    // graphite row with `admin` in the right lane instead of a dead link.
    const lockedForAMember = SETTINGS_SECTIONS.filter((row) =>
      sectionLocked(row, false),
    )
    expect(lockedForAMember.map((row) => row.label)).toEqual([])
  })
})
