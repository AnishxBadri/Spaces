import { describe, expect, it } from 'vitest'
import {
  composeSearch,
  modalSearch,
  openComposeOf,
  openModalId,
} from './modal-search'
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

describe('a new email’s window', () => {
  const TEMPLATE = '00000000-0000-4000-8000-0000000000e1'

  it('reads ?modal=email&new=1 with the draft’s id and a template', () => {
    const search = recordSearch.parse({
      modal: 'email',
      new: 1,
      draft: ID,
      template: TEMPLATE,
    })
    expect(openComposeOf(search)).toEqual({
      draftId: ID,
      templateId: TEMPLATE,
    })
    // It is not the thread window, and it opens over Interactions.
    expect(openModalId(search, 'email')).toBeNull()
    expect(linkedRecordTab(search)).toBe('interactions')
  })

  it('reads a URL with no id yet as a draft to mint, and anything else as none', () => {
    expect(
      openComposeOf(modalSearch.parse({ modal: 'email', new: 1 })),
    ).toEqual({ draftId: null, templateId: null })
    expect(openComposeOf(modalSearch.parse({ modal: 'email', new: 2 }))).toBe(
      null,
    )
    expect(openComposeOf(modalSearch.parse({ modal: 'note', new: 1 }))).toBe(
      null,
    )
    expect(
      modalSearch.parse({ modal: 'email', new: 1, draft: 'nope' }),
    ).toEqual({ modal: 'email', new: 1 })
  })

  it('mints a fresh id for each new email', () => {
    const a = composeSearch()
    const b = composeSearch(TEMPLATE)
    expect(a).toEqual({ modal: 'email', new: 1, draft: expect.any(String) })
    expect(b).toEqual({
      modal: 'email',
      new: 1,
      draft: expect.any(String),
      template: TEMPLATE,
    })
    expect(a.draft).not.toBe(b.draft)
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
