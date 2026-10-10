import { Context, Effect, Exit, Layer } from 'effect'
import {
  Facts,
  Identity,
  PORTS,
  defineManifest,
  definePlugin,
} from '@spaces/sdk'
import type {
  Ai,
  Config,
  Content,
  Discover,
  Http,
  Judgment,
  Log,
  Read,
  Receipts,
  Secrets,
  Spaces,
} from '@spaces/sdk'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { jobs } from './index.ts'
import { manifest } from './manifest.ts'
import {
  SPACE_ID,
  WATCH_ID,
  fixedClock,
  portsFor,
  replay,
  watchPortsFor,
} from './test-fixtures.ts'

/**
 * Each job's grant (D51): its `R` is within the ports its `uses` names — no
 * Facts, no Identity — checked by gate 1 here and at runtime the way the
 * host does it, by picking exactly the declared tags.
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

const WATCH_USES = [
  'Config',
  'Secrets',
  'Http',
  'Spaces',
  'Discover',
  'Content',
  'Log',
  'Receipts',
] as const

describe('the ports watch needs', () => {
  it('are Secrets | Http | Spaces | Discover | Content | Log | Receipts, within what uses grants', () => {
    expectTypeOf<Services<ReturnType<typeof jobs.watch>>>().toEqualTypeOf<
      Secrets | Http | Spaces | Discover | Content | Log | Receipts
    >()
    expectTypeOf<Services<ReturnType<typeof jobs.watch>>>().toExtend<
      Config | Secrets | Http | Spaces | Discover | Content | Log | Receipts
    >()
    expect(manifest.jobs.watch.uses).toEqual(WATCH_USES)
  })

  it('fail typecheck without Discover in uses', () => {
    const withoutDiscover = defineManifest({
      ...manifest,
      jobs: {
        ...manifest.jobs,
        watch: {
          ...manifest.jobs.watch,
          uses: [
            'Config',
            'Secrets',
            'Http',
            'Spaces',
            'Content',
            'Log',
            'Receipts',
          ],
        },
      },
    })
    // @ts-expect-error — watch yields Discover, which these uses do not grant
    definePlugin({ manifest: withoutDiscover, jobs })
  })
})

/** The watch's grant as the loader builds it: only the tags `uses` names. */
const watchGrant = (ports: ReturnType<typeof watchPortsFor>) =>
  Layer.build(ports.layer).pipe(
    Effect.map(
      Context.pick(...manifest.jobs.watch.uses.map((port) => PORTS[port])),
    ),
  )

const watchInput = {
  watchId: WATCH_ID,
  spaceId: SPACE_ID,
  settings: {},
  state: null,
}

describe('the grant the loader hands watch', () => {
  it('is enough to run it, and holds no other port', async () => {
    const ports = watchPortsFor([
      replay('webset created'),
      replay('seven items'),
      replay('no more items'),
    ])
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* watchGrant(ports)
          yield* jobs.watch(watchInput).pipe(Effect.provideContext(context))
          return [...context.mapUnsafe.keys()].sort()
        }),
      ),
    )
    expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual(
      WATCH_USES.map((port) => PORTS[port].key).sort(),
    )
  })

  // Every port the test kit builds is in the layer, Facts and Identity
  // included; only the grant leaves them out.
  it('a deliberate reach for Facts dies "Service not found"', async () => {
    const ports = watchPortsFor([])
    const exit = await Effect.runPromiseExit(
      // @ts-expect-error — the grant holds no Facts, so the compiler refuses the reach too
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* watchGrant(ports)
          yield* Effect.gen(function* () {
            yield* Facts
          }).pipe(Effect.provideContext(context))
        }),
      ),
    )
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
      `Service not found: ${Facts.key}`,
    )
  })

  it('a deliberate reach for Identity dies "Service not found"', async () => {
    const ports = watchPortsFor([])
    const exit = await Effect.runPromiseExit(
      // @ts-expect-error — the grant holds no Identity, so the compiler refuses the reach too
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* watchGrant(ports)
          yield* Effect.gen(function* () {
            yield* Identity
          }).pipe(Effect.provideContext(context))
        }),
      ),
    )
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
      `Service not found: ${Identity.key}`,
    )
  })
})
