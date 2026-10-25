import { Cause, Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { importBatch, integration, objectDef } from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'
import { enqueued } from '#/test/queue-stub'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { beginImportMappingProgram } from './mapping'
import { loadImportBatchProgram, stageImportProgram } from './stage'

/**
 * A dropped file an enabled dialect plugin accepts: the batch is born
 * waiting with no rows, the plugin's file job is sent with the stored blob,
 * and the mapping step waits for the rows. The plugin itself, the live port,
 * the reader's run and the preview are tested in the worker.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ME = FIXTURE_ACTOR.id
const CSV = 'Name,Business model\nAcme,"B2B,Marketplace"\n'

const manifest = {
  manifestVersion: 1,
  id: 'airtable',
  version: '0.1.0',
  sdk: '^1.1',
  name: 'Airtable',
  description: 'Reads an Airtable CSV export.',
  settings: {},
  jobs: {
    stage: {
      trigger: 'file',
      uses: ['Import', 'Log'],
      accepts: { filename: '-[^\\\\/]+ view\\.csv$' },
    },
  },
}

beforeEach(() => {
  enqueued.length = 0
})

const companies = async () => {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'companies'))
  ).at(0)
  if (!row) throw new Error('companies missing')
  return row.id
}

const stage = async (filename: string) => {
  const result = await Effect.runPromise(
    stageImportProgram({
      filename,
      bytes: new TextEncoder().encode(CSV),
      mime: 'text/csv',
      mode: 'records',
      targetObjectId: await companies(),
      allowDuplicate: true,
      userId: ME,
    }),
  )
  if (result.kind !== 'staged') throw new Error('not staged')
  return result.batchId
}

describe('a dropped file a dialect plugin accepts', () => {
  it('is staged waiting, its file job sent with the blob, and its mapping held until the rows arrive', async () => {
    const row = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'airtable',
          version: '0.1.0',
          enabled: true,
          status: 'enabled',
          manifest,
        })
        .returning({ id: integration.id })
    ).at(0)
    if (!row) throw new Error('no row')

    const batchId = await stage('Companies-Grid view.csv')
    const batch = (
      await db.select().from(importBatch).where(eq(importBatch.id, batchId))
    ).at(0)
    expect(batch).toMatchObject({
      rowCount: 0,
      status: 'staged',
      sheet: 'Companies-Grid view',
      header: null,
    })
    expect(enqueued).toEqual([
      {
        name: 'plugin.airtable.stage',
        data: {
          batchId,
          blobSha: batch?.blobSha,
          filename: 'Companies-Grid view.csv',
          mime: 'text/csv',
        },
      },
    ])
    expect(
      (await Effect.runPromise(loadImportBatchProgram(batchId))).reading,
    ).toEqual({ status: 'waiting', error: null })

    const mapping = await Effect.runPromiseExit(
      beginImportMappingProgram(batchId),
    )
    expect(
      Exit.isFailure(mapping) ? Cause.squash(mapping.cause) : null,
    ).toMatchObject({
      reason: 'This file is still being read by its import plugin',
    })

    // A name the plugin does not accept, and the plugin disabled: plain.
    const plain = await stage('companies.csv')
    await db
      .update(integration)
      .set({ enabled: false })
      .where(eq(integration.id, row.id))
    const fallback = await stage('Companies-Grid view.csv')
    expect(enqueued).toHaveLength(1)
    for (const id of [plain, fallback]) {
      const view = await Effect.runPromise(loadImportBatchProgram(id))
      expect(view).toMatchObject({ rowCount: 1, reading: null })
    }
    if (batch) await storage().delete(batch.blobSha)
  })
})
