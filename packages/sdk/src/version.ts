/**
 * The SDK's own semver — the one place it is spelled. A plugin's
 * `manifest.sdk` range is checked against this at load (`satisfiesSdk`), and
 * `src/package.test.ts` asserts it equals `package.json`'s `version`, so a
 * release bumps both or the suite fails. New port method or trigger = minor;
 * changed signature = major (docs/spec-plugin-sdk.md §6).
 */
export const SDK_VERSION = '1.0.0'
