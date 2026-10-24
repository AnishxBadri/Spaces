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
  // Nothing internal, and a short third-party list pinned here. tldts is for
  // the identity normalizers' public suffix list.
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
  // A plugin's bare `effect` and `zod` resolve to the host's copies, and the
  // sdk's manifestSchema and configOf run on the sdk's — so the two must be
  // one install, or a plugin's settings schema is a foreign zod to the sdk
  // that parses it. Compares the resolved files on disk with core's.
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
