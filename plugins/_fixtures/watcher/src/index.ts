import { Effect } from 'effect'
import {
  JobPermanent,
  Log,
  Spaces,
  definePlugin,
  watchSettingsOf,
} from '@spaces/sdk'
import { manifest } from './manifest.ts'

export default definePlugin({
  manifest,
  jobs: {
    lens: (input) =>
      Effect.gen(function* () {
        const settings = yield* watchSettingsOf(manifest.jobs.lens, input)
        const brief = yield* (yield* Spaces).brief(input.spaceId)
        yield* (yield* Log).info('brief', { watchId: input.watchId, brief })
        if (settings.fail)
          return yield* new JobPermanent({ reason: 'failed on purpose' })
        const runs = input.state?.runs
        return {
          state: {
            runs: typeof runs === 'number' ? runs + 1 : 1,
            members: brief.memberCount,
          },
        }
      }),
  },
})
