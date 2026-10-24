//  @ts-check

// The lint configuration lives in `@spaces/config`; this is where ESLint finds
// it. Flat-config lookup walks up from the cwd, so `eslint .` in any package
// lands here, with every `files` glob and architecture zone anchored to the
// repo root. Never copy it into a package: that re-bases the globs and
// silences every zone.
export { default } from '@spaces/config/eslint'
