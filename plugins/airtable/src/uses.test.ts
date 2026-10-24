import { defineManifest, definePlugin } from '@spaces/sdk'
import type { Import, Log } from '@spaces/sdk'
import type { Effect } from 'effect'
import { describe, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'

/**
 * The job's `R` is bounded by its `uses` — a claim typecheck checks: this file
 * fails typecheck if the job yields a port its manifest entry does not list.
 * The runtime half — a withheld port is "service not found", mapped to a
 * permanent failure — is the worker's airtable-live test.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

describe('the ports the stage job needs', () => {
  it('are exactly Import and Log', () => {
    expectTypeOf<Services<ReturnType<typeof jobs.stage>>>().toEqualTypeOf<
      Import | Log
    >()
  })

  it('fail typecheck without Import in uses', () => {
    const withoutImport = defineManifest({
      ...manifest,
      jobs: { stage: { trigger: 'file', uses: ['Log'] } },
    })
    // @ts-expect-error — stage yields Import, which these uses do not grant
    definePlugin({ manifest: withoutImport, jobs })
  })
})
