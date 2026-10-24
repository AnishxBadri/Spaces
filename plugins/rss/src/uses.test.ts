import { defineManifest, definePlugin } from '@spaces/sdk'
import type {
  Config,
  Content,
  Facts,
  Http,
  Identity,
  Log,
  PluginDb,
} from '@spaces/sdk'
import type { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'

/**
 * A poller's ports: PluginDb, Http, Content, Config and Log, never Facts or
 * Identity. Typecheck checks the type half — the job's `R` is exactly the five,
 * and `definePlugin` bounds it by `uses`.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

type Poll = Services<ReturnType<typeof jobs.poll>>

const POLLER = ['PluginDb', 'Http', 'Content', 'Config', 'Log']

describe('the ports the poll job needs', () => {
  it('are exactly the five a poller is granted', () => {
    expectTypeOf<Poll>().toEqualTypeOf<
      PluginDb | Http | Content | Config | Log
    >()
    expectTypeOf<Extract<Poll, Facts | Identity>>().toBeNever()
  })

  it('are what every job declares, and Facts and Identity are in no uses', () => {
    for (const declared of Object.values(manifest.jobs)) {
      expect([...declared.uses].sort()).toEqual([...POLLER].sort())
      expect(declared.uses).not.toContain('Facts')
      expect(declared.uses).not.toContain('Identity')
    }
  })

  it('fail typecheck without PluginDb in uses', () => {
    const withoutDb = defineManifest({
      ...manifest,
      jobs: {
        poll: {
          trigger: 'schedule',
          schedule: '*/30 * * * *',
          uses: ['Config', 'Http', 'Content', 'Log'],
        },
      },
    })
    // @ts-expect-error — poll yields PluginDb, which these uses do not grant
    definePlugin({ manifest: withoutDb, jobs })
  })
})
