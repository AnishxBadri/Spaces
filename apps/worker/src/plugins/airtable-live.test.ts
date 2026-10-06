import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import {
  attribute,
  entity,
  importBatch,
  importRow,
  integration,
  objectDef,
} from '@spaces/db/schema'
import { MALFORMED_ROW } from '@spaces/core/import/plan'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { ImportLive, ImportRun } from '@spaces/core/writes/ports/import'
import { storage } from '@spaces/core/writes/storage'
import { Import, JobPermanent } from '@spaces/sdk'
import { fileJobData } from '@spaces/core/import/dialect'
import { enqueued } from '#web/test/queue-stub'
import { beginImportMappingProgram } from '#web/lib/import/mapping'
import { planImportProgram } from '#web/lib/import/plan'
import { commitImportProgram } from '#web/lib/import/commit'
import {
  loadImportBatchProgram,
  stageImportProgram,
} from '#web/lib/import/stage'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { runJob } from '../run-job'
import type { JobHost } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { LoadedPlugin } from './loader'
import { pluginQueues, runFileJob } from './queues'

/**
 * The Airtable dialect plugin end to end on the live ports, over the test
 * database: the real bundle loaded as boot loads it, a dropped export routed
 * to it by the import wizard's stage, its file job run from the queued data
 * as the worker runs it, and the batch it staged previewed beside the same
 * data in a plain CSV. Then the plugin disabled: the same file takes the
 * plain path. And a malformed unit of output fails its own row only.
 */

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const ME = FIXTURE_ACTOR.id
const fixtures = fileURLToPath(
  new URL('../../../../plugins/airtable/', import.meta.url),
)
const AIRTABLE = 'Companies-Grid view.csv'
const exportBytes = readFileSync(path.join(fixtures, 'fixtures', AIRTABLE))
const plainBytes = readFileSync(
  path.join(fixtures, 'fixtures', 'companies.csv'),
)

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []
const blobs = new Set<string>()

afterAll(async () => {
  for (const host of hosts) await Effect.runPromise(host.shutdown())
  for (const sha of blobs) await storage().delete(sha)
})

beforeEach(() => {
  enqueued.length = 0
})

/** The built bundle installed as `current`, its row enabled, then loaded. */
const loadAirtable = async () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-airtable-')),
    'plugins',
  )
  const dir = path.join(root, 'airtable', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'dist', file), path.join(dir, file))
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'airtable', version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const plugin = loaded.find((p) => p.integrationId === row.id)
  if (!plugin) throw new Error('airtable did not load')
  return { row, plugin }
}

const wire = async (plugin: LoadedPlugin) => {
  const host = makePluginHost({ enqueue: NoEnqueue, sink: () => undefined })
  hosts.push(host)
  const verdicts = await Effect.runPromise(host.wire([plugin]))
  expect(verdicts.map((v) => v.line)).toEqual([
    '[plugins] airtable: wired stage',
  ])
  return host
}

const companiesId = async () => {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'companies'))
  ).at(0)
  if (!row) throw new Error('companies missing')
  return row.id
}

const stage = async (filename: string, bytes: Uint8Array) => {
  const result = await Effect.runPromise(
    stageImportProgram({
      filename,
      bytes,
      mime: 'text/csv',
      mode: 'records',
      targetObjectId: await companiesId(),
      allowDuplicate: true,
      userId: ME,
    }),
  )
  if (result.kind !== 'staged') throw new Error('not staged')
  const batch = (
    await db
      .select({ blobSha: importBatch.blobSha })
      .from(importBatch)
      .where(eq(importBatch.id, result.batchId))
  ).at(0)
  if (batch) blobs.add(batch.blobSha)
  return result.batchId
}

/** Every row's plan, with each cell's raw text dropped: the verdicts and reasons. */
const plansOf = async (batchId: string) => {
  const rows = await db
    .select({ rowNum: importRow.rowNum, plan: importRow.plan })
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(asc(importRow.rowNum))
  return JSON.parse(
    JSON.stringify(rows, (key, value: unknown) =>
      key === 'raw' ? undefined : value,
    ),
  )
}

const mapAndPlan = async (batchId: string) => {
  await Effect.runPromise(beginImportMappingProgram(batchId))
  await Effect.runPromise(planImportProgram(batchId))
}

describe('the airtable dialect plugin, on the live ports', () => {
  it('is picked up on drop, previews identically to the plain CSV, commits, and falls back when disabled', async () => {
    await Effect.runPromise(
      createAttributeProgram({
        objectKind: 'company',
        name: 'Deck',
        type: 'url',
        createdBy: ME,
      }),
    )
    const { row, plugin } = await loadAirtable()
    const host = await wire(plugin)

    // The drop: routed to the plugin, the batch born waiting.
    const airtableBatch = await stage(AIRTABLE, new Uint8Array(exportBytes))
    expect(enqueued).toHaveLength(1)
    const sent = enqueued.at(0)
    expect(sent?.name).toBe('plugin.airtable.stage')
    const waiting = await Effect.runPromise(
      loadImportBatchProgram(airtableBatch),
    )
    expect(waiting.rowCount).toBe(0)
    expect(waiting.reading).toEqual({ status: 'waiting', error: null })

    // The worker runs the queued job from its data.
    const queue = pluginQueues(plugin.manifest, plugin.jobs).at(0)
    if (!queue) throw new Error('no queue')
    const summary = await Effect.runPromise(
      runFileJob(row.id, queue, host.invoke, fileJobData.parse(sent?.data)),
    )
    expect(summary).toBe(
      `batch ${airtableBatch} · 30 rows staged by plugin.airtable.stage`,
    )

    const plainBatch = await stage('companies.csv', new Uint8Array(plainBytes))
    expect(enqueued).toHaveLength(1)

    await mapAndPlan(airtableBatch)
    await mapAndPlan(plainBatch)
    const [mappedA, mappedB] = await Promise.all(
      [airtableBatch, plainBatch].map(async (id) =>
        (
          await db
            .select({ mapping: importBatch.mapping })
            .from(importBatch)
            .where(eq(importBatch.id, id))
        ).at(0),
      ),
    )
    expect(mappedA).toEqual(mappedB)
    const plans = await plansOf(airtableBatch)
    expect(plans).toHaveLength(30)
    expect(plans).toEqual(await plansOf(plainBatch))

    // Multi-selects land on the existing options; an unknown one is refused.
    const model = (
      await db
        .select({ id: attribute.id, options: attribute.options })
        .from(attribute)
        .where(eq(attribute.slug, 'business_model'))
    ).at(0)
    if (!model) throw new Error('business_model missing')
    expect(plans.at(1)?.plan.patch[model.id]).toEqual(['b2b', 'marketplace'])
    // Ember Payments, `B2B,Fintech`: the cell is refused whole, never minted.
    expect(plans.at(5)?.plan.skippedCells).toContainEqual({
      column: 2,
      reason: 'not read',
    })
    expect(plans.at(5)?.plan.patch).not.toHaveProperty(model.id)

    const committed = await Effect.runPromise(
      commitImportProgram({
        batchId: airtableBatch,
        userId: ME,
        onlyFailed: false,
      }),
    )
    expect(committed).toBeDefined()
    const written = await db
      .select({ entityId: importRow.entityId })
      .from(importRow)
      .where(eq(importRow.batchId, airtableBatch))
    expect(written.filter((r) => r.entityId !== null)).toHaveLength(30)
    expect(
      (
        await db
          .select({ options: attribute.options })
          .from(attribute)
          .where(eq(attribute.id, model.id))
      ).at(0)?.options,
    ).toEqual(model.options)
    const acmeRecord = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(
          and(
            eq(entity.canonicalName, 'Acme Fusion'),
            isNull(entity.mergedIntoId),
          ),
        )
    ).at(0)
    expect(acmeRecord?.values).toMatchObject({
      business_model: ['b2b', 'marketplace'],
      funding_stage: 'series_a',
      location: 'Boston, MA',
      founded_year: 2021,
    })

    // Disabled: the same file is a plain CSV with an explicit mapping step.
    await db
      .update(integration)
      .set({ enabled: false })
      .where(eq(integration.id, row.id))
    const fallback = await stage(AIRTABLE, new Uint8Array(exportBytes))
    expect(enqueued).toHaveLength(1)
    const plain = await Effect.runPromise(loadImportBatchProgram(fallback))
    expect(plain.reading).toBeNull()
    expect(plain.rowCount).toBe(30)
    expect(plain.preview.at(1)?.cells.at(7)).toBe(
      'acme-fusion-deck.pdf (https://dl.airtable.com/.attachments/att001/acme-fusion-deck.pdf)',
    )
  })

  it('names why on the waiting batch when the reader fails for good', async () => {
    const { row, plugin } = await loadAirtable()
    const host = await wire(plugin)
    const batchId = await stage('Empty-Grid view.csv', new Uint8Array([10]))
    const data = fileJobData.parse(enqueued.at(0)?.data)
    const queue = pluginQueues(plugin.manifest, plugin.jobs).at(0)
    if (!queue) throw new Error('no queue')
    const settled: Array<string> = []
    const jobHost: JobHost = {
      complete: async () => void settled.push('complete'),
      fail: async () => void settled.push('fail'),
      failTerminal: async () => void settled.push('failTerminal'),
      send: async () => undefined,
    }
    await runJob(
      {
        name: queue.queue,
        schema: fileJobData,
        run: (input) => runFileJob(row.id, queue, host.invoke, input),
        refs: () => ({ integrationId: row.id }),
      },
      { host: jobHost, layer: Layer.empty },
    )([fakeJob(queue.queue, data)])
    expect(settled).toEqual(['failTerminal'])
    const view = await Effect.runPromise(loadImportBatchProgram(batchId))
    expect(view.rowCount).toBe(0)
    expect(view.reading).toEqual({
      status: 'failed',
      error: 'Empty-Grid view.csv has no header row',
    })
  })

  it('withholds Import from a job whose manifest does not grant it: a permanent failure, nothing staged', async () => {
    const { row, plugin } = await loadAirtable()
    const stageJob = plugin.manifest.jobs.stage
    const host = await wire({
      ...plugin,
      manifest: {
        ...plugin.manifest,
        jobs: { stage: { ...stageJob, uses: ['Log'] } },
      },
    })
    expect(host.granted(row.id, 'stage')).toEqual(['Log'])
    const exit = await Effect.runPromiseExit(
      host.invoke(row.id, 'stage', {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(exportBytes))
            controller.close()
          },
        }),
        filename: AIRTABLE,
        mime: 'text/csv',
      }),
    )
    const error = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.findErrorOption(exit.cause))
      : null
    expect(error).toBeInstanceOf(JobPermanent)
    expect(error?.reason).toBe(
      'airtable.stage used Import, which its manifest does not grant it: Service not found: spaces/sdk/Import',
    )
  })

  it('fails a malformed unit of plugin output on its own row; the rest of the batch commits', async () => {
    const batchId = (
      await db
        .insert(importBatch)
        .values({
          blobSha: 'e'.repeat(64),
          filename: 'Deals-Grid view.csv',
          sizeBytes: 100,
          sheet: 'Deals-Grid view',
          sheets: ['Deals-Grid view'],
          mode: 'records',
          targetObjectId: await companiesId(),
          rowCount: 0,
          createdBy: ME,
        })
        .returning({ id: importBatch.id })
    ).at(0)?.id
    if (!batchId) throw new Error('no batch')
    const staged = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Import).stage({
          columns: ['Name', 'Business model'],
          rows: [
            { ordinal: 1, cells: ['Alder Labs', ['B2B', 'Hardware']] },
            // A bundle's types do not survive the import boundary.
            JSON.parse('{ "ordinal": 2, "cells": [{ "not": "a cell" }] }'),
            { ordinal: 3, cells: ['Birch Works', 'B2C'] },
          ],
        })
      }).pipe(
        Effect.provide(
          ImportLive({ id: 'airtable', capabilityId: 'airtable' }),
        ),
        Effect.provideService(ImportRun, { batchId }),
      ),
    )
    expect(staged.malformed).toEqual([
      { ordinal: 2, reason: 'cell 1 is neither text nor a list of text' },
    ])
    await mapAndPlan(batchId)
    const plans = await db
      .select({ rowNum: importRow.rowNum, plan: importRow.plan })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum))
    expect(plans.map((p) => p.plan?.verdict)).toEqual([
      'create',
      'no-land',
      'create',
    ])
    expect(plans.at(1)?.plan?.errors).toEqual([
      { column: 0, raw: '', reason: MALFORMED_ROW },
    ])
    await Effect.runPromise(
      commitImportProgram({ batchId, userId: ME, onlyFailed: false }),
    )
    const rows = await db
      .select({ rowNum: importRow.rowNum, entityId: importRow.entityId })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum))
    expect(rows.map((r) => r.entityId !== null)).toEqual([true, false, true])
    const batch = (
      await db
        .select({ status: importBatch.status })
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
    ).at(0)
    expect(batch?.status).toBe('committed')
  })
})

const epoch = new Date(0)

/** One pg-boss job as `runJob` is handed it, on its final attempt. */
function fakeJob(name: string, data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'exclusive',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}
