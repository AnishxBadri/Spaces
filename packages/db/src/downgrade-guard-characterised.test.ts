import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readImageJournal } from './downgrade-guard'

/**
 * What the image journal reader takes from `meta/_journal.json` and what it
 * refuses before boot goes on. Every row was held against the zod shape
 * before it was an Effect schema: a journal it refused must stay refused, or
 * an image would boot on a journal it cannot read.
 */

const REFUSED = 'REFUSED'
const SQL = 'select 1;'
const HASH = createHash('sha256').update(SQL).digest('hex')
const WHEN = 1_760_000_000_000

/** A migrations folder holding `0000_a.sql` and this journal, read. */
const readWith = (journal: unknown): unknown => {
  const folder = mkdtempSync(path.join(tmpdir(), 'journal-'))
  mkdirSync(path.join(folder, 'meta'))
  writeFileSync(path.join(folder, '0000_a.sql'), SQL)
  writeFileSync(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify(journal),
  )
  try {
    return readImageJournal(folder)
  } catch {
    return REFUSED
  }
}

const entry = {
  idx: 0,
  version: '7',
  when: WHEN,
  tag: '0000_a',
  breakpoints: true,
}
const read = [{ tag: '0000_a', when: WHEN, hash: HASH }]

type Row = readonly [label: string, journal: unknown, out: unknown]

const rows: ReadonlyArray<Row> = [
  [
    'one entry',
    { version: '7', dialect: 'postgresql', entries: [entry] },
    read,
  ],
  ['no entries', { entries: [] }, []],
  [
    'a fractional when',
    { entries: [{ ...entry, when: 1.5 }] },
    [{ tag: '0000_a', when: 1.5, hash: HASH }],
  ],
  [
    'a negative when',
    { entries: [{ ...entry, when: -1 }] },
    [{ tag: '0000_a', when: -1, hash: HASH }],
  ],
  ['only when and tag', { entries: [{ when: WHEN, tag: '0000_a' }] }, read],
  ['a when as text', { entries: [{ ...entry, when: String(WHEN) }] }, REFUSED],
  ['a null when', { entries: [{ ...entry, when: null }] }, REFUSED],
  ['no when', { entries: [{ ...entry, when: undefined }] }, REFUSED],
  ['a numeric tag', { entries: [{ ...entry, tag: 0 }] }, REFUSED],
  ['no tag', { entries: [{ ...entry, tag: undefined }] }, REFUSED],
  ['an entry that is a string', { entries: ['0000_a'] }, REFUSED],
  ['an entry that is null', { entries: [null] }, REFUSED],
  ['entries as an object', { entries: { 0: entry } }, REFUSED],
  ['no entries key', { version: '7' }, REFUSED],
  ['a list', [entry], REFUSED],
  ['null', null, REFUSED],
]

describe('readImageJournal', () => {
  it.each(rows)('%s', (_, journal, out) => {
    expect(readWith(journal)).toEqual(out)
  })
})
