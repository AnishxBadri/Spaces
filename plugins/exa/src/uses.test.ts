import { Context, Effect, Exit, Layer } from 'effect'
import { Facts, PORTS, defineManifest, definePlugin } from '@spaces/sdk'
import type {
  Ai,
  Config,
  Content,
  Http,
  Judgment,
  Read,
  Secrets,
} from '@spaces/sdk'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'
import { fixedClock, portsFor, replay } from './test-fixtures.ts'

/**
 * The research job's grant (D51): its `R` is the ports its `uses` names and
 * nothing else — no Facts, no Identity — checked by gate 1 here and at
 * runtime the way the host does it, by picking exactly the declared tags.
 */
type Services<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never

const USES = [
  'Config',
  'Secrets',
  'Http',
  'Read',
  'Content',
  'Ai',
  'Judgment',
] as const

describe('the ports research needs', () => {
  it('are Config | Secrets | Http | Read | Content | Ai | Judgment', () => {
    expectTypeOf<Services<ReturnType<typeof jobs.research>>>().toEqualTypeOf<
      Config | Secrets | Http | Read | Content | Ai | Judgment
    >()
    expect(manifest.jobs.research.uses).toEqual(USES)
  })

  it('fail typecheck without Secrets in uses', () => {
    const withoutSecrets = defineManifest({
      ...manifest,
      jobs: {
        research: {
          trigger: 'action',
          uses: ['Config', 'Http', 'Read', 'Content', 'Ai', 'Judgment'],
        },
      },
    })
    // @ts-expect-error — research yields Secrets, which these uses do not grant
    definePlugin({ manifest: withoutSecrets, jobs })
  })
})

/**
 * The grant as the loader builds it: every test port built, then only the
 * tags `uses` names kept — the same `Context.pick` the host runs.
 */
const granted = (ports: ReturnType<typeof portsFor>) =>
  Layer.build(ports.layer).pipe(
    Effect.map(
      Context.pick(...manifest.jobs.research.uses.map((port) => PORTS[port])),
    ),
  )

describe('the grant the loader hands research', () => {
  it('is enough to run it, and holds no other port', async () => {
    const ports = portsFor([replay('five pages')])
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* granted(ports)
          yield* jobs
            .research({ entityId: 'entity-0' })
            .pipe(Effect.provideContext(context), Effect.provide(fixedClock))
          return [...context.mapUnsafe.keys()].sort()
        }),
      ),
    )
    expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual(
      USES.map((port) => PORTS[port].key).sort(),
    )
  })

  it('a deliberate reach for Facts dies "Service not found"', async () => {
    const ports = portsFor([])
    const exit = await Effect.runPromiseExit(
      // @ts-expect-error — the grant holds no Facts, so the compiler refuses the reach too
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* granted(ports)
          yield* Effect.gen(function* () {
            yield* Facts
          }).pipe(Effect.provideContext(context))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
      `Service not found: ${Facts.key}`,
    )
  })
})
