import { describe, expect, it } from 'vitest'
import { linkReady, versionCandidates } from './newer-version'

/**
 * "Newer version of" at upload (D59): which files a new arrival may replace,
 * and the rule that the link waits for the committed row.
 */

const doc = (id: string, kind: 'deck' | 'legal', createdAt: string) => ({
  id,
  filename: `${id}.pdf`,
  kind,
  createdAt,
})

const ON_RECORD = [
  doc('v1', 'deck', '2026-08-01T10:00:00.000Z'),
  doc('spa', 'legal', '2026-09-01T10:00:00.000Z'),
  doc('v2', 'deck', '2026-09-15T10:00:00.000Z'),
]

describe('versionCandidates', () => {
  it('lists the record’s files of the same kind, newest first', () => {
    expect(versionCandidates(ON_RECORD, 'deck').map((d) => d.id)).toEqual([
      'v2',
      'v1',
    ])
  })

  it('offers nothing when the record holds no file of that kind', () => {
    expect(versionCandidates(ON_RECORD, 'legal').map((d) => d.id)).toEqual([
      'spa',
    ])
    expect(versionCandidates([], 'deck')).toEqual([])
    expect(
      versionCandidates(
        ON_RECORD.filter((d) => d.kind !== 'deck'),
        'deck',
      ),
    ).toEqual([])
  })

  it('never offers the arrival itself, as when its bytes were already here', () => {
    expect(versionCandidates(ON_RECORD, 'deck', 'v2').map((d) => d.id)).toEqual(
      ['v1'],
    )
  })
})

describe('linkReady', () => {
  it('waits for both the pick and the committed row', () => {
    expect(linkReady({ key: 'k', newerId: null, olderId: null })).toBe(false)
    // Picked while uploading: nothing is written until the row commits.
    expect(linkReady({ key: 'k', newerId: null, olderId: 'v2' })).toBe(false)
    // Committed with none picked: the default writes nothing.
    expect(linkReady({ key: 'k', newerId: 'v3', olderId: null })).toBe(false)
    expect(linkReady({ key: 'k', newerId: 'v3', olderId: 'v2' })).toBe(true)
  })

  it('never links a file to itself', () => {
    expect(linkReady({ key: 'k', newerId: 'v2', olderId: 'v2' })).toBe(false)
  })
})
