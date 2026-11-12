# @spaces/sdk

## 2.0.0

### Major Changes

- The plugin contract speaks Effect Schema, and zod leaves it (D85). What an author changes:

  - **Settings are a `Schema.Struct`.** `settings`, and a watch job's `settings`, are an Effect `Schema.Struct` instead of a `z.object`. A default is `Schema.withDecodingDefaultKey(Effect.succeed(value))`; a field the operator may leave out is `Schema.optionalKey(…)`, never `Schema.optional`, which the settings form cannot draw. `title`, `description` and `format` go on with `.annotate({ … })` before the field's checks — an annotation after a check describes the check. `settingsJsonSchema` still writes JSON Schema of what the operator types, with each field's `default` and `propertyOrder`, so `manifest.json` keeps its shape.
  - **`configOf` and `watchSettingsOf`** decode by that struct: defaults applied, typed as authored.
  - **`Ai.complete`'s schema** is an Effect schema, and the answer is decoded by it.
  - **The manifest reader** is `decodeManifest(raw)`: `{ success: true, data }`, or `{ success: false, error }` where `error` is a `ManifestRefused` carrying each issue's `path` and `message`. `manifestSchema`, `registryEntrySchema` and `registrySchema` are Effect schemas; decode them with `Schema.decodeUnknown*`. Every object in a manifest and a registry entry is still closed: an unknown key is refused at any depth.
  - **The bundle** leaves two bare imports to the host, `effect` and `@spaces/sdk`. Take `zod` out of the plugin's `peerDependencies` and `devDependencies`; the host no longer resolves it, so a bundle that still imports it fails to load.
  - **`manifest.sdk` is `^2.0`.** The host refuses a 1.x bundle as it refuses any range it does not satisfy: the plugin reads as degraded until it is rebuilt.

### Minor Changes

- Also carries what was pending for 1.5: the `watch` trigger with its own settings and `watchSettingsOf`; manifest `roles`, `mcp` and an action's `answers`; the enrichment vocabulary with `Facts.answer` and its picture, company and signal keys; the `identity.added` event; the mail, meeting and recorder lanes (`logEmail` with its snippet, `logMeeting`, `logRecordedNote`, `logInteraction`'s recorder payload) and payload actions (`input: 'payload'`); the storage-source provider, its typed read and write halves, `putFile`'s `changeToken` and `Http.stream`; settings `propertyOrder`; and the testing kit's `AiTest`, fake Box, fake Drive seeds and nudge, and the storage-source chaos list.
