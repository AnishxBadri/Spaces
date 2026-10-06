import { Effect } from 'effect'
import { PluginDb, definePlugin } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** `note` names its table unqualified: PluginDb resolves it in plugin_tabled. */
export default definePlugin({
  manifest,
  jobs: {
    note: ({ entityId }) =>
      Effect.gen(function* () {
        const db = yield* PluginDb
        yield* db.query('insert into note (entity_id, body) values ($1, $2)', [
          entityId,
          'seen',
        ])
      }),
  },
})
