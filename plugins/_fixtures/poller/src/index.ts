import { Effect } from 'effect'
import { z } from 'zod'
import { Ai, Log, definePlugin } from '@spaces/sdk'
import type { AiItem } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** One polled item, as a poller would hand it to the model. */
const ITEMS: ReadonlyArray<AiItem> = [
  {
    ref: 'event:feed-item-1',
    text: 'Northwind Robotics raises a $4M seed round led by Example Ventures.',
  },
]

export const topic = z.object({
  topic: z.enum(['funding', 'hiring', 'product', 'other']),
})

export default definePlugin({
  manifest,
  jobs: {
    classify: ({ cursor }) =>
      Effect.gen(function* () {
        const answer = yield* (yield* Ai).complete('classify', ITEMS, topic)
        yield* (yield* Log).info('classified', { topic: answer.topic })
        return { nextCursor: cursor }
      }),
    // A poller may classify and nothing else: the port refuses this call.
    brief: ({ cursor }) =>
      Effect.gen(function* () {
        const brief = yield* (yield* Ai).complete('synthesize', ITEMS)
        yield* (yield* Log).info('briefed', { brief })
        return { nextCursor: cursor }
      }),
  },
})
