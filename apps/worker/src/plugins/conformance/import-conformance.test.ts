import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { importBatch } from '@spaces/db/schema'
import { ImportLive, ImportRun } from '@spaces/core/writes/ports/import'
import { Import } from '@spaces/sdk'
import type { ImportGrid, StageResult } from '@spaces/sdk'
import { ImportTest } from '@spaces/sdk/testing'
import { runOn } from './support'

/**
 * The Import port's contract, over every implementation: a grid lands as
 * many rows as it has placeable units, a unit that does not decode lands
 * alone under its ordinal with its reason, and a second stage writes nothing
 * and answers with what is there. The batch id is each implementation's own.
 */

type Staged = Omit<StageResult, 'batchId'>

type ImportImplementation = {
  readonly name: string
  /** A port inside an import run with one waiting batch. */
  readonly make: () => Promise<Layer.Layer<Import>>
}

const waitingBatch = async () => {
  const batch = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'f'.repeat(64),
        filename: 'Companies.csv',
        sizeBytes: 100,
        sheet: 'Companies',
        sheets: ['Companies'],
        mode: 'records',
        rowCount: 0,
      })
      .returning({ id: importBatch.id })
  ).at(0)
  if (!batch) throw new Error('no batch')
  return batch.id
}

const IMPLEMENTATIONS: ReadonlyArray<ImportImplementation> = [
  {
    name: 'ImportLive',
    make: async () => {
      const batchId = await waitingBatch()
      // `ImportRun` is read when `stage` runs, as the file job's queue provides it.
      return Layer.effect(
        Import,
        Effect.gen(function* () {
          const inner = yield* Import
          return Import.of({
            stage: (grid) =>
              inner
                .stage(grid)
                .pipe(Effect.provideService(ImportRun, { batchId })),
          })
        }),
      ).pipe(
        Layer.provide(
          ImportLive({ id: randomUUID(), capabilityId: 'conformance' }),
        ),
      )
    },
  },
  {
    name: 'ImportTest',
    make: () => Promise.resolve(ImportTest().layer),
  },
]

const stage = (grid: ImportGrid) =>
  Effect.gen(function* () {
    const { staged, malformed, refused } = yield* (yield* Import).stage(grid)
    const result: Staged = { staged, malformed, refused }
    return result
  })

const GRID: ImportGrid = {
  columns: ['Name', 'Business model'],
  rows: [
    { ordinal: 1, cells: ['Acme', ['B2B', 'Marketplace']] },
    { ordinal: 2, cells: ['Beta', ['Health, Wellness']] },
    { ordinal: 3, cells: ['Gamma'] },
  ],
}

describe.each(IMPLEMENTATIONS)('Import — $name', (impl) => {
  it('stages every row of a clean grid', async () => {
    expect(await runOn(await impl.make(), stage(GRID))).toEqual({
      staged: 3,
      malformed: [],
      refused: [],
    })
  })

  it('lands a unit that does not decode alone, under its ordinal, and refuses one with no ordinal', async () => {
    const result = await runOn(
      await impl.make(),
      stage({
        columns: ['Name'],
        rows: [
          { ordinal: 1, cells: ['Acme'] },
          // A bundle's types do not survive the import boundary.
          JSON.parse('{ "ordinal": 2, "cells": [42] }'),
          JSON.parse('{ "ordinal": -1, "cells": ["Nowhere"] }'),
        ],
      }),
    )
    expect(result.staged).toBe(2)
    expect(result.malformed.map((m) => m.ordinal)).toEqual([2])
    expect(result.refused.map((r) => r.ordinal)).toEqual([-1])
  })

  it('writes nothing on a second stage and answers with what is there', async () => {
    const layer = await impl.make()
    await runOn(layer, stage(GRID))
    const again = await runOn(
      layer,
      stage({ columns: ['Other'], rows: [{ ordinal: 1, cells: ['x'] }] }),
    )
    expect(again.staged).toBe(3)
  })
})
