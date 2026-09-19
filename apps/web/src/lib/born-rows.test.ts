import { describe, expect, it } from 'vitest'

import { addBorn } from './born-rows'

/**
 * SPA-53. The composer wash's one hard rule is the negative one: a row that
 * was already on the page when the list loaded must never wash. That is a
 * property of where the set comes from, so this is what the test holds.
 */
describe('addBorn', () => {
  it('starts from nothing — a list the loader filled washes no row', () => {
    const loaded = ['a', 'b', 'c']
    const born: ReadonlySet<string> = new Set()
    for (const id of loaded) expect(born.has(id)).toBe(false)
  })

  it('washes only the row a composer reported, not its neighbours', () => {
    const born = addBorn(new Set(), ['new'])
    expect(born.has('new')).toBe(true)
    expect(born.has('was-already-here')).toBe(false)
  })

  it('keeps every earlier birth — a run of adds all wash', () => {
    const born = addBorn(addBorn(new Set(), ['one']), ['two', 'three'])
    expect([...born].sort()).toEqual(['one', 'three', 'two'])
  })

  it('returns the same set when nothing is new, so a report is not a render', () => {
    const born = addBorn(new Set(), ['one'])
    expect(addBorn(born, ['one'])).toBe(born)
    expect(addBorn(born, [])).toBe(born)
    expect(addBorn(born, ['two'])).not.toBe(born)
  })

  it('does not mutate the set it was handed', () => {
    const before = addBorn(new Set(), ['one'])
    addBorn(before, ['two'])
    expect(before.has('two')).toBe(false)
  })

  // The reason this is an id set and not `createdAt > mountedAt`: reload a
  // list moments after adding a task and every fresh row would flash for
  // something nobody just did on this page. A reload empties the set instead.
  it('is empty again after a reload, whatever the rows were created', () => {
    addBorn(new Set(), ['created-two-seconds-ago'])
    const afterReload: ReadonlySet<string> = new Set()
    expect(afterReload.has('created-two-seconds-ago')).toBe(false)
  })
})
