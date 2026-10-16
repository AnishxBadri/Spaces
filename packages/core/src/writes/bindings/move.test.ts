import { describe, expect, it } from 'vitest'
import type { StorageEntry } from '@spaces/sdk'
import { folderNamesUnder, isExport, renamedTo } from './move'
import type { MovableDocument } from './move'

/** The pure halves of a held file's move: the stored path and the name. */

const entry = (over: Partial<StorageEntry>): StorageEntry => ({
  id: 'f',
  name: 'deck.pdf',
  kind: 'file',
  mime: 'application/pdf',
  size: 10,
  modifiedAt: '2026-10-16T00:00:00.000Z',
  changeToken: '2',
  parentId: 'p',
  ...over,
})

const pdf: MovableDocument = {
  id: 'd',
  sourcePath: 'Room / Ohmium',
  filename: 'deck.pdf',
  mime: 'application/pdf',
}

const doc: MovableDocument = {
  id: 'm',
  sourcePath: 'Room',
  filename: 'Memo.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const native = entry({
  name: 'Memo',
  mime: 'application/vnd.google-apps.document',
  size: null,
})

describe('folderNamesUnder', () => {
  it('reads the folder names below the bound folder', () => {
    expect(folderNamesUnder('Room', 'Room')).toEqual([])
    expect(folderNamesUnder('Room', 'Room / Ohmium / Data room')).toEqual([
      'Ohmium',
      'Data room',
    ])
  })

  it('is null for a path outside the bound folder, or none', () => {
    expect(folderNamesUnder('Room', 'Roomy / Ohmium')).toBeNull()
    expect(folderNamesUnder('Room', null)).toBeNull()
  })
})

describe('renamedTo', () => {
  it('is the listed name for a stored file, null when it is the one held', () => {
    expect(renamedTo(pdf, entry({}))).toBeNull()
    expect(renamedTo(pdf, entry({ name: 'pitch.pdf' }))).toBe('pitch.pdf')
  })

  it('keeps an export’s extension: a native Doc is never renamed by its listing', () => {
    expect(isExport(doc, native)).toBe(true)
    expect(renamedTo(doc, native)).toBeNull()
    expect(renamedTo(doc, { ...native, name: 'Memo v2' })).toBe('Memo v2.docx')
  })

  it('a stored file whose name loses its extension is a rename, not an export', () => {
    expect(isExport(pdf, entry({ name: 'deck' }))).toBe(false)
    expect(renamedTo(pdf, entry({ name: 'deck' }))).toBe('deck')
  })
})
