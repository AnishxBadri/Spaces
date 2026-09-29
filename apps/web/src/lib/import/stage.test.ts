import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { Effect } from 'effect'
import { count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { MAX_IMPORT_ROWS } from '@spaces/core/import/read'
import { db } from '@spaces/db'
import {
  document,
  importBatch,
  importRow,
  objectDef,
  pendingBlob,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { blobIsReferenced } from '#/lib/documents/blob-refs'
import { storage } from '@spaces/core/writes/storage'
import {
  defineImportBatchProgram,
  discardImportBatchProgram,
  importMessage,
  loadImportBatchProgram,
  selectImportSheetProgram,
  stageImportProgram,
} from './stage'
import type { StageImportInput, StageImportResult } from './stage'

/**
 * Staged import (SPA-164). A spreadsheet in, a batch and its rows out — and,
 * the half a happy path cannot show, nothing else: no `document` row, bytes
 * stored only when the file is accepted, the refusal's own words passed
 * through.
 */

const enc = new TextEncoder()

async function actorId(): Promise<string> {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('fixture user missing')
  return row.id
}

async function objectId(slug: string): Promise<string> {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
  ).at(0)
  if (!row) throw new Error(`object ${slug} missing`)
  return row.id
}

async function stage(
  over: Partial<StageImportInput> & { bytes: Uint8Array },
): Promise<StageImportResult> {
  return Effect.runPromise(
    stageImportProgram({
      filename: 'dealflow.csv',
      mime: 'text/csv',
      mode: 'records',
      targetObjectId: null,
      allowDuplicate: false,
      userId: await actorId(),
      ...over,
    }),
  )
}

/** What the caller is shown when the program fails; throws on success. */
async function refusalOf(
  over: Partial<StageImportInput> & { bytes: Uint8Array },
): Promise<string> {
  const failure = await Effect.runPromise(
    Effect.flip(
      stageImportProgram({
        filename: 'dealflow.csv',
        mime: 'text/csv',
        mode: 'records',
        targetObjectId: null,
        allowDuplicate: false,
        userId: await actorId(),
        ...over,
      }),
    ),
  )
  return importMessage(failure)
}

const tableCount = async (table: typeof document | typeof importBatch) =>
  (await db.select({ value: count() }).from(table)).at(0)?.value ?? 0

const shaOf = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * A deal-flow sheet of roughly `targetBytes`, messy the way real ones are:
 * quoted commas, a quoted newline, leading zeros, stray spaces, blanks.
 */
function messyCsv(targetBytes: number): { text: string; rows: number } {
  const header =
    'Company,Website,Stage,Amount (₹),First met,Notes,Owner,Sector,Country,Ref\n'
  let text = header
  let rows = 0
  while (text.length < targetBytes) {
    rows += 1
    text +=
      `"Acme ${rows}, Inc.",acme${rows}.example, Seed ,"1,20,000",` +
      `2026-0${(rows % 9) + 1}-1${rows % 10},"met at ""demo day""\nfollow up",` +
      `anish,Climate,IN,00${rows}\n`
  }
  return { text, rows }
}

describe('stageImportProgram', () => {
  it('stages a 2 MB CSV as one batch and one verbatim row per data row, with no document', async () => {
    const { text, rows } = messyCsv(2 * 1024 * 1024)
    const bytes = enc.encode(text)
    expect(bytes.byteLength).toBeGreaterThanOrEqual(2 * 1024 * 1024)
    const documentsBefore = await tableCount(document)

    const result = await stage({
      bytes,
      targetObjectId: await objectId('companies'),
    })
    if (result.kind !== 'staged') throw new Error('expected a staged batch')

    const batches = await db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, result.batchId))
    expect(batches).toHaveLength(1)
    const batch = batches[0]
    expect(batch.status).toBe('staged')
    expect(batch.rowCount).toBe(rows)
    expect(batch.blobSha).toBe(shaOf(bytes))
    expect(batch.sizeBytes).toBe(bytes.byteLength)
    expect(batch.headerRow).toBe(0)
    expect(batch.header?.[0]).toBe('Company')
    expect(batch.sheets).toEqual(['dealflow'])

    const [{ value: rowCount }] = await db
      .select({ value: count() })
      .from(importRow)
      .where(eq(importRow.batchId, result.batchId))
    expect(rowCount).toBe(rows)

    const [first] = await db
      .select({ cells: importRow.cells, entityId: importRow.entityId })
      .from(importRow)
      .where(eq(importRow.batchId, result.batchId))
      .orderBy(importRow.rowNum)
      .limit(1)
    expect(first.cells).toEqual([
      'Acme 1, Inc.',
      'acme1.example',
      ' Seed ',
      '1,20,000',
      '2026-02-11',
      'met at "demo day"\nfollow up',
      'anish',
      'Climate',
      'IN',
      '001',
    ])
    expect(first.entityId).toBeNull()

    // The bytes are stored, the intent row is spent, and nothing became a
    // document.
    expect(await storage().exists(batch.blobSha)).toBe(true)
    expect(await db.select().from(pendingBlob)).toHaveLength(0)
    expect(await tableCount(document)).toBe(documentsBefore)
    expect(await blobIsReferenced(batch.blobSha)).toBe(true)
  }, 60_000)

  it('answers a second upload of the same bytes with the earlier batch instead of staging it', async () => {
    const bytes = enc.encode(`Company,Stage\nAcme ${randomUUID()},Seed\n`)
    const batchesBefore = await tableCount(importBatch)
    const first = await stage({ bytes })
    if (first.kind !== 'staged') throw new Error('expected a staged batch')

    const again = await stage({ bytes, filename: 'renamed.csv' })
    expect(again.kind).toBe('duplicate')
    if (again.kind !== 'duplicate') return
    expect(again.previous).toMatchObject({
      id: first.batchId,
      filename: 'dealflow.csv',
      status: 'staged',
      rowCount: 1,
      written: 0,
      committedAt: null,
    })
    expect(await tableCount(importBatch)).toBe(batchesBefore + 1)

    // Said out loud, the caller may stage it again — same blob, second batch.
    const forced = await stage({ bytes, allowDuplicate: true })
    expect(forced.kind).toBe('staged')
    const same = await db
      .select({ id: importBatch.id })
      .from(importBatch)
      .where(eq(importBatch.blobSha, shaOf(bytes)))
    expect(same).toHaveLength(2)
  })

  it('refuses a file over the row cap by name and stores nothing', async () => {
    const text =
      'Company\n' +
      Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Co ${i}`).join(
        '\n',
      )
    const bytes = enc.encode(text)
    const before = await tableCount(importBatch)
    const message = await refusalOf({ bytes, filename: 'huge.csv' })
    expect(message).toContain('huge.csv')
    expect(message).toContain('at most 20,000')
    expect(await storage().exists(shaOf(bytes))).toBe(false)
    expect(await tableCount(importBatch)).toBe(before)
  })

  it('refuses a legacy .xls with the reader’s own words', async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 1, 2, 3])
    const message = await refusalOf({ bytes, filename: 'old.xls' })
    expect(message).toContain('old.xls')
    expect(await storage().exists(shaOf(bytes))).toBe(false)
  })

  it('refuses a file over the upload limit by name before storing anything', async () => {
    // Zero-filled and never touched: the check reads the length only.
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    const before = await tableCount(importBatch)
    const message = await refusalOf({ bytes, filename: 'giant.csv' })
    expect(message).toBe('giant.csv is larger than the 250 MB limit')
    expect(await tableCount(importBatch)).toBe(before)
  })

  it('refuses a ledger import that names an object, and an archived object', async () => {
    const bytes = enc.encode('Company\nAcme\n')
    const before = await tableCount(importBatch)
    expect(
      await refusalOf({
        bytes,
        mode: 'ledger',
        targetObjectId: await objectId('companies'),
      }),
    ).toBe('A ledger import targets the portfolio, not an object')

    const [archived] = await db
      .insert(objectDef)
      .values({
        slug: `bags-${randomUUID().slice(0, 8)}`,
        singular: 'Bag',
        plural: 'Bags',
        archived: true,
      })
      .returning({ id: objectDef.id })
    expect(await refusalOf({ bytes, targetObjectId: archived.id })).toBe(
      'That object is archived or no longer exists',
    )
    expect(await tableCount(importBatch)).toBe(before)
  })
})

describe('a staged batch', () => {
  it('loads its header and first 20 rows, and takes a target and a mode', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Co ${i + 1},${i}`)
    const result = await stage({
      bytes: enc.encode(`Name,Score\n${lines.join('\n')}\n`),
    })
    if (result.kind !== 'staged') throw new Error('expected a staged batch')

    const view = await Effect.runPromise(loadImportBatchProgram(result.batchId))
    expect(view.header).toEqual(['Name', 'Score'])
    expect(view.columnCount).toBe(2)
    expect(view.rowCount).toBe(30)
    expect(view.preview).toHaveLength(20)
    expect(view.preview[0]).toEqual({ rowNum: 1, cells: ['Co 1', '0'] })
    expect(view.previous).toBeNull()

    const people = await objectId('people')
    await Effect.runPromise(
      defineImportBatchProgram({
        batchId: result.batchId,
        mode: 'records',
        targetObjectId: people,
      }),
    )
    let [row] = await db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, result.batchId))
    expect(row.targetObjectId).toBe(people)

    // Ledger mode drops the object — it targets the portfolio.
    await Effect.runPromise(
      defineImportBatchProgram({
        batchId: result.batchId,
        mode: 'ledger',
        targetObjectId: people,
      }),
    )
    ;[row] = await db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, result.batchId))
    expect(row.mode).toBe('ledger')
    expect(row.targetObjectId).toBeNull()
  })

  it('cannot leave staged in records mode without a target', async () => {
    const result = await stage({ bytes: enc.encode('Name\nAcme\n') })
    if (result.kind !== 'staged') throw new Error('expected a staged batch')
    await expect(
      db
        .update(importBatch)
        .set({ status: 'planned' })
        .where(eq(importBatch.id, result.batchId)),
    ).rejects.toThrow()
  })

  it('restages rows from another sheet of the workbook', async () => {
    const bytes = workbook()
    const result = await stage({
      bytes,
      filename: 'portfolio.xlsx',
      mime: null,
    })
    if (result.kind !== 'staged') throw new Error('expected a staged batch')
    let view = await Effect.runPromise(loadImportBatchProgram(result.batchId))
    // The cover tab has no data rows, so the first sheet with data is staged.
    expect(view.sheets).toEqual(['Cover', 'Pipeline', 'Marks'])
    expect(view.sheet).toBe('Pipeline')
    expect(view.header).toEqual(['Company', 'Stage'])
    expect(view.rowCount).toBe(2)

    await Effect.runPromise(
      selectImportSheetProgram({ batchId: result.batchId, sheet: 'Marks' }),
    )
    view = await Effect.runPromise(loadImportBatchProgram(result.batchId))
    expect(view.sheet).toBe('Marks')
    expect(view.header).toEqual(['Holding', 'Value'])
    expect(view.rowCount).toBe(1)
    expect(view.preview).toEqual([{ rowNum: 1, cells: ['Acme', '120'] }])
  })

  it('discards a staged batch and the bytes nothing else names', async () => {
    const bytes = enc.encode(`Name\nAcme ${randomUUID()}\n`)
    const result = await stage({ bytes })
    if (result.kind !== 'staged') throw new Error('expected a staged batch')
    await Effect.runPromise(discardImportBatchProgram(result.batchId))
    expect(
      await db
        .select()
        .from(importRow)
        .where(eq(importRow.batchId, result.batchId)),
    ).toHaveLength(0)
    expect(await storage().exists(shaOf(bytes))).toBe(false)
    const gone = await Effect.runPromise(
      Effect.flip(loadImportBatchProgram(result.batchId)),
    )
    expect(importMessage(gone)).toBe('This import no longer exists')
  })
})

describe('the browser never hashes an import', () => {
  const src = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

  // The needle is assembled so this file is not itself a hit: the scan is
  // the `grep -rn` of the acceptance criterion, test files included.
  const needle = ['crypto', 'subtle'].join('.')

  it('keeps exactly one WebCrypto call in the app, the document lane’s', () => {
    const hits = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) =>
        readFileSync(join(src, f), 'utf8')
          .split('\n')
          .filter((line) => line.includes(needle))
          .map(() => f),
      )
    expect(hits).toEqual(['lib/documents/upload.ts'])
  })
})

// ---------------------------------------------------------------------------
// A three-tab workbook, zipped here with no compression (method 0) so the
// fixture needs nothing beyond node:zlib's crc32.
// ---------------------------------------------------------------------------

function zipStored(files: Record<string, string>): Uint8Array {
  const locals: Array<Buffer> = []
  const centrals: Array<Buffer> = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]))
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

function workbook(): Uint8Array {
  return zipStored({
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '</Types>',
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets>' +
      '<sheet name="Cover" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Pipeline" sheetId="2" r:id="rId2"/>' +
      '<sheet name="Marks" sheetId="3" r:id="rId3"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships>' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      `<row r="1">${inline('A1', 'Fund I portfolio')}</row>` +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData>' +
      `<row r="1">${inline('A1', 'Company')}${inline('B1', 'Stage')}</row>` +
      `<row r="2">${inline('A2', 'Acme')}${inline('B2', 'Seed')}</row>` +
      `<row r="3">${inline('A3', 'Beta')}${inline('B3', 'Series A')}</row>` +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet3.xml':
      '<worksheet><sheetData>' +
      `<row r="1">${inline('A1', 'Holding')}${inline('B1', 'Value')}</row>` +
      `<row r="2">${inline('A2', 'Acme')}<c r="B2"><v>120</v></c></row>` +
      '</sheetData></worksheet>',
  })
}
