import { describe, expect, it } from 'vitest'
import { modalSearch, openModalId } from './modal-search'
import { linkedRecordTab, recordSearch } from './records/record-tabs'

/**
 * The window a page opens from its URL: `?modal=` names it and `?id=` its
 * row, and a record keeps the tab it was opened over.
 */

const ID = '00000000-0000-4000-8000-000000000001'

describe('modalSearch', () => {
  it('reads a meeting, an email and a note window', () => {
    for (const modal of ['meeting', 'email', 'note'] as const) {
      const search = modalSearch.parse({ modal, id: ID })
      expect(search).toEqual({ modal, id: ID })
      expect(openModalId(search, modal)).toBe(ID)
    }
  })

  it('reads anything else as no window', () => {
    expect(modalSearch.parse({ modal: 'task', id: ID })).toEqual({ id: ID })
    expect(modalSearch.parse({ modal: 'note', id: 'nope' })).toEqual({
      modal: 'note',
    })
    expect(openModalId({ modal: 'note' }, 'note')).toBeNull()
    expect(openModalId({ modal: 'email', id: ID }, 'note')).toBeNull()
  })
})

describe('a record’s window', () => {
  it('keeps the tab it was opened over', () => {
    const search = recordSearch.parse({
      tab: 'overview',
      modal: 'note',
      id: ID,
    })
    expect(linkedRecordTab(search)).toBe('overview')
  })

  it('opens a note’s window over Notes, any other over Interactions, with no tab named', () => {
    expect(linkedRecordTab({ modal: 'note' })).toBe('notes')
    expect(linkedRecordTab({ modal: 'email' })).toBe('interactions')
    expect(linkedRecordTab({ modal: 'meeting' })).toBe('interactions')
    expect(linkedRecordTab({})).toBeUndefined()
  })
})
