import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SDK_VERSION } from './version.ts'

const pkg = z
  .object({
    version: z.string(),
    dependencies: z.record(z.string(), z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ),
  )

describe('@spaces/sdk package.json', () => {
  // D55: "nothing internal", and a short third-party list a test pins.
  // tldts joined with sdk-4b: the identity normalizers need the public
  // suffix list, and one normalizer on both sides of the port is the point.
  it('depends on effect, zod and tldts and nothing else', () => {
    expect(pkg.dependencies).toEqual({
      effect: '4.0.0-rc.112',
      tldts: '^7.4.9',
      zod: '^4.3.6',
    })
  })

  it('carries SDK_VERSION as its version', () => {
    expect(pkg.version).toBe(SDK_VERSION)
  })
})

describe('the runtimes a plugin shares with the host', () => {
  // A plugin's bare `effect` and `zod` resolve to the host's copies (sdk-11),
  // and the sdk's own manifestSchema and configOf run on the sdk's copies —
  // so the two must be one install, or a plugin's settings schema is a
  // foreign zod to the sdk that parses it. pnpm resolved the sdk to a newer
  // zod than the rest of the workspace once (fixed in the lockfile); this
  // compares the resolved files, read from disk, with core's — no import.
  const from = (dir: string) =>
    createRequire(new URL(`../../${dir}/package.json`, import.meta.url))
  it.each(['effect', 'zod'])(
    'resolves %s to the same install as core',
    (pkgName) => {
      expect(realpathSync(from('sdk').resolve(pkgName))).toBe(
        realpathSync(from('core').resolve(pkgName)),
      )
    },
  )
})
