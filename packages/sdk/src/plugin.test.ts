import { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineManifest } from './manifest.ts'
import { definePlugin } from './plugin.ts'
import type { Plugin, StorageSourceProvider } from './plugin.ts'
import { NotFound } from './storage-source.ts'
import type { StorageSource } from './storage-source.ts'

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

const sourceManifest = defineManifest({
  manifestVersion: 1,
  id: 'drive-like',
  version: '0.1.0',
  sdk: '^1.1',
  name: 'Drive-like',
  description: 'A storage source.',
  provides: 'storage-source',
  settings: z.object({}),
  jobs: { list: { trigger: 'action', uses: ['Http'] } },
})

const source: StorageSource = {
  resolveLink: () => Effect.succeed(null),
  listFolder: () => Effect.succeed({ entries: [] }),
  getFolder: (id) => Effect.succeed({ id, name: id, parents: [] }),
  getFile: (id) => Effect.fail(new NotFound({ id })),
  changes: () => Effect.succeed({ changes: [], next: 'now' }),
  pickerConfig: () => Effect.succeed({}),
}

describe('definePlugin and storageSource', () => {
  it('carries the provider of a storage-source plugin', () => {
    const plugin = definePlugin({
      manifest: sourceManifest,
      jobs: { list: () => Effect.void },
      storageSource: Effect.succeed(source),
    })
    expect(Effect.isEffect(plugin.storageSource)).toBe(true)
    // A loaded bundle is the wide `Plugin`, where the provider is optional.
    const loaded: Plugin = plugin
    expectTypeOf(loaded.storageSource).toEqualTypeOf<
      StorageSourceProvider | undefined
    >()
  })

  // Checked by `pnpm typecheck`, like the job-name cases above.
  it('requires it when the manifest provides storage-source, and refuses it otherwise', () => {
    const missing = () =>
      // @ts-expect-error — provides: 'storage-source' with no storageSource
      definePlugin({
        manifest: sourceManifest,
        jobs: { list: () => Effect.void },
      })
    const unasked = () =>
      definePlugin({
        manifest,
        jobs: { enrich: () => Effect.void },
        // @ts-expect-error — apollo provides nothing, so it has no provider
        storageSource: Effect.succeed(source),
      })
    expect(typeof missing).toBe('function')
    expect(typeof unasked).toBe('function')
  })
})
