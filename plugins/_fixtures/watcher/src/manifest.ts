import { Effect, Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** What one watch holds: how far it may go, and whether to fail on purpose. */
export const lensSettings = Schema.Struct({
  cap: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(10)),
  ),
  fail: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
})

/** One watch job granted Spaces and Log. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'watcher',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'Watcher',
  description:
    'A loader fixture: a watch job that reads its space brief, logs it and keeps a run count as its state.',
  settings: Schema.Struct({}),
  jobs: {
    lens: {
      trigger: 'watch',
      uses: ['Spaces', 'Log'],
      settings: lensSettings,
    },
  },
})
