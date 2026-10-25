import { STORAGE_SOURCE_WITHHELD, definePlugin } from '@spaces/sdk'
import type {
  Ai,
  Config,
  Facts,
  Http,
  Log,
  Plugin,
  Secrets,
  StorageSourceProvider,
} from '@spaces/sdk'
import type { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import plugin, { jobs } from './index.ts'
import { manifest } from './manifest.ts'

/**
 * A storage source's ports: Config, Http, Secrets and Log, never Facts or
 * Ai — it delivers bytes and never decides filing. Typecheck checks the type
 * half.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

type List = Services<ReturnType<typeof jobs.list>>

describe('the ports Google Drive is granted', () => {
  it('are exactly the four ambient ones, for the job and the provider', () => {
    expectTypeOf<List>().toEqualTypeOf<Config | Http | Secrets | Log>()
    expectTypeOf<Extract<List, Facts | Ai>>().toBeNever()
    expect([...manifest.jobs.list.uses].sort()).toEqual(
      ['Config', 'Http', 'Log', 'Secrets'].sort(),
    )
    for (const withheld of STORAGE_SOURCE_WITHHELD)
      expect(manifest.jobs.list.uses).not.toContain(withheld)
  })

  it('hands core its provider, as a loaded bundle carries it', () => {
    // What the worker sees once it has imported a bundle: the wide `Plugin`.
    const loaded: Plugin = plugin
    expectTypeOf(loaded.storageSource).toEqualTypeOf<
      StorageSourceProvider | undefined
    >()
    expect(loaded.storageSource).toBeDefined()
  })

  it('fails typecheck without its provider', () => {
    // @ts-expect-error — provides: 'storage-source' and no storageSource
    const missing = () => definePlugin({ manifest, jobs })
    expect(typeof missing).toBe('function')
  })
})
