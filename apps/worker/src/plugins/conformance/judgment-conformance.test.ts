import { Effect } from 'effect'
import type { Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { JudgmentLive } from '@spaces/core/writes/ports/judgment'
import { Judgment } from '@spaces/sdk'
import type { JudgmentClaim } from '@spaces/sdk'
import { JudgmentTest } from '@spaces/sdk/testing'
import { insertRow, runOn, seedCompany } from './support'

/**
 * The Judgment port's contract, over every implementation: a proposal goes
 * to the review inbox and comes back as its suggestion's id, and two
 * different proposals are two suggestions. (Collapsing an identical open
 * attribute proposal is the live lane's index, not part of the contract.)
 */

type JudgmentImplementation = {
  readonly name: string
  readonly make: () => Promise<{
    readonly layer: Layer.Layer<Judgment>
    readonly entityId: string
  }>
}

const IMPLEMENTATIONS: ReadonlyArray<JudgmentImplementation> = [
  {
    name: 'JudgmentLive',
    make: async () => ({
      layer: JudgmentLive(await insertRow()),
      entityId: await seedCompany('Judgment Co'),
    }),
  },
  {
    name: 'JudgmentTest',
    make: () =>
      Promise.resolve({ layer: JudgmentTest().layer, entityId: 'entity-1' }),
  },
]

const suggest = (claim: JudgmentClaim) =>
  Effect.gen(function* () {
    return (yield* (yield* Judgment).suggest(claim)).suggestionId
  })

describe.each(IMPLEMENTATIONS)('Judgment — $name', (impl) => {
  it('files a proposal and hands back its suggestion', async () => {
    const { layer, entityId } = await impl.make()
    const note = await runOn(
      layer,
      suggest({
        entityId,
        proposal: { kind: 'note', body: 'Their CTO left in March.' },
        rationale: 'Two sources report the departure.',
        refs: [],
      }),
    )
    const value = await runOn(
      layer,
      suggest({
        entityId,
        proposal: { kind: 'attribute', slug: 'founded_year', value: 2019 },
        rationale: 'The registry lists 2019.',
        refs: [],
      }),
    )
    expect(typeof note).toBe('string')
    expect(value).not.toBe(note)
  })
})
