import { readFileSync } from 'node:fs'
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
  // tldts joins with sdk-4b (the identity normalizers).
  it('depends on effect and zod and nothing else', () => {
    expect(pkg.dependencies).toEqual({
      effect: '4.0.0-rc.112',
      zod: '^4.3.6',
    })
  })

  it('carries SDK_VERSION as its version', () => {
    expect(pkg.version).toBe(SDK_VERSION)
  })
})
