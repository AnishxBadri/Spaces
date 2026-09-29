/**
 * The sdk zone's stand-in (SPA-180). `packages/sdk` is born in sdk-3; until
 * then the zone in `../../eslint.base.js` (`SDK_IMPORTS_NOTHING_INTERNAL`)
 * names this directory beside the real one so the fence is written and
 * exercised before the package it fences exists. Add
 * `import { fmtMoney } from '@spaces/core/portfolio/format'` here and
 * `pnpm lint` fails with the rule's message and docs/spec-plugin-sdk.md §2.
 */
export {}
