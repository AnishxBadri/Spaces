/**
 * The plugin zone's stand-in (SPA-180). `plugins/*` does not exist yet, so the
 * zone in `../../eslint.base.js` (`PLUGIN_IMPORTS_SDK_ONLY`) names this
 * directory beside the real one and is proved against it: add
 * `import { db } from '@spaces/db'` here and `pnpm lint` fails with the rule's
 * message and docs/spec-plugin-sdk.md §2. Nothing else belongs in this file —
 * it exists to be lint's target, not to run.
 */
export {}
