//  @ts-check

// The lint configuration lives in packages/config (SPA-180); this file is the
// one place ESLint finds it from. Flat-config lookup walks up from the cwd, so
// `eslint .` in apps/web, packages/db or packages/core all land here — one
// config, root-relative `files` globs and `ignores`, and every architecture
// zone anchored to the repo root. A per-package copy would re-base those
// globs to the package and silence every zone (the SPA-135 failure, again).
export { default } from '@spaces/config/eslint'
