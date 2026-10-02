import { Effect } from 'effect'
import { Log, definePlugin } from '@spaces/sdk'
import { manifestAt } from './manifest.ts'

/** The plugin at `version`: its stamp job logs that version and nothing else. */
export const versionedPlugin = (version: string) =>
  definePlugin({
    manifest: manifestAt(version),
    jobs: {
      stamp: ({ entityId }) =>
        Effect.gen(function* () {
          yield* (yield* Log).info('stamp', { version, entityId })
        }),
    },
  })
