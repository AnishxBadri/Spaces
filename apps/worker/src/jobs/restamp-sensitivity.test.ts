import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import {
  restampSensitivity,
  restampSensitivityData,
  runRestampSensitivity,
} from './restamp-sensitivity'

/**
 * sensitivity.restamp's wrapper view: the payload, the ledger ref, and that a
 * run writes what the live resolver says. Which write paths send it is
 * asserted beside them (apps/web's `restamp.test.ts`).
 */

async function aDocWithChunk(sensitiveFlag: boolean, stamped: boolean) {
  const row = (
    await db
      .insert(entity)
      .values({
        kind: 'document',
        canonicalName: 'memo.pdf',
        sensitive: sensitiveFlag,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  // A stamped fixture row: the job is what corrects it.
  await db.insert(chunk).values({
    entityId: row.id,
    sourceKind: 'document',
    sourceKey: '',
    idx: 0,
    text: 'memo',
    sensitive: stamped,
  })
  return row.id
}

const stampOf = async (entityId: string) =>
  (
    await db
      .select({ sensitive: chunk.sensitive })
      .from(chunk)
      .where(eq(chunk.entityId, entityId))
  ).map((r) => r.sensitive)

describe('sensitivity.restamp', () => {
  it('is registered on its own queue, keyed to the entity for the ledger', () => {
    expect(restampSensitivity.name).toBe(QUEUES.restampSensitivity)
    const id = randomUUID()
    expect(restampSensitivity.refs?.({ entityId: id })).toEqual({
      entityId: id,
    })
    expect(restampSensitivityData.safeParse({ entityId: 'x' }).success).toBe(
      false,
    )
  })

  it('lowers a stale stamp when nothing keeps the entity sensitive', async () => {
    const id = await aDocWithChunk(false, true)
    await Effect.runPromise(runRestampSensitivity({ entityId: id }))
    expect(await stampOf(id)).toEqual([false])
  })

  it('keeps the stamp when the entity is still sensitive', async () => {
    const id = await aDocWithChunk(true, true)
    await Effect.runPromise(runRestampSensitivity({ entityId: id }))
    expect(await stampOf(id)).toEqual([true])
  })

  it('completes when the entity is gone', async () => {
    await expect(
      Effect.runPromise(runRestampSensitivity({ entityId: randomUUID() })),
    ).resolves.toBeUndefined()
  })
})
