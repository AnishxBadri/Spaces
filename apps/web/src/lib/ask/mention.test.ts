import { describe, expect, it } from 'vitest'
import { chipOfHit, insertMention, mentionAt } from './mention'
import { SCOPE_MAX, chipKey, dockScope, withMention } from './page-scope'
import type { AskScopeChip } from './types'

describe('@ in the composer', () => {
  it('finds the mention the caret is in', () => {
    expect(mentionAt('@Hyd', 4)).toEqual({ start: 0, query: 'Hyd' })
    expect(mentionAt('what about @Green Hy', 20)).toEqual({
      start: 11,
      query: 'Green Hy',
    })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    // An address is not a mention, nor is a finished line.
    expect(mentionAt('mail a@b.co', 11)).toBeNull()
    expect(mentionAt('@Hyd\nnext', 9)).toBeNull()
    expect(mentionAt('@ space', 7)).toBeNull()
  })

  it('puts the name where the mention was typed', () => {
    const at = { start: 0, query: 'Hyd' }
    expect(insertMention('@Hyd what do we believe', at, 'Hydrogen')).toEqual({
      text: 'Hydrogen what do we believe',
      caret: 8,
    })
    expect(insertMention('@Hyd', at, 'Hydrogen')).toEqual({
      text: 'Hydrogen ',
      caret: 9,
    })
  })

  it('offers spaces and records, as their chips', () => {
    const hit = {
      id: 'id1',
      name: 'Hydrogen',
      objectSlug: null,
      rowKind: 'entity' as const,
    }
    expect(chipOfHit({ ...hit, kind: 'space' })).toEqual({
      kind: 'space',
      id: 'id1',
      name: 'Hydrogen',
      href: '/spaces/id1',
    })
    expect(chipOfHit({ ...hit, kind: 'company' })?.kind).toBe('record')
    expect(chipOfHit({ ...hit, kind: 'person' })?.href).toBe('/people/id1')
    expect(chipOfHit({ ...hit, kind: 'note' })).toBeNull()
    expect(chipOfHit({ ...hit, kind: 'company', rowKind: 'task' })).toBeNull()
  })
})

describe('the dock’s chips', () => {
  const page: AskScopeChip = {
    kind: 'record',
    id: 'p',
    name: 'Acme',
    href: '/companies/p',
  }
  const space: AskScopeChip = {
    kind: 'space',
    id: 's',
    name: 'Hydrogen',
    href: '/spaces/s',
  }

  it('starts with the page, adds mentions once, and drops the page when removed', () => {
    expect(dockScope(page, null, [])).toEqual([page])
    expect(dockScope(page, null, [space, page])).toEqual([page, space])
    expect(dockScope(page, chipKey(page), [space])).toEqual([space])
    // Removed on one page, another page's chip shows.
    expect(dockScope(page, 'record:other', [])).toEqual([page])
    // On Today there is no default chip: the whole workspace.
    expect(dockScope(null, null, [])).toEqual([])
  })

  it('adds an @ pick last, once, the oldest giving way when full', () => {
    const chip = (id: string): AskScopeChip => ({
      kind: 'record',
      id,
      name: id,
      href: null,
    })
    const full = ['a', 'b', 'c', 'd'].map(chip)
    expect(full).toHaveLength(SCOPE_MAX)
    expect(withMention(full, chip('e')).map((c) => c.id)).toEqual([
      'b',
      'c',
      'd',
      'e',
    ])
    expect(withMention(full, chip('b')).map((c) => c.id)).toEqual([
      'a',
      'c',
      'd',
      'b',
    ])
    expect(withMention([page], space, SCOPE_MAX - 1)).toEqual([page, space])
  })
})
