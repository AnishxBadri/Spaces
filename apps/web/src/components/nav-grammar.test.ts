import { describe, expect, it } from 'vitest'

import { NAV_GROUPS, NAV_GROUP_IDS, NAV_ITEMS } from './app-sidebar'

/**
 * The nav grammar. `NAV_ITEMS` is the one place a page is declared — the
 * sidebar, the G-chord binding in the shell, the keyboard sheet and the ⌘K
 * palette all read this array and nothing else.
 *
 * - A chord claimed twice fails naming both pages.
 * - The label snapshot keeps a new row from moving any other row's lane.
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

  it('puts every row in one of the four known groups', () => {
    expect(NAV_GROUP_IDS).toEqual(['work', 'library', 'objects', 'capital'])
    // Every declared group is also rendered: an id with no entry in
    // NAV_GROUPS would put its rows nowhere on the chassis.
    expect(Object.keys(NAV_GROUPS)).toEqual([...NAV_GROUP_IDS])
    const strays = NAV_ITEMS.filter(
      (item) => !NAV_GROUP_IDS.some((id) => id === item.group),
    )
    expect(strays.map((item) => `${item.label} — ${item.group}`)).toEqual([])
  })

  it('keeps the groups contiguous and in the order work → library → objects → capital', () => {
    // Hold it and derivation-by-filter draws the groups in array order, for
    // any array that respects the grammar — so a new row is one row and no
    // other edit.
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

  it('puts Files in the Library on G L, the chord Documents had', () => {
    // Files takes L (library), since `G D` is Deals; no row is left on
    // `/documents`.
    const files = NAV_ITEMS.find((item) => item.to === '/files')
    expect(files?.label).toBe('Files')
    expect(files?.key).toBe('G L')
    expect(files?.group).toBe('library')
    expect(NAV_ITEMS.some((item) => String(item.to) === '/documents')).toBe(
      false,
    )
  })

  it('holds Notes, Meetings and Files in the Library, between the work and the objects', () => {
    expect(
      NAV_GROUPS.library.map((item) => `${item.label} ${item.key}`),
    ).toEqual(['Notes G N', 'Meetings G E', 'Files G L'])
    // The chords kept clear: Mandate and Portfolio stand.
    const chord = (to: string) => NAV_ITEMS.find((item) => item.to === to)?.key
    expect(chord('/mandate')).toBe('G M')
    expect(chord('/portfolio')).toBe('G F')
  })

  it('keeps every row in the lane it shipped in', () => {
    // Adding a row must not move Companies, People, Deals or anyone else.
    // A snapshot of
    // the labels per group is the cheapest way to say so, and it fails
    // naming the group that changed.
    expect({
      work: NAV_GROUPS.work.map((item) => item.label),
      library: NAV_GROUPS.library.map((item) => item.label),
      objects: NAV_GROUPS.objects.map((item) => item.label),
      capital: NAV_GROUPS.capital.map((item) => item.label),
    }).toEqual({
      work: ['Today', 'Tasks', 'Spaces'],
      library: ['Notes', 'Meetings', 'Files'],
      objects: ['Companies', 'People', 'Deals'],
      capital: ['Portfolio', 'Mandate'],
    })
  })

  it('draws every row once, in NAV_ITEMS order', () => {
    // ⌘K's "Go to" list and the keyboard sheet's Go column read NAV_ITEMS
    // straight through, so each group must keep that order and the groups
    // together must be the whole array — no row dropped, none drawn twice.
    for (const id of NAV_GROUP_IDS) {
      const positions = NAV_GROUPS[id].map((item) => NAV_ITEMS.indexOf(item))
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
    const drawn: Array<(typeof NAV_ITEMS)[number]> = []
    for (const id of NAV_GROUP_IDS) drawn.push(...NAV_GROUPS[id])
    expect(drawn).toEqual([...NAV_ITEMS])
  })
})
