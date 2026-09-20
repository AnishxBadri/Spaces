import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  guessDocumentKind,
} from './index'

/**
 * `document_kind` lost `memo` (SPA-25, spec-storage-sources §11 delta 3): it
 * collided with `note.kind = 'memo'` while meaning something else. The
 * guesser used to read "memo" in a filename and file the document under a
 * kind the enum no longer has, so the load-bearing case is the one the issue
 * names — an investment memo PDF is `other`, and the edge to the note it was
 * exported from is what says it is a memo.
 *
 * The second half is the invariant behind that: the guesser is total. It
 * cannot return a string outside the list, whatever the filename, or the
 * insert fails at the database rather than at the call site.
 */
describe('guessDocumentKind', () => {
  it('files an exported memo as other — the kind is gone, the edge carries it', () => {
    expect(guessDocumentKind('Ohmium investment memo.pdf')).toBe('other')
  })

  it('does not read "memo" as a kind under any spelling', () => {
    for (const name of [
      'memo.pdf',
      'IC-memo-frostbyte.docx',
      'Q3 memo (final).pdf',
      'memorandum of understanding.pdf',
    ]) {
      expect(guessDocumentKind(name)).toBe('other')
    }
  })

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['Vayu Orbital seed deck.pdf', 'deck'],
    ['frostbyte-pitch-2026.pptx', 'deck'],
    ['Series A Deck v4.key', 'deck'],
    ['ohmium cap table.xlsx', 'cap_table'],
    ['captable-post-seed.csv', 'cap_table'],
    ['DD checklist.docx', 'dd'],
    ['technical diligence notes.md', 'dd'],
    ['data room index.pdf', 'dd'],
    ['SAFE - Frostbyte.pdf', 'legal'],
    ['term_sheet_signed.pdf', 'legal'],
    ['mutual NDA.pdf', 'legal'],
    ['subscription agreement.pdf', 'legal'],
    ['Ohmium investment memo.pdf', 'other'],
    ['photo-of-whiteboard.jpg', 'other'],
  ]

  it.each(CASES)('%s → %s', (filename, kind) => {
    expect(guessDocumentKind(filename)).toBe(kind)
  })

  it('a dozen real filenames each land on a member of DOCUMENT_KINDS', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12)
    for (const [filename] of CASES) {
      const guess = guessDocumentKind(filename)
      expect(DOCUMENT_KINDS).toContain(guess)
    }
  })
})

describe('DOCUMENT_KINDS', () => {
  it('is the six the enum carries, memo dropped', () => {
    expect([...DOCUMENT_KINDS]).toEqual([
      'deck',
      'dd',
      'cap_table',
      'legal',
      'article',
      'other',
    ])
  })

  it('labels exactly the six — no orphan label survives the drop', () => {
    expect(Object.keys(DOCUMENT_KIND_LABELS).sort()).toEqual(
      [...DOCUMENT_KINDS].sort(),
    )
  })
})
