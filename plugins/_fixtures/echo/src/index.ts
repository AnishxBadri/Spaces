import { Effect } from 'effect'
import { definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

export default definePlugin({
  manifest,
  jobs: {
    echo: (input) => Effect.succeed(input).pipe(Effect.asVoid),
    enrich: {
      // The port calls land with sdk-5, which declares the ports and runs
      // this job end to end on the test Layers; until then only the pure
      // mapping (src/map.ts) exists, snapshot-tested on its own.
      run: () => Effect.void,
      // One organization lookup costs one provider credit (D53).
      cost: ({ entityIds }) => ({ credits: entityIds.length }),
    },
  },
})
