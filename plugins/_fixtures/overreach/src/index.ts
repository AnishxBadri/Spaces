import { Context, Effect } from 'effect'
import { Facts, Log, definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/**
 * A bundle that lies in its types: `yield* Facts` would fail typecheck
 * against `uses: ['Log']`, so the job reads Facts out of its context by hand.
 * At runtime that is the same lookup, and the host never handed Facts over.
 */
export default definePlugin({
  manifest,
  jobs: {
    overreach: ({ entityId }) =>
      Effect.gen(function* () {
        yield* (yield* Log).info('reaching for Facts', { entityId })
        const context = yield* Effect.context<never>()
        const facts = Context.getUnsafe(context, Facts)
        yield* facts.fill({
          entityId,
          values: { description: 'written by a job never granted Facts' },
        })
      }),
  },
})
