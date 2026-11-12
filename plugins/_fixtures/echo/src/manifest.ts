import { Effect, Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/**
 * Authored once, here. The build emits it as dist/manifest.json with
 * `settings` as JSON Schema; nothing else spells it.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'echo',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'Echo',
  description:
    'A fixture plugin: an action job that echoes its input, and one that maps a recorded provider payload to claims.',
  settings: Schema.Struct({
    greeting: Schema.String.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed('hello')),
    ),
    times: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(1)),
    ),
  }),
  jobs: {
    echo: { trigger: 'action', uses: ['Log'] },
    // Read the domain → ask the provider → resolve → store the receipt →
    // fill (`toClaims` is the pure half: payload in, claims out).
    enrich: {
      trigger: 'action',
      uses: ['Read', 'Http', 'Identity', 'Receipts', 'Facts', 'Log'],
    },
  },
  actions: [
    { id: 'echo', label: 'Echo', on: 'company', job: 'echo' },
    { id: 'enrich', label: 'Enrich (fixture)', on: 'company', job: 'enrich' },
  ],
})
