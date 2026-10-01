import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineManifest } from './manifest.ts'
import { definePlugin } from './plugin.ts'

const manifest = defineManifest({
  manifestVersion: 1,
  id: 'apollo',
  version: '1.2.0',
  sdk: '^1.0',
  name: 'Apollo',
  description: 'Enriches companies and people.',
  settings: z.object({}),
  jobs: { enrich: { trigger: 'action', uses: ['Identity', 'Facts'] } },
})

describe('definePlugin', () => {
  it('returns the plugin it was given', () => {
    const jobs = { enrich: (_: { entityId: string }) => Effect.void }
    const plugin = definePlugin({ manifest, jobs })
    expect(plugin.manifest).toBe(manifest)
    expect(Object.keys(plugin.jobs)).toEqual(['enrich'])
  })

  // These two are checked by `pnpm typecheck`, not at runtime: each
  // expect-error directive fails the gate if the line below it ever
  // typechecks.
  it('constrains job functions to the manifest job names', () => {
    const misspelt = () =>
      definePlugin({
        manifest,
        // @ts-expect-error — the manifest declares `enrich`; `enrichh` is not a job
        jobs: { enrichh: () => Effect.void },
      })
    const missing = () =>
      definePlugin({
        manifest,
        // @ts-expect-error — `enrich` is declared and has no function
        jobs: {},
      })
    expect(typeof misspelt).toBe('function')
    expect(typeof missing).toBe('function')
  })
})
