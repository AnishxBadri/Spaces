import { describe, expect, it } from 'vitest'

import { NAV_GROUPS, NAV_GROUP_IDS, NAV_ITEMS } from './app-sidebar'

/**
 * SPA-32: the nav grammar. `NAV_ITEMS` is the one place a page is declared —
 * the sidebar, the G-chord binding in `routes/_app.tsx`, the keyboard sheet
 * and the ⌘K palette all read this array and nothing else. Two pending
 * slices add a row each (Documents, /inbox), and both were drafted to pick a
 * free chord by hand; this file is what makes that a failing test instead of
 * a silent double binding. Documents landed 2026-09-22 (SPA-82) on `G L` in
 * the work group, and the label snapshot below is what keeps the row that
 * added it from moving any other row's lane.
 */

/** Where a row sits in the group order, by its `group` field. */
const rank = (group: (typeof NAV_ITEMS)[number]['group']) =>
  NAV_GROUP_IDS.indexOf(group)

describe('the nav grammar', () => {
  it('binds each G-chord to exactly one page', () => {
    const owner = new Map<string, string>()
    const collisions: Array<string> = []
    for (const item of NAV_ITEMS) {
      const taken = owner.get(item.key)
      if (taken === undefined) owner.set(item.key, item.label)
      // The message is the point: a new row that reuses `G D` fails naming
      // both pages, so the author knows which letter is already spent.
      else collisions.push(`${item.key} — ${taken} and ${item.label}`)
    }
    expect(collisions).toEqual([])
  })

  it('spells every chord as G plus one letter', () => {
    for (const item of NAV_ITEMS) {
      // `G ,` (Settings) is bound by the shell, not by a row, and a
      // two-letter chord would not survive the 800ms chord window. This is
      // also what keeps a row from claiming the comma and double-binding it.
      expect(`${item.label}: ${item.key}`).toMatch(/^.+: G [A-Z]$/)
    }
  })

  it('puts every row in one of the three known groups', () => {
    expect(NAV_GROUP_IDS).toEqual(['work', 'objects', 'capital'])
    // Every declared group is also rendered: a fourth id with no entry in
    // NAV_GROUPS would put its rows nowhere on the chassis.
    expect(Object.keys(NAV_GROUPS)).toEqual([...NAV_GROUP_IDS])
    const strays = NAV_ITEMS.filter(
      (item) => !NAV_GROUP_IDS.some((id) => id === item.group),
    )
    expect(strays.map((item) => `${item.label} — ${item.group}`)).toEqual([])
  })

  it('keeps the groups contiguous and in the order work → objects → capital', () => {
    // This is the invariant the old `slice(0, 4)` / `slice(4, 7)` / `slice(7)`
    // assumed without checking. Hold it and derivation-by-filter renders
    // exactly what the slices rendered, for any array that respects the
    // grammar — so a new row is one row and no other edit.
    const misplaced: Array<string> = []
    let reached = 0
    for (const item of NAV_ITEMS) {
      if (rank(item.group) < reached) {
        misplaced.push(
          `${item.label} (${item.group}) sits after ${NAV_GROUP_IDS[reached]}`,
        )
      } else reached = rank(item.group)
    }
    expect(misplaced).toEqual([])
  })

  it('puts Documents last in the work group on G L', () => {
    // SPA-82. The shelf is research material like Notes and Spaces — not a
    // core object, not capital — so it joins the work as the last row after
    // Notes; `G D` is Deals, which is why the letter is L (library).
    const documents = NAV_ITEMS.find((item) => item.to === '/documents')
    expect(documents?.key).toBe('G L')
    expect(documents?.group).toBe('work')
    expect(NAV_GROUPS.work.at(-1)).toBe(documents)
  })

  it('keeps every row in the lane it shipped in', () => {
    // The criterion SPA-82 asked to assert rather than eyeball: adding a row
    // must not move Companies, People, Deals or anyone else. A snapshot of
    // the labels per group is the cheapest way to say so, and it fails
    // naming the group that changed.
    expect({
      work: NAV_GROUPS.work.map((item) => item.label),
      objects: NAV_GROUPS.objects.map((item) => item.label),
      capital: NAV_GROUPS.capital.map((item) => item.label),
    }).toEqual({
      work: ['Today', 'Tasks', 'Spaces', 'Notes', 'Documents'],
      objects: ['Companies', 'People', 'Deals'],
      capital: ['Portfolio', 'Mandate'],
    })
  })

  it('draws every row once, in NAV_ITEMS order', () => {
    // ⌘K's "Go to" list and the keyboard sheet's Go column read NAV_ITEMS
    // straight through, so each group must keep that order and the three
    // together must be the whole array — no row dropped, none drawn twice.
    for (const id of NAV_GROUP_IDS) {
      const positions = NAV_GROUPS[id].map((item) => NAV_ITEMS.indexOf(item))
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
    expect([
      ...NAV_GROUPS.work,
      ...NAV_GROUPS.objects,
      ...NAV_GROUPS.capital,
    ]).toEqual([...NAV_ITEMS])
  })
})
