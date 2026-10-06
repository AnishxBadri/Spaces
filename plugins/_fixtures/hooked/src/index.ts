import { Effect } from 'effect'
import { z } from 'zod'
import { Content, JobPermanent, Log, definePlugin } from '@spaces/sdk'
import type { SignalClaim } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** The delivery this fixture's provider sends — what it reads and nothing more. */
const delivery = z.object({
  entityId: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1).optional(),
})

/** The pure half: one delivery → one signal claim. */
export const toSignal = (payload: unknown, receivedAt: string): SignalClaim => {
  const d = delivery.parse(payload)
  return {
    _tag: 'signal',
    entityId: d.entityId,
    kind: 'call',
    title: d.title,
    ...(d.url === undefined ? {} : { url: d.url }),
    publishedAt: receivedAt,
  }
}

export default definePlugin({
  manifest,
  jobs: {
    ingest: ({ payload, receivedAt }) =>
      Effect.gen(function* () {
        const claim = yield* Effect.try({
          try: () => toSignal(payload, receivedAt),
          catch: () =>
            new JobPermanent({
              reason: 'the delivery is not { entityId, title }',
            }),
        })
        const { signalId } = yield* (yield* Content).emitSignal(claim)
        yield* (yield* Log).info('ingested', { signalId })
      }),
  },
})
