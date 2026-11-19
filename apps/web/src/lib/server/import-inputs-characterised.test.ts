import type * as Start from '@tanstack/react-start'
import { describe, expect, it, vi } from 'vitest'
import { REFUSED, verdict } from '#/test/server-fn-validators'

vi.mock('@tanstack/react-start', async (actual) =>
  (await import('#/test/server-fn-validators')).capturingStart(
    await actual<typeof Start>(),
  ),
)

/**
 * The staged import's server fns at their input edges, through each fn's
 * own validator: what the handler receives, or `REFUSED`. Every row was
 * held against the zod shapes before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const ID2 = '7f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'

type Row = readonly [fn: string, label: string, input: unknown, out: unknown]

const sheet = new File(['a,b\n1,2\n'], 'deals.csv', { type: 'text/csv' })
const form = (fields: Record<string, string | File>) => {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}

const column = (target: unknown) => ({ batchId: ID, column: 3, target })
const attribute = (over: Record<string, unknown>) => ({
  batchId: ID,
  column: 0,
  name: 'Stage',
  type: 'select',
  options: [],
  dateOrder: null,
  ...over,
})

const ROWS: ReadonlyArray<Row> = [
  [
    'stageImport',
    'a ledger into an object',
    form({
      file: sheet,
      mode: 'ledger',
      targetObjectId: ID,
      allowDuplicate: 'true',
    }),
    { file: sheet, mode: 'ledger', targetObjectId: ID, allowDuplicate: true },
  ],
  [
    'stageImport',
    'a file alone',
    form({ file: sheet }),
    {
      file: sheet,
      mode: 'records',
      targetObjectId: null,
      allowDuplicate: false,
    },
  ],
  [
    'stageImport',
    'an empty target',
    form({ file: sheet, targetObjectId: '' }),
    {
      file: sheet,
      mode: 'records',
      targetObjectId: null,
      allowDuplicate: false,
    },
  ],
  [
    'stageImport',
    'a bad target',
    form({ file: sheet, targetObjectId: 'x' }),
    REFUSED,
  ],
  ['stageImport', 'a bad mode', form({ file: sheet, mode: 'notes' }), REFUSED],
  ['stageImport', 'no file', form({ mode: 'records' }), REFUSED],

  ['getImportBatch', 'a batch', { batchId: ID }, { batchId: ID }],
  ['getImportBatch', 'a bad batch', { batchId: 'x' }, REFUSED],
  [
    'defineImportBatch',
    'records',
    { batchId: ID, mode: 'records', targetObjectId: null },
    { batchId: ID, mode: 'records', targetObjectId: null },
  ],
  [
    'defineImportBatch',
    'into an object',
    { batchId: ID, mode: 'records', targetObjectId: ID2 },
    { batchId: ID, mode: 'records', targetObjectId: ID2 },
  ],
  [
    'defineImportBatch',
    'no target key',
    { batchId: ID, mode: 'records' },
    REFUSED,
  ],
  [
    'defineImportBatch',
    'a bad mode',
    { batchId: ID, mode: 'notes', targetObjectId: null },
    REFUSED,
  ],
  [
    'selectImportSheet',
    'a sheet',
    { batchId: ID, sheet: ' Q3 ' },
    { batchId: ID, sheet: ' Q3 ' },
  ],
  ['selectImportSheet', 'no sheet', { batchId: ID, sheet: '' }, REFUSED],
  [
    'selectImportSheet',
    'a long sheet',
    { batchId: ID, sheet: 'a'.repeat(401) },
    REFUSED,
  ],
  ['discardImportBatch', 'a batch', { batchId: ID }, { batchId: ID }],

  ['getImportMapping', 'a batch', { batchId: ID }, { batchId: ID }],
  [
    'beginImportMapping',
    'a stray key',
    { batchId: ID, mode: 'x' },
    { batchId: ID },
  ],
  [
    'mapImportColumn',
    'the name',
    column({ target: 'name' }),
    column({ target: 'name' }),
  ],
  [
    'mapImportColumn',
    'the name, a stray key',
    column({ target: 'name', attributeId: ID }),
    column({ target: 'name' }),
  ],
  [
    'mapImportColumn',
    'ignore',
    column({ target: 'ignore' }),
    column({ target: 'ignore' }),
  ],
  [
    'mapImportColumn',
    'an attribute',
    column({ target: 'attribute', attributeId: ID }),
    column({ target: 'attribute', attributeId: ID }),
  ],
  [
    'mapImportColumn',
    'an attribute with its options',
    column({
      target: 'attribute',
      attributeId: ID,
      dateOrder: 'mdy',
      createMissing: true,
    }),
    column({
      target: 'attribute',
      attributeId: ID,
      dateOrder: 'mdy',
      createMissing: true,
    }),
  ],
  [
    'mapImportColumn',
    'createMissing false',
    column({ target: 'attribute', attributeId: ID, createMissing: false }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a bad date order',
    column({ target: 'attribute', attributeId: ID, dateOrder: 'ymd' }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'an identity',
    column({ target: 'identity', key: 'domain' }),
    column({ target: 'identity', key: 'domain' }),
  ],
  [
    'mapImportColumn',
    'a bad identity',
    column({ target: 'identity', key: 'phone' }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a new attribute',
    column({
      target: 'new',
      name: ' Stage ',
      type: 'select',
      options: [' Seed ', 'A'],
      dateOrder: 'dmy',
    }),
    column({
      target: 'new',
      name: 'Stage',
      type: 'select',
      options: ['Seed', 'A'],
      dateOrder: 'dmy',
    }),
  ],
  [
    'mapImportColumn',
    'a new attribute, no options',
    column({ target: 'new', name: 'Notes', type: 'text' }),
    column({ target: 'new', name: 'Notes', type: 'text' }),
  ],
  [
    'mapImportColumn',
    'a new attribute of a bad type',
    column({ target: 'new', name: 'Who', type: 'record_reference' }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a new attribute, a blank option',
    column({ target: 'new', name: 'Stage', type: 'select', options: [' '] }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a new attribute, a blank name',
    column({ target: 'new', name: ' ', type: 'text' }),
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a ledger field',
    column({ target: 'ledger', field: 'amount' }),
    column({ target: 'ledger', field: 'amount' }),
  ],
  [
    'mapImportColumn',
    'a bad ledger field',
    column({ target: 'ledger', field: 'stage' }),
    REFUSED,
  ],
  ['mapImportColumn', 'an unknown target', column({ target: 'note' }), REFUSED],
  ['mapImportColumn', 'no target', { batchId: ID, column: 3 }, REFUSED],
  [
    'mapImportColumn',
    'column 1001',
    { batchId: ID, column: 1001, target: { target: 'name' } },
    REFUSED,
  ],
  [
    'mapImportColumn',
    'column -1',
    { batchId: ID, column: -1, target: { target: 'name' } },
    REFUSED,
  ],
  [
    'mapImportColumn',
    'a fractional column',
    { batchId: ID, column: 1.5, target: { target: 'name' } },
    REFUSED,
  ],
  [
    'createImportAttribute',
    'a select',
    attribute({ name: ' Stage ', options: [' Seed '] }),
    attribute({ name: 'Stage', options: ['Seed'] }),
  ],
  [
    'createImportAttribute',
    'a date',
    attribute({ type: 'date', dateOrder: 'dmy' }),
    attribute({ type: 'date', dateOrder: 'dmy' }),
  ],
  [
    'createImportAttribute',
    'no options key',
    { batchId: ID, column: 0, name: 'x', type: 'text', dateOrder: null },
    REFUSED,
  ],
  [
    'createImportAttribute',
    'no date order key',
    { batchId: ID, column: 0, name: 'x', type: 'text', options: [] },
    REFUSED,
  ],
  [
    'createImportAttribute',
    'a bad type',
    attribute({ type: 'markdown' }),
    REFUSED,
  ],
  [
    'createImportAttribute',
    'fifty-one options',
    attribute({ options: Array.from({ length: 51 }, () => 'a') }),
    REFUSED,
  ],
  [
    'createImportAttribute',
    'a long option',
    attribute({ options: ['a'.repeat(61)] }),
    REFUSED,
  ],

  ['planImport', 'a batch', { batchId: ID }, { batchId: ID }],
  [
    'getImportPreview',
    'a filter',
    { batchId: ID, filter: 'decide' },
    { batchId: ID, filter: 'decide' },
  ],
  [
    'getImportPreview',
    'an unknown filter',
    { batchId: ID, filter: 'mine' },
    { batchId: ID, filter: 'all' },
  ],
  [
    'getImportPreview',
    'no filter',
    { batchId: ID },
    { batchId: ID, filter: 'all' },
  ],
  [
    'getImportPreview',
    'a null filter',
    { batchId: ID, filter: null },
    { batchId: ID, filter: 'all' },
  ],
  [
    'getImportPreview',
    'a numeric filter',
    { batchId: ID, filter: 2 },
    { batchId: ID, filter: 'all' },
  ],
  ['getImportPreview', 'a bad batch', { batchId: 'x', filter: 'all' }, REFUSED],
  [
    'decideImportCollision',
    'a decision',
    { batchId: ID, rowNum: 1, decision: 'skip-both' },
    { batchId: ID, rowNum: 1, decision: 'skip-both' },
  ],
  [
    'decideImportCollision',
    'row zero',
    { batchId: ID, rowNum: 0, decision: 'skip-both' },
    REFUSED,
  ],
  [
    'decideImportCollision',
    'a bad decision',
    { batchId: ID, rowNum: 2, decision: 'keep-both' },
    REFUSED,
  ],
  ['reopenImportMapping', 'a batch', { batchId: ID }, { batchId: ID }],

  ['getLedgerImport', 'a batch', { batchId: ID }, { batchId: ID }],
  ['beginLedgerMapping', 'a batch', { batchId: ID }, { batchId: ID }],
  [
    'mapLedgerField',
    'a field',
    { batchId: ID, field: 'date', column: 2 },
    { batchId: ID, field: 'date', column: 2 },
  ],
  [
    'mapLedgerField',
    'off the sheet',
    { batchId: ID, field: 'cap', column: null },
    { batchId: ID, field: 'cap', column: null },
  ],
  [
    'mapLedgerField',
    'a bad field',
    { batchId: ID, field: 'stage', column: 2 },
    REFUSED,
  ],
  ['mapLedgerField', 'no column key', { batchId: ID, field: 'date' }, REFUSED],
  [
    'setLedgerDecision',
    'an instrument',
    {
      batchId: ID,
      decision: {
        kind: 'instrument',
        value: 'SAFE',
        resolution: 'safe_post_money',
      },
    },
    {
      batchId: ID,
      decision: {
        kind: 'instrument',
        value: 'SAFE',
        resolution: 'safe_post_money',
      },
    },
  ],
  [
    'setLedgerDecision',
    'per row',
    {
      batchId: ID,
      decision: { kind: 'instrument', value: 'mixed', resolution: 'per_row' },
    },
    {
      batchId: ID,
      decision: { kind: 'instrument', value: 'mixed', resolution: 'per_row' },
    },
  ],
  [
    'setLedgerDecision',
    'an unresolved instrument',
    {
      batchId: ID,
      decision: { kind: 'instrument', value: 'x', resolution: null },
    },
    {
      batchId: ID,
      decision: { kind: 'instrument', value: 'x', resolution: null },
    },
  ],
  [
    'setLedgerDecision',
    'a bad resolution',
    {
      batchId: ID,
      decision: { kind: 'instrument', value: 'x', resolution: 'note' },
    },
    REFUSED,
  ],
  [
    'setLedgerDecision',
    'a marks date',
    { batchId: ID, decision: { kind: 'marksAsOf', date: '2026-06-30' } },
    { batchId: ID, decision: { kind: 'marksAsOf', date: '2026-06-30' } },
  ],
  [
    'setLedgerDecision',
    'no marks date',
    { batchId: ID, decision: { kind: 'marksAsOf', date: null } },
    { batchId: ID, decision: { kind: 'marksAsOf', date: null } },
  ],
  [
    'setLedgerDecision',
    'a bad marks date',
    { batchId: ID, decision: { kind: 'marksAsOf', date: '30/06/2026' } },
    REFUSED,
  ],
  [
    'setLedgerDecision',
    'a currency',
    { batchId: ID, decision: { kind: 'currency', code: 'EUR' } },
    { batchId: ID, decision: { kind: 'currency', code: 'EUR' } },
  ],
  [
    'setLedgerDecision',
    'a lower-case currency',
    { batchId: ID, decision: { kind: 'currency', code: 'eur' } },
    REFUSED,
  ],
  [
    'setLedgerDecision',
    'a date order',
    { batchId: ID, decision: { kind: 'dateOrder', order: 'dmy' } },
    { batchId: ID, decision: { kind: 'dateOrder', order: 'dmy' } },
  ],
  [
    'setLedgerDecision',
    'create missing',
    {
      batchId: ID,
      decision: { kind: 'createMissing', on: true, order: 'dmy' },
    },
    { batchId: ID, decision: { kind: 'createMissing', on: true } },
  ],
  [
    'setLedgerDecision',
    'an unknown kind',
    { batchId: ID, decision: { kind: 'fx', on: true } },
    REFUSED,
  ],
  ['planLedgerImport', 'a batch', { batchId: ID }, { batchId: ID }],
  [
    'decideLedgerRow',
    'a row',
    { batchId: ID, rowNum: 4, instrument: 'ccd' },
    { batchId: ID, rowNum: 4, instrument: 'ccd' },
  ],
  [
    'decideLedgerRow',
    'per row',
    { batchId: ID, rowNum: 4, instrument: 'per_row' },
    REFUSED,
  ],

  [
    'commitImport',
    'a commit',
    { batchId: ID, onlyFailed: false },
    { batchId: ID, onlyFailed: false },
  ],
  ['commitImport', 'no flag', { batchId: ID }, REFUSED],
  [
    'getImportReceipt',
    'failed',
    { batchId: ID, filter: 'failed' },
    { batchId: ID, filter: 'failed' },
  ],
  [
    'getImportReceipt',
    'an unknown filter',
    { batchId: ID, filter: 'create' },
    { batchId: ID, filter: 'all' },
  ],
  [
    'getImportReceipt',
    'no filter',
    { batchId: ID },
    { batchId: ID, filter: 'all' },
  ],
]

describe('imports', () => {
  it.each(ROWS)('%s: %s', async (fn, _, value, out) => {
    const mod: object = await import('./imports')
    expect(await verdict(Reflect.get(mod, fn), value)).toEqual(out)
  })
})
