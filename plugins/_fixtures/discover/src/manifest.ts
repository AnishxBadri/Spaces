import { Effect, Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** One company a watch run hands back. */
const candidate = Schema.Struct({
  name: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  evidence: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  subspaceHint: Schema.optionalKey(Schema.String),
})

/** What one watch holds: the candidates it finds, and whether to overreach. */
export const findSettings = Schema.Struct({
  candidates: Schema.Array(candidate).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  reachForFacts: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
})

/** One watch job granted Spaces, Discover, Content and Log — never Facts. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'discover',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'Discover',
  description:
    'A loader fixture: a watch job that signals on its space members and hands back the candidates its settings list.',
  settings: Schema.Struct({}),
  jobs: {
    find: {
      trigger: 'watch',
      uses: ['Spaces', 'Discover', 'Content', 'Log'],
      settings: findSettings,
    },
  },
})
