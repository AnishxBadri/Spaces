import { Effect } from 'effect'
import type { Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ReceiptsLive } from '@spaces/core/writes/ports/receipts'
import { Receipts } from '@spaces/sdk'
import type { ReceiptClaim } from '@spaces/sdk'
import { ReceiptsTest } from '@spaces/sdk/testing'
import { insertRow, runOn, seedCompany } from './support'

/**
 * The Receipts port's contract, over every implementation: every `store`
 * keeps one receipt and hands back its own id — the anchor a fill cites —
 * even for an identical payload.
 */

type ReceiptsImplementation = {
  readonly name: string
  readonly make: () => Promise<{
    readonly layer: Layer.Layer<Receipts>
    readonly entityId: string
  }>
}

const IMPLEMENTATIONS: ReadonlyArray<ReceiptsImplementation> = [
  {
    name: 'ReceiptsLive',
    make: async () => ({
      layer: ReceiptsLive(await insertRow()),
      entityId: await seedCompany('Receipts Co'),
    }),
  },
  {
    name: 'ReceiptsTest',
    make: () =>
      Promise.resolve({ layer: ReceiptsTest().layer, entityId: 'entity-1' }),
  },
]

const store = (claim: ReceiptClaim) =>
  Effect.gen(function* () {
    return (yield* (yield* Receipts).store(claim)).receiptId
  })

describe.each(IMPLEMENTATIONS)('Receipts — $name', (impl) => {
  it('hands back a distinct id for every receipt, identical payloads included', async () => {
    const { layer, entityId } = await impl.make()
    const claim: ReceiptClaim = {
      entityId,
      raw: { organization: { name: 'Receipts Co' } },
      creditsUsed: 1,
    }
    const first = await runOn(layer, store(claim))
    const second = await runOn(layer, store(claim))
    const nothing = await runOn(
      layer,
      store({ entityId, raw: {}, creditsUsed: 0 }),
    )
    expect(typeof first).toBe('string')
    expect(new Set([first, second, nothing]).size).toBe(3)
  })
})
