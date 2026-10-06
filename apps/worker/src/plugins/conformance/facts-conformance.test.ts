import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { enrichmentRecord, entity } from '@spaces/db/schema'
import { setValues } from '@spaces/core/writes/attributes/values'
import { FactsLive } from '@spaces/core/writes/ports/facts'
import { Facts } from '@spaces/sdk'
import type { FactValues, JsonObject } from '@spaces/sdk'
import { FactsTest } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { insertRow, noEnqueue, runOn, seedCompany } from './support'

/**
 * The Facts port's contract, over every implementation: fill blanks only.
 * A blank is written; a value a person set is refused and handed back as a
 * conflict, and stays; a value this integration wrote before is updated.
 */

type Subject = {
  readonly layer: Layer.Layer<Facts>
  readonly entityId: string
  /** The receipt a fill cites — one this integration stored. */
  readonly receiptId: string
  readonly valuesOf: () => Promise<JsonObject>
}

type FactsImplementation = {
  readonly name: string
  /** A company holding `human`'s values, set by a person. */
  readonly make: (human: JsonObject) => Promise<Subject>
}

const IMPLEMENTATIONS: ReadonlyArray<FactsImplementation> = [
  {
    name: 'FactsLive',
    make: async (human) => {
      const row = await insertRow()
      const entityId = await seedCompany('Facts Co')
      if (Object.keys(human).length > 0)
        await setValues({
          entityId,
          patch: human,
          actor: { type: 'user', id: FIXTURE_ACTOR.id },
        })
      const receipt = (
        await db
          .insert(enrichmentRecord)
          .values({
            entityId,
            integrationId: row.id,
            provider: 'conformance',
            raw: {},
          })
          .returning({ id: enrichmentRecord.id })
      ).at(0)
      if (!receipt) throw new Error('no receipt')
      return {
        layer: FactsLive(row).pipe(Layer.provide(noEnqueue)),
        entityId,
        receiptId: receipt.id,
        valuesOf: async () =>
          (
            await db
              .select({ values: entity.values })
              .from(entity)
              .where(eq(entity.id, entityId))
          ).at(0)?.values ?? {},
      }
    },
  },
  {
    name: 'FactsTest',
    make: (human) => {
      const entityId = 'entity-1'
      const facts = FactsTest({ human: { [entityId]: human } })
      return Promise.resolve({
        layer: facts.layer,
        entityId,
        receiptId: 'receipt-1',
        valuesOf: () =>
          Promise.resolve({ ...human, ...facts.values.get(entityId) }),
      })
    },
  },
]

const fill = (record: Subject, values: FactValues) =>
  runOn(
    record.layer,
    Effect.gen(function* () {
      return yield* (yield* Facts).fill({
        entityId: record.entityId,
        values,
        receiptId: record.receiptId,
      })
    }),
  )

describe.each(IMPLEMENTATIONS)('Facts — $name', (impl) => {
  it('writes blanks and refuses nothing', async () => {
    const record = await impl.make({})
    const result = await fill(record, {
      description: 'Warehouse robots.',
      location: 'Pune, India',
    })
    expect(result.conflicts).toEqual([])
    expect(await record.valuesOf()).toMatchObject({
      description: 'Warehouse robots.',
      location: 'Pune, India',
    })
  })

  it('refuses a value a person set, hands it back, and writes the rest', async () => {
    const record = await impl.make({ founded_year: 1990 })
    const result = await fill(record, {
      founded_year: 2015,
      location: 'Berlin, Germany',
    })
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 1990, proposed: 2015 },
    ])
    expect(await record.valuesOf()).toMatchObject({
      founded_year: 1990,
      location: 'Berlin, Germany',
    })
  })

  it('updates a value it wrote itself', async () => {
    const record = await impl.make({})
    await fill(record, { description: 'First take.' })
    const result = await fill(record, { description: 'Second take.' })
    expect(result.conflicts).toEqual([])
    expect((await record.valuesOf()).description).toBe('Second take.')
  })
})
