import { Effect } from 'effect'
import { Log, definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

export default definePlugin({
  manifest,
  jobs: {
    ping: ({ entityId }) =>
      Effect.gen(function* () {
        yield* (yield* Log).info('ping', { entityId })
      }),
  },
})
