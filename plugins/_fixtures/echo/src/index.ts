import { Effect } from 'effect'
import { definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

export default definePlugin({
  manifest,
  jobs: {
    echo: (input: { entityId: string }) => Effect.succeed(input),
  },
})
