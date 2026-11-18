import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { importBatch, objectDef, user } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { commitImportProgram } from '#/lib/import/commit'
import {
  beginImportMappingProgram,
  mapImportColumnProgram,
} from '#/lib/import/mapping'
import { planImportProgram } from '#/lib/import/plan'
import {
  defineImportBatchProgram,
  discardImportBatchProgram,
  stageImportProgram,
} from '#/lib/import/stage'
import { todayAttentionProgram } from './attention'

/**
 * Today's `import` rows: the reader's own batches still `staged`. A batch
 * staged through the real upload is on the ledger; planning it takes it off,
 * a mapping change brings it back, and a commit or a discard takes it off
 * for good.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ME = FIXTURE_ACTOR.id
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@fund.example',
  emailVerified: true,
}

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

/** The batch ids on the reader's Today, in ledger order. */
async function todayImports(userId = ME): Promise<Array<string>> {
  const out = await run(todayAttentionProgram(userId, new Date()))
  return out.imports.map((b) => b.batchId)
}

async function companies(): Promise<string> {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'companies'))
  ).at(0)
  if (!row) throw new Error('companies object missing')
  return row.id
}

async function stage(
  filename: string,
  csv: string,
  userId = ME,
): Promise<string> {
  const out = await run(
    stageImportProgram({
      filename,
      bytes: new TextEncoder().encode(csv),
      mime: 'text/csv',
      mode: 'records',
      targetObjectId: null,
      allowDuplicate: true,
      userId,
    }),
  )
  if (out.kind !== 'staged') throw new Error(`${filename} was not staged`)
  return out.batchId
}

async function statusOf(batchId: string) {
  return (
    await db
      .select({ status: importBatch.status })
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
  ).at(0)?.status
}

describe("Today's staged imports", () => {
  it('lists a staged batch with its file and rows, and drops it once committed', async () => {
    const batchId = await stage(
      'pipeline.csv',
      'Name,Domain\nAcme Today,acme-today.com\nBeta Today,beta-today.com\n',
    )
    const listed = (await run(todayAttentionProgram(ME, new Date()))).imports
    expect(listed).toEqual([
      {
        batchId,
        filename: 'pipeline.csv',
        rowCount: 2,
        stagedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ])

    await run(
      defineImportBatchProgram({
        batchId,
        mode: 'records',
        targetObjectId: await companies(),
      }),
    )
    await run(beginImportMappingProgram(batchId))
    await run(planImportProgram(batchId))
    expect(await statusOf(batchId)).toBe('planned')
    expect(await todayImports()).toEqual([])

    // A mapping change throws the plan away: the batch is staged again.
    await run(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: { target: 'ignore' },
      }),
    )
    expect(await todayImports()).toEqual([batchId])

    await run(planImportProgram(batchId))
    await run(commitImportProgram({ batchId, userId: ME, onlyFailed: false }))
    expect(await statusOf(batchId)).toBe('committed')
    expect(await todayImports()).toEqual([])
  })

  it('drops a discarded batch, oldest first until then', async () => {
    const first = await stage('first.csv', 'Name\nOne\n')
    const second = await stage('second.csv', 'Name\nTwo\n')
    expect(await todayImports()).toEqual([first, second])

    await run(discardImportBatchProgram(first))
    expect(await todayImports()).toEqual([second])
  })

  it("leaves out a teammate's staged batch", async () => {
    await db.insert(user).values(TEAMMATE)
    const theirs = await stage('theirs.csv', 'Name\nTheirs\n', TEAMMATE.id)
    expect(await todayImports()).not.toContain(theirs)
    expect(await todayImports(TEAMMATE.id)).toEqual([theirs])
  })
})
