/**
 * @spaces/sdk — what a plugin imports (docs/spec-plugin-sdk.md §3–§6). This
 * slice (sdk-3) is the skeleton: the manifest, the version check and
 * `definePlugin`. Port tags, trigger shapes and claim types arrive in sdk-4a;
 * the testing kit in sdk-5.
 */
export { SDK_VERSION } from './version.ts'
export { satisfiesSdk, parseSdkRange, isVersion } from './range.ts'
export type { SdkCheck } from './range.ts'
export {
  TRIGGERS,
  ACTION_TARGETS,
  manifestSchema,
  defineManifest,
  toManifestJson,
  settingsJsonSchema,
} from './manifest.ts'
export type {
  Trigger,
  Manifest,
  JobDeclaration,
  AuthoredManifest,
} from './manifest.ts'
export { definePlugin } from './plugin.ts'
export type { Plugin, PluginJobs, JobFn, LifecycleHook } from './plugin.ts'
