import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * The plugin is typechecked and tested against the host's effect and zod.
 * A second zod install makes the manifest's settings schema a foreign type
 * to the sdk's `defineManifest`, which tsc fails on by running out of
 * memory, not with an error — so the resolution is pinned here.
 */
const from = (dir: string) =>
  createRequire(new URL(`../../../${dir}/package.json`, import.meta.url))

describe('the runtimes this plugin shares with the host', () => {
  it.each(['effect', 'zod'])(
    'resolves %s to the same install as the sdk',
    (pkg) => {
      expect(realpathSync(from('plugins/airtable').resolve(pkg))).toBe(
        realpathSync(from('packages/sdk').resolve(pkg)),
      )
    },
  )
})
