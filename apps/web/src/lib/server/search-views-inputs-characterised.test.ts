import type * as Start from '@tanstack/react-start'
import { describe, expect, it, vi } from 'vitest'
import { REFUSED, verdict } from '#/test/server-fn-validators'

vi.mock('@tanstack/react-start', async (actual) =>
  (await import('#/test/server-fn-validators')).capturingStart(
    await actual<typeof Start>(),
  ),
)

/**
 * The search and view server fns' input boundaries, through each fn's own
 * validator: what the handler receives, or `REFUSED`. Every row was held
 * against the zod shapes before they were Effect schemas, so a row that
 * moves is a caller who sees a different answer.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const ID2 = '7f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'

const modules = {
  search: () => import('./search'),
  views: () => import('./views'),
}

type Row = readonly [fn: string, label: string, input: unknown, out: unknown]

const table = (name: keyof typeof modules, rows: ReadonlyArray<Row>) =>
  describe(name, () => {
    it.each(rows)('%s: %s', async (fn, _, value, out) => {
      const mod: object = await modules[name]()
      expect(await verdict(Reflect.get(mod, fn), value)).toEqual(out)
    })
  })

table('search', [
  ['searchEntities', 'a query', { q: 'acme' }, { q: 'acme' }],
  [
    'searchEntities',
    'kinds and an object',
    { q: 'a', kinds: ['person', 'custom'], objectId: ID },
    { q: 'a', kinds: ['person', 'custom'], objectId: ID },
  ],
  ['searchEntities', 'an unknown kind', { q: 'a', kinds: ['task'] }, REFUSED],
  ['searchEntities', '121 characters', { q: 'q'.repeat(121) }, REFUSED],
  ['searchEntities', 'a stray key', { q: 'a', limit: 3 }, { q: 'a' }],
  ['searchEntities', 'nothing', undefined, REFUSED],
  ['searchAll', 'a query', { q: 'acme' }, { q: 'acme' }],
  [
    'searchAll',
    '200 characters',
    { q: 'q'.repeat(200) },
    { q: 'q'.repeat(200) },
  ],
  ['searchAll', '201 characters', { q: 'q'.repeat(201) }, REFUSED],
  ['searchAll', 'a padded query', { q: ' a ' }, { q: ' a ' }],
  ['searchAll', 'a numeric query', { q: 5 }, REFUSED],
  ['searchPassages', 'a query', { q: 'acme' }, { q: 'acme' }],
  ['searchPassages', 'no query', {}, REFUSED],
  ['previewRecord', 'an id', { id: ID }, { id: ID }],
  [
    'previewRecord',
    'an upper-case id',
    { id: ID.toUpperCase() },
    { id: ID.toUpperCase() },
  ],
  ['previewRecord', 'a bad id', { id: 'x' }, REFUSED],
  [
    'previewRecord',
    'a version-0 id',
    { id: '0b6ad7a2-6a3e-0c4f-9a43-5d1f1d8b6c11' },
    REFUSED,
  ],
  ['previewObject', 'a slug', { slug: 'companies' }, { slug: 'companies' }],
  ['previewObject', 'an empty slug', { slug: '' }, REFUSED],
  ['previewObject', 'an 81-character slug', { slug: 's'.repeat(81) }, REFUSED],
  [
    'previewPassage',
    'a page',
    { id: ID, page: 3, snippet: 'x' },
    { id: ID, page: 3, snippet: 'x' },
  ],
  [
    'previewPassage',
    'no page',
    { id: ID, page: null, snippet: '' },
    { id: ID, page: null, snippet: '' },
  ],
  ['previewPassage', 'a missing page', { id: ID, snippet: '' }, REFUSED],
  ['previewPassage', 'page zero', { id: ID, page: 0, snippet: '' }, REFUSED],
  [
    'previewPassage',
    'a fractional page',
    { id: ID, page: 1.5, snippet: '' },
    REFUSED,
  ],
  [
    'previewPassage',
    'an infinite page',
    { id: ID, page: Infinity, snippet: '' },
    REFUSED,
  ],
  [
    'previewPassage',
    'a 401-character snippet',
    { id: ID, page: 1, snippet: 's'.repeat(401) },
    REFUSED,
  ],
])

const body = {
  name: ' Hot deals ',
  filter: [{ slug: 'stage', op: 'is', value: 'term_sheet' }],
  sort: { id: 'name', desc: false },
  columns: { name: true, stage: false },
  extra: { density: 'compact', size: 20, wrap: true, group: null },
  visibility: 'shared',
}
const bodyOut = { ...body, name: 'Hot deals' }

table('views', [
  [
    'listViews',
    'an object by kind',
    { surface: 'object', kind: 'deal' },
    { surface: 'object', kind: 'deal' },
  ],
  [
    'listViews',
    'an object by id',
    { surface: 'object', objectId: ID },
    { surface: 'object', objectId: ID },
  ],
  ['listViews', 'an object by neither', { surface: 'object' }, REFUSED],
  [
    'listViews',
    'an object by both',
    { surface: 'object', kind: 'deal', objectId: ID },
    REFUSED,
  ],
  ['listViews', 'documents', { surface: 'document' }, { surface: 'document' }],
  [
    'listViews',
    'documents with a kind',
    { surface: 'document', kind: 'deal' },
    { surface: 'document' },
  ],
  ['listViews', 'an unknown surface', { surface: 'task' }, REFUSED],
  [
    'saveView',
    'a new object view, trimmed',
    { surface: 'object', kind: 'deal', ...body },
    { surface: 'object', kind: 'deal', ...bodyOut },
  ],
  [
    'saveView',
    'an existing document view',
    { surface: 'document', id: ID, ...body, sort: null },
    { surface: 'document', id: ID, ...bodyOut, sort: null },
  ],
  [
    'saveView',
    'an object view by neither',
    { surface: 'object', ...body },
    REFUSED,
  ],
  [
    'saveView',
    'a blank name',
    { surface: 'document', ...body, name: '   ' },
    REFUSED,
  ],
  [
    'saveView',
    'an 81-character name',
    { surface: 'document', ...body, name: 'n'.repeat(81) },
    REFUSED,
  ],
  [
    'saveView',
    'an 80-character name, padded',
    { surface: 'document', ...body, name: ` ${'n'.repeat(80)} ` },
    { surface: 'document', ...bodyOut, name: 'n'.repeat(80) },
  ],
  [
    'saveView',
    'every condition value',
    {
      surface: 'document',
      ...body,
      filter: [
        { slug: 'a', op: 'is' },
        { slug: 'b', op: 'gt', value: 5 },
        { slug: 'c', op: 'is_not', value: false },
        { slug: 'd', op: 'empty', value: null },
        { slug: 'e', op: 'contains', value: ['x', 'y'] },
      ],
    },
    {
      surface: 'document',
      ...bodyOut,
      filter: [
        { slug: 'a', op: 'is' },
        { slug: 'b', op: 'gt', value: 5 },
        { slug: 'c', op: 'is_not', value: false },
        { slug: 'd', op: 'empty', value: null },
        { slug: 'e', op: 'contains', value: ['x', 'y'] },
      ],
    },
  ],
  [
    'saveView',
    'an unknown op',
    { surface: 'document', ...body, filter: [{ slug: 'a', op: 'like' }] },
    REFUSED,
  ],
  [
    'saveView',
    'a numeric list value',
    {
      surface: 'document',
      ...body,
      filter: [{ slug: 'a', op: 'is', value: [1] }],
    },
    REFUSED,
  ],
  [
    'saveView',
    'an object value',
    {
      surface: 'document',
      ...body,
      filter: [{ slug: 'a', op: 'is', value: { a: 1 } }],
    },
    REFUSED,
  ],
  [
    'saveView',
    'an infinite value',
    {
      surface: 'document',
      ...body,
      filter: [{ slug: 'a', op: 'gt', value: Infinity }],
    },
    REFUSED,
  ],
  [
    'saveView',
    'an empty slug',
    { surface: 'document', ...body, filter: [{ slug: '', op: 'is' }] },
    REFUSED,
  ],
  [
    'saveView',
    '21 conditions',
    {
      surface: 'document',
      ...body,
      filter: Array.from({ length: 21 }, () => ({ slug: 'a', op: 'empty' })),
    },
    REFUSED,
  ],
  [
    'saveView',
    'a numeric column',
    { surface: 'document', ...body, columns: { name: 1 } },
    REFUSED,
  ],
  [
    'saveView',
    'columns as a list',
    { surface: 'document', ...body, columns: [] },
    REFUSED,
  ],
  [
    'saveView',
    'columns as a date',
    { surface: 'document', ...body, columns: new Date(0) },
    REFUSED,
  ],
  [
    'saveView',
    'a __proto__ column',
    {
      surface: 'document',
      ...body,
      columns: JSON.parse('{"__proto__":true,"name":true}'),
    },
    { surface: 'document', ...bodyOut, columns: { name: true } },
  ],
  [
    'saveView',
    'a list in extra',
    { surface: 'document', ...body, extra: { a: ['x'] } },
    REFUSED,
  ],
  [
    'saveView',
    'an infinity in extra',
    { surface: 'document', ...body, extra: { a: Infinity } },
    REFUSED,
  ],
  [
    'saveView',
    'an unknown visibility',
    { surface: 'document', ...body, visibility: 'team' },
    REFUSED,
  ],
  [
    'saveView',
    'no sort',
    { surface: 'document', ...body, sort: undefined },
    REFUSED,
  ],
  ['saveView', 'a bad id', { surface: 'document', ...body, id: 'x' }, REFUSED],
  [
    'deleteView',
    'an object view',
    { surface: 'object', kind: 'company', id: ID },
    { surface: 'object', kind: 'company', id: ID },
  ],
  [
    'deleteView',
    'a document view',
    { surface: 'document', id: ID },
    { surface: 'document', id: ID },
  ],
  [
    'deleteView',
    'an object view by neither',
    { surface: 'object', id: ID },
    REFUSED,
  ],
  ['deleteView', 'no id', { surface: 'document' }, REFUSED],
  ['listPinnedViews', 'pins', { ids: [ID, ID2] }, { ids: [ID, ID2] }],
  ['listPinnedViews', 'no pins', { ids: [] }, { ids: [] }],
  [
    'listPinnedViews',
    '101 pins',
    { ids: Array.from({ length: 101 }, () => ID) },
    REFUSED,
  ],
  ['listPinnedViews', 'a bad pin', { ids: ['x'] }, REFUSED],
  [
    'countViews',
    'chips',
    { surface: 'object', kind: 'deal', viewIds: [ID] },
    { surface: 'object', kind: 'deal', viewIds: [ID] },
  ],
  [
    'countViews',
    'a live view',
    {
      surface: 'object',
      objectId: ID,
      viewIds: [ID],
      live: { viewId: ID2, filter: [{ slug: 'a', op: 'empty' }] },
    },
    {
      surface: 'object',
      objectId: ID,
      viewIds: [ID],
      live: { viewId: ID2, filter: [{ slug: 'a', op: 'empty' }] },
    },
  ],
  ['countViews', 'documents', { surface: 'document', viewIds: [ID] }, REFUSED],
  [
    'countViews',
    'an object by neither',
    { surface: 'object', viewIds: [ID] },
    REFUSED,
  ],
  [
    'countViews',
    'a live view with a bad id',
    {
      surface: 'object',
      kind: 'deal',
      viewIds: [],
      live: { viewId: 'x', filter: [] },
    },
    REFUSED,
  ],
])
