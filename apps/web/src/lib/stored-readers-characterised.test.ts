import { describe, expect, it } from 'vitest'
import { pendingFolderLinkOf } from './documents/pending-folder-link'
import { listViewOf } from './route-search'
import { tablePrefsOf } from './table-prefs'

/**
 * The readers of browser-stored strings and of an untyped location search,
 * at their edges: a table's column state, the Link folder bind a consent
 * detour leaves, and the sidebar's `?view=`. Every row was held against the
 * zod shapes before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'

describe('tablePrefsOf', () => {
  const NONE = { columnVisibility: {}, columnSizing: {} }
  const ROWS: ReadonlyArray<readonly [string | null, unknown]> = [
    [null, NONE],
    ['{}', NONE],
    ['not json', NONE],
    ['[]', NONE],
    ['null', NONE],
    ['7', NONE],
    [
      '{"columnVisibility":{"a":true,"b":false},"columnSizing":{"a":120}}',
      { columnVisibility: { a: true, b: false }, columnSizing: { a: 120 } },
    ],
    [
      '{"columnVisibility":{"a":true}}',
      { columnVisibility: { a: true }, columnSizing: {} },
    ],
    [
      '{"columnSizing":{"a":80.5}}',
      { columnVisibility: {}, columnSizing: { a: 80.5 } },
    ],
    ['{"columnVisibility":{"a":"yes"},"columnSizing":{"a":120}}', NONE],
    ['{"columnVisibility":{"a":true},"columnSizing":{"a":"120"}}', NONE],
    ['{"columnVisibility":[],"columnSizing":{"a":1}}', NONE],
    ['{"columnVisibility":null}', NONE],
    ['{"columnSizing":{"a":1e400}}', NONE],
    [
      '{"columnVisibility":{"__proto__":true,"b":false}}',
      { columnVisibility: { b: false }, columnSizing: {} },
    ],
    [
      '{"columnVisibility":{"a":true},"stray":1}',
      { columnVisibility: { a: true }, columnSizing: {} },
    ],
  ]
  it.each(ROWS)('%s', (raw, out) => {
    expect(tablePrefsOf(raw)).toStrictEqual(out)
  })
})

describe('pendingFolderLinkOf', () => {
  const OPTIONS = {
    mapSubfolders: true,
    retain: 'full',
    direction: 'pull',
    sensitivity: 'inherit',
  }
  const BASE = {
    entityId: ID,
    folder: { url: 'https://drive/x' },
    title: 'Deals',
    options: OPTIONS,
  }
  const stored = (over: Record<string, unknown>) =>
    JSON.stringify({ ...BASE, ...over })
  const ROWS: ReadonlyArray<readonly [string, string, unknown]> = [
    ['the bind', stored({}), BASE],
    [
      'a picked folder',
      stored({ folder: { id: 'f1' } }),
      { ...BASE, folder: { id: 'f1' } },
    ],
    [
      'a link and an id',
      stored({ folder: { url: 'u', id: 'f1' } }),
      { ...BASE, folder: { url: 'u' } },
    ],
    [
      'a bad link beside an id',
      stored({ folder: { url: 5, id: 'f1' } }),
      { ...BASE, folder: { id: 'f1' } },
    ],
    [
      'a stray folder key',
      stored({ folder: { url: 'u', stray: 1 } }),
      { ...BASE, folder: { url: 'u' } },
    ],
    ['no folder', stored({ folder: {} }), null],
    ['a bare folder string', stored({ folder: 'u' }), null],
    [
      'every other option',
      stored({
        options: {
          mapSubfolders: false,
          retain: 'text',
          direction: 'pull',
          sensitivity: 'sensitive',
        },
      }),
      {
        ...BASE,
        options: {
          mapSubfolders: false,
          retain: 'text',
          direction: 'pull',
          sensitivity: 'sensitive',
        },
      },
    ],
    ['a stray option', stored({ options: { ...OPTIONS, stray: 1 } }), BASE],
    ['a push', stored({ options: { ...OPTIONS, direction: 'push' } }), null],
    [
      'a string flag',
      stored({ options: { ...OPTIONS, mapSubfolders: 'yes' } }),
      null,
    ],
    [
      'an unknown retain',
      stored({ options: { ...OPTIONS, retain: 'some' } }),
      null,
    ],
    [
      'no sensitivity',
      stored({
        options: { mapSubfolders: true, retain: 'full', direction: 'pull' },
      }),
      null,
    ],
    ['no options', stored({ options: undefined }), null],
    ['a numeric record', stored({ entityId: 5 }), null],
    ['no title', stored({ title: null }), null],
    ['a stray key', stored({ stray: 1 }), BASE],
    ['not json', 'not json', null],
    ['null', 'null', null],
    ['a list', '[]', null],
  ]
  it.each(ROWS)('%s', (_, raw, out) => {
    expect(pendingFolderLinkOf(raw)).toStrictEqual(out)
  })
})

describe('listViewOf', () => {
  const ROWS: ReadonlyArray<readonly [string, unknown, string | null]> = [
    ['a view', { view: 'v1' }, 'v1'],
    ['an empty view', { view: '' }, ''],
    ['no view', {}, null],
    ['a numeric view', { view: 5 }, null],
    ['an undefined view', { view: undefined }, null],
    ['a stray key', { view: 'v1', stray: 1 }, 'v1'],
    ['null', null, null],
    ['undefined', undefined, null],
    ['a string', 'view', null],
    ['a list', [], null],
  ]
  it.each(ROWS)('%s', (_, search, out) => {
    expect(listViewOf(search)).toBe(out)
  })
})
