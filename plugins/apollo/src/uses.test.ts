import { defineManifest, definePlugin } from '@spaces/sdk'
import type {
  Config,
  Content,
  Facts,
  Http,
  Identity,
  Log,
  Read,
  Receipts,
  Secrets,
} from '@spaces/sdk'
import type { Effect } from 'effect'
import { describe, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'

/**
 * Each job's `R` is bounded by its `uses` — a claim gate 1 checks: this file
 * fails typecheck if a job yields a port its manifest entry does not list.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

describe('the ports each job needs', () => {
  it('are exactly the ports each job’s uses grants, Config for the person jobs', () => {
    type Granted =
      Read | Secrets | Http | Identity | Receipts | Facts | Content | Log
    expectTypeOf<
      Services<ReturnType<typeof jobs.enrichCompany.run>>
    >().toEqualTypeOf<Granted>()
    expectTypeOf<
      Services<ReturnType<typeof jobs.enrichPerson.run>>
    >().toEqualTypeOf<Granted | Config>()
  })

  it('fail typecheck without Secrets in uses', () => {
    const withoutSecrets = defineManifest({
      ...manifest,
      jobs: {
        enrichCompany: {
          trigger: 'action',
          uses: [
            'Read',
            'Http',
            'Identity',
            'Receipts',
            'Facts',
            'Content',
            'Log',
          ],
        },
        enrichPerson: manifest.jobs.enrichPerson,
      },
    })
    // @ts-expect-error — enrichCompany yields Secrets, which these uses do not grant
    definePlugin({ manifest: withoutSecrets, jobs })
  })
})
