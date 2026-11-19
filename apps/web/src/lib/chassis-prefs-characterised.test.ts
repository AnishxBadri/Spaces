import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setGroupFolded,
  toggleStarredSpace,
  togglePinnedView,
} from './chassis-prefs'

/**
 * What the chassis reads back from each stored string, seen through the
 * writers: a write appends to what was decoded, so the string it leaves
 * shows what the stored one read as. A refused string reads as empty. Every
 * row was held against the zod codecs before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const NEW = '5f2b0c1e-8d3a-4b7c-9e6f-1a2b3c4d5e6f'
const MAX_UPPER = 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The stored string `write` leaves under `key` after `stored` was there. */
function after(key: string, stored: string | null, write: () => void) {
  if (stored !== null) store.set(key, stored)
  write()
  return store.get(key)
}

describe('folded groups', () => {
  const ROWS: ReadonlyArray<readonly [string | null, string]> = [
    [null, '["capital"]'],
    ['["library"]', '["library","capital"]'],
    ['["library","objects","capital"]', '["library","objects","capital"]'],
    ['["library","bogus"]', '["capital"]'],
    ['["bogus"]', '["capital"]'],
    ['"library"', '["capital"]'],
    ['[1]', '["capital"]'],
    ['[]', '["capital"]'],
    ['{}', '["capital"]'],
    ['not json', '["capital"]'],
  ]
  it.each(ROWS)('%s', (stored, written) => {
    expect(
      after('chassis:folded', stored, () => setGroupFolded('capital', true)),
    ).toBe(written)
  })
})

describe('starred spaces', () => {
  const STAR = '{"id":"s9","name":"New"}'
  const ROWS: ReadonlyArray<readonly [string | null, string]> = [
    [null, `[${STAR}]`],
    ['[{"id":"s1","name":"Seed"}]', `[{"id":"s1","name":"Seed"},${STAR}]`],
    [
      '[{"id":"s1","name":"Seed","stray":1}]',
      `[{"id":"s1","name":"Seed"},${STAR}]`,
    ],
    ['[{"id":"s1"}]', `[${STAR}]`],
    ['[{"id":1,"name":"x"}]', `[${STAR}]`],
    ['[null]', `[${STAR}]`],
    ['null', `[${STAR}]`],
    ['{"id":"s1","name":"Seed"}', `[${STAR}]`],
    ['[]', `[${STAR}]`],
  ]
  it.each(ROWS)('%s', (stored, written) => {
    expect(
      after('chassis:starred-spaces', stored, () =>
        toggleStarredSpace({ id: 's9', name: 'New' }),
      ),
    ).toBe(written)
  })
})

describe('pinned views', () => {
  const ROWS: ReadonlyArray<readonly [string | null, string]> = [
    [null, `["${NEW}"]`],
    [`["${ID}"]`, `["${ID}","${NEW}"]`],
    [`["${ID.toUpperCase()}"]`, `["${ID.toUpperCase()}","${NEW}"]`],
    [`["${MAX_UPPER}"]`, `["${NEW}"]`],
    [`["${ID}","nope"]`, `["${NEW}"]`],
    ['[5]', `["${NEW}"]`],
    ['[]', `["${NEW}"]`],
    [`"${ID}"`, `["${NEW}"]`],
  ]
  it.each(ROWS)('%s', (stored, written) => {
    expect(
      after('chassis:pinned-views', stored, () => togglePinnedView(NEW)),
    ).toBe(written)
  })
})
