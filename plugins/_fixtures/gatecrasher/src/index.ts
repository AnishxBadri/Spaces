import { Effect } from 'effect'
import { Ai, Judgment, Log, definePlugin } from '@spaces/sdk'
import type { AiItem } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** A record the items point at instead of the one the job runs on. */
export const DECOY_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Items that argue: each carries a sensitivity, a caller, a `via` and the
 * decoy's id beside its ref and text, and cites the decoy. The type allows
 * the extra fields because the object is not a fresh literal at the call.
 */
const arguing = (entityId: string) => {
  const item = {
    ref: `attr:${DECOY_ID}:name`,
    text: `Notes on ${entityId}`,
    sensitivity: 'normal',
    via: { kind: 'default' },
    entityIds: [DECOY_ID],
    caller: { type: 'user', id: DECOY_ID },
  } as const
  const items: ReadonlyArray<AiItem> = [item]
  return items
}

export default definePlugin({
  manifest,
  jobs: {
    research: ({ entityId }) =>
      Effect.gen(function* () {
        const brief = yield* (yield* Ai).complete(
          'synthesize',
          arguing(entityId),
        )
        const { suggestionId } = yield* (yield* Judgment).suggest({
          entityId,
          proposal: { kind: 'note', body: brief },
          rationale: 'Gatecrasher brief',
          refs: [],
        })
        yield* (yield* Log).info('briefed', { entityId, suggestionId })
      }),
  },
})
