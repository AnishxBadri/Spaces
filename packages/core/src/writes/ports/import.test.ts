import { Cause, Effect, Exit } from 'effect'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { importBatch, importRow } from '@spaces/db/schema'
import { Import } from '@spaces/sdk'
import type { ImportGrid } from '@spaces/sdk'
import { ImportLive, ImportRun } from './import'

/**
 * Import bound to an integration, against a real database: the grid lands
 * in the waiting batch as text rows the import reader takes, a malformed
 * unit lands alone under its ordinal, a second stage writes nothing, and a
 * call outside an import run has no batch to stage into.
 */

const row = {
  id: '00000000-0000-4000-8000-000000000001',
  capabilityId: 'airtable',
}

const waitingBatch = async () => {
  const batch = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'f'.repeat(64),
        filename: 'Companies-Grid view.csv',
        sizeBytes: 100,
        sheet: 'Companies-Grid view',
        sheets: ['Companies-Grid view'],
        mode: 'records',
        rowCount: 0,
      })
      .returning({ id: importBatch.id })
  ).at(0)
  if (!batch) throw new Error('no batch')
  return batch.id
}

const stage = (grid: ImportGrid, batchId: string | null) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Import).stage(grid)
    }).pipe(
      Effect.provide(ImportLive(row)),
      Effect.provideService(ImportRun, batchId === null ? null : { batchId }),
    ),
  )

const reasonOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  return Cause.squash(exit.cause)
}

const grid: ImportGrid = {
  columns: ['Name', 'Business model'],
  rows: [
    { ordinal: 1, cells: ['Acme', ['B2B', 'Marketplace']] },
    { ordinal: 2, cells: ['Beta', ['Health, Wellness']] },
    { ordinal: 3, cells: ['Gamma'] },
  ],
}

describe('ImportLive', () => {
  it('lands the grid in the waiting batch: header, rows, list cells as text', async () => {
    const batchId = await waitingBatch()
    const exit = await stage(grid, batchId)
    expect(exit).toEqual(
      Exit.succeed({ batchId, staged: 3, malformed: [], refused: [] }),
    )
    const batch = (
      await db.select().from(importBatch).where(eq(importBatch.id, batchId))
    ).at(0)
    expect(batch).toMatchObject({
      status: 'staged',
      header: ['Name', 'Business model'],
      headerRow: 0,
      rowCount: 3,
    })
    expect(
      await db
        .select({ rowNum: importRow.rowNum, cells: importRow.cells })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .orderBy(asc(importRow.rowNum)),
    ).toEqual([
      { rowNum: 1, cells: ['Acme', 'B2B,Marketplace'] },
      { rowNum: 2, cells: ['Beta', '"Health, Wellness"'] },
      { rowNum: 3, cells: ['Gamma', ''] },
    ])
  })

  it('places a malformed unit alone, with no cells, and refuses an unusable ordinal', async () => {
    const batchId = await waitingBatch()
    const exit = await stage(
      {
        columns: ['Name'],
        rows: [
          { ordinal: 1, cells: ['Acme'] },
          // A bundle's types do not survive the import boundary.
          JSON.parse('{ "ordinal": 2, "cells": [42] }'),
          JSON.parse('{ "ordinal": -1, "cells": ["Nowhere"] }'),
          { ordinal: 3, cells: ['Gamma'] },
        ],
      },
      batchId,
    )
    expect(exit).toEqual(
      Exit.succeed({
        batchId,
        staged: 3,
        malformed: [
          { ordinal: 2, reason: 'cell 1 is neither text nor a list of text' },
        ],
        refused: [
          {
            ordinal: -1,
            reason:
              'row 3 of the grid has no ordinal that is a positive whole number',
          },
        ],
      }),
    )
    expect(
      await db
        .select({ rowNum: importRow.rowNum, cells: importRow.cells })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .orderBy(asc(importRow.rowNum)),
    ).toEqual([
      { rowNum: 1, cells: ['Acme'] },
      { rowNum: 2, cells: [] },
      { rowNum: 3, cells: ['Gamma'] },
    ])
  })

  it('writes nothing on a second stage and answers with what is there', async () => {
    const batchId = await waitingBatch()
    await stage(grid, batchId)
    const again = await stage(
      { columns: ['Other'], rows: [{ ordinal: 1, cells: ['x'] }] },
      batchId,
    )
    expect(Exit.isSuccess(again) && again.value.staged).toBe(3)
    const rows = await db
      .select({ rowNum: importRow.rowNum })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
    expect(rows).toHaveLength(3)
  })

  it('fails permanently outside an import run, on an unreadable grid, and on a discarded batch', async () => {
    expect(reasonOf(await stage(grid, null))).toMatchObject({
      _tag: 'JobPermanent',
      reason:
        'airtable called Import.stage outside an import: only a file job the import wizard starts has a batch to stage into',
    })
    const batchId = await waitingBatch()
    expect(
      reasonOf(await stage({ columns: [], rows: [] }, batchId)),
    ).toMatchObject({
      _tag: 'JobPermanent',
      reason: "airtable's grid is unreadable: the grid names no columns",
    })
    await db.delete(importBatch).where(eq(importBatch.id, batchId))
    expect(reasonOf(await stage(grid, batchId))).toMatchObject({
      _tag: 'JobPermanent',
      reason: `import batch ${batchId} no longer exists — it was discarded while it was being read`,
    })
  })
})
