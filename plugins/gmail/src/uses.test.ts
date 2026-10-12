import { defineManifest, definePlugin } from '@spaces/sdk'
import type {
  Ai,
  Content,
  Facts,
  Http,
  Identity,
  Log,
  Secrets,
} from '@spaces/sdk'
import type { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'

/**
 * A syncer's ports: Secrets for the connection's token, Http, Content for
 * the mail lane, and Log — never Facts, Identity or Ai. Participants become
 * records host-side, through the participants module. Gate 1 checks the type
 * half; the worker's live test checks the Layer the host builds.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

type Sync = Services<ReturnType<typeof jobs.sync>>

const SYNCER = ['Secrets', 'Http', 'Content', 'Log']

describe('the ports the sync job needs', () => {
  it('are exactly the four a syncer is granted', () => {
    expectTypeOf<Sync>().toEqualTypeOf<Secrets | Http | Content | Log>()
    expectTypeOf<Extract<Sync, Facts | Identity | Ai>>().toBeNever()
  })

  it('are what the job declares, and Facts, Identity and Ai are not', () => {
    expect([...manifest.jobs.sync.uses].sort()).toEqual([...SYNCER].sort())
    for (const withheld of ['Facts', 'Identity', 'Ai'])
      expect(manifest.jobs.sync.uses).not.toContain(withheld)
  })

  it('fail typecheck without Content in uses', () => {
    const withoutContent = defineManifest({
      ...manifest,
      jobs: {
        sync: {
          trigger: 'schedule',
          schedule: '*/5 * * * *',
          uses: ['Secrets', 'Http', 'Log'],
        },
      },
    })
    // @ts-expect-error — sync yields Content, which these uses do not grant
    definePlugin({ manifest: withoutContent, jobs })
  })
})
