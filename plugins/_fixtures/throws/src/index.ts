import { Effect } from 'effect'
import { Log, definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/**
 * `boom` throws before it returns an Effect — the uncaught throw contract 2
 * is about, which the host turns into a failed job and never a dead worker.
 */
export default definePlugin({
  manifest,
  jobs: {
    boom: ({ entityId }) => {
      throw new Error(`throws: boom on ${entityId}`)
    },
    fine: ({ entityId }) =>
      Effect.gen(function* () {
        yield* (yield* Log).info('fine', { entityId })
      }),
  },
})
