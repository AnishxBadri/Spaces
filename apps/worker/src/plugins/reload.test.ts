import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Fiber, Layer } from 'effect'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { pgBossHost } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import {
  LISTENER_APPLICATION_NAME,
  PLUGIN_CHANGED,
  listenPluginChanged,
} from './listen'
import { reconcilePlugins } from './loader'
import type { ReconcileOptions } from './loader'
import { makePluginReloader } from './reload'
import type { PluginReloader } from './reload'

/**
 * `plugin_changed` against a real pg-boss and a real LISTEN connection on
 * this worker's test database: enable, disable and upgrade without a
 * restart, a dropped listener that reconnects and reconciles, and a burst
 * of notifications that folds into one reload.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)

/** Where the hand-written `slow` bundle reports to; read only by this file. */
const SLOW = Symbol.for('spaces.worker.reload-test.slow')
const slow: {
  calls: Array<string>
  release: () => void
  latch: Promise<void>
} = { calls: [], release: () => undefined, latch: Promise.resolve() }
Reflect.set(globalThis, SLOW, slow)

let boss: PgBoss

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error: Error) => console.error('[pg-boss]', error))
  await boss.start()
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
})

afterAll(async () => {
  await boss.stop({ graceful: false })
})

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-reload-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

/** Copy a built fixture's dist/ (or one version under it) to `<root>/<id>/<dir>/`. */
const install = (
  root: string,
  fixture: string,
  options: { readonly from?: string; readonly dir?: string } = {},
) => {
  const dir = path.join(root, fixture, options.dir ?? 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(
      path.join(fixtures, fixture, 'dist', options.from ?? '', file),
      path.join(dir, file),
    )
}

/** Point `<root>/<id>/current` at a version directory, atomically, as the installer swaps it. */
const swapCurrent = (root: string, id: string, version: string) => {
  const next = path.join(root, id, 'current.next')
  symlinkSync(version, next)
  renameSync(next, path.join(root, id, 'current'))
}

/** `slow`: one action job that waits on `slow.latch` between two writes, and an `onDisable`. */
const writeSlow = (root: string) => {
  const dir = path.join(root, 'slow', 'current')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'slow',
      version: '0.1.0',
      sdk: '^1.0',
      name: 'slow',
      description: 'A reload test bundle whose job outlives a disable.',
      settings: {},
      jobs: { ping: { trigger: 'action', uses: ['Log'] } },
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      `const slow = globalThis[Symbol.for('spaces.worker.reload-test.slow')]`,
      'export default {',
      "  manifest: { id: 'slow', settings: z.object({}) },",
      '  jobs: {',
      '    ping: () => Effect.gen(function* () {',
      "      slow.calls.push('started')",
      '      yield* Effect.promise(() => slow.latch)',
      "      slow.calls.push('finished')",
      '    }),',
      '  },',
      "  onDisable: () => Effect.sync(() => { slow.calls.push('onDisable') }),",
      '}',
    ].join('\n'),
  )
}

const row = async (capabilityId: string) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!inserted) throw new Error('no integration row')
  return inserted
}

const setEnabled = (id: string, enabled: boolean) =>
  db.update(integration).set({ enabled }).where(eq(integration.id, id))

const notify = (payload: string) =>
  db.execute(sql`select pg_notify(${PLUGIN_CHANGED}, ${payload})`)

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: 'northwind-robotics.example' },
      source: { class: 'manual' },
    })
  ).entityId

const waitFor = async <T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const stateOf = async (queue: string, id: string) =>
  (await boss.getJobById(queue, id))?.state ?? null

const settled = (queue: string, id: string) =>
  waitFor(
    () => stateOf(queue, id),
    (state) => state === 'completed' || state === 'failed',
  )

const send = async (queue: string, data: object) => {
  const id = await boss.send(queue, data)
  if (id === null) throw new Error(`${queue} refused the job`)
  return id
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Running = {
  readonly host: PluginHost
  readonly reloader: PluginReloader
  readonly listener: Fiber.Fiber<never>
  /** The worker's log: listener, reloader and host lines. */
  readonly lines: Array<string>
  /** What plugins wrote through `Log`. */
  readonly logged: Array<string>
  /** Every reconcile the reloader ran, by scope: a plugin id, or `*`. */
  readonly reconciles: Array<string>
  /** The most reconciles that were ever running at once. */
  readonly overlap: { now: number; peak: number }
}

const running: Array<Running> = []

/** A worker as `main` composes it: host, reloader, and the listener feeding it. */
const start = async (
  root: string,
  options: {
    readonly backoff?: { readonly initialMs: number; readonly maxMs: number }
    readonly reconcileDelayMs?: number
  } = {},
): Promise<Running> => {
  const lines: Array<string> = []
  const logged: Array<string> = []
  const reconciles: Array<string> = []
  const log = (line: string) => {
    lines.push(line)
  }
  const host = makePluginHost({
    enqueue: noEnqueue,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    sink: (_level, line) => {
      logged.push(line)
    },
  })
  const overlap = { now: 0, peak: 0 }
  const reconcile = (opts: ReconcileOptions) =>
    Effect.sync(() => {
      reconciles.push(opts.only ?? '*')
      overlap.now += 1
      overlap.peak = Math.max(overlap.peak, overlap.now)
    }).pipe(
      Effect.andThen(Effect.sleep(options.reconcileDelayMs ?? 0)),
      Effect.andThen(reconcilePlugins(opts)),
      Effect.ensuring(
        Effect.sync(() => {
          overlap.now -= 1
        }),
      ),
    )
  const reloader = makePluginReloader({
    host,
    pluginsRoot: root,
    reconcile,
    debounceMs: 20,
    log,
  })
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
  const listener = Effect.runFork(
    listenPluginChanged({
      connectionString,
      onChange: reloader.request,
      onListening: () => reloader.request(null),
      backoff: options.backoff ?? { initialMs: 100, maxMs: 1000 },
      log,
    }),
  )
  const worker = {
    host,
    reloader,
    listener,
    lines,
    logged,
    reconciles,
    overlap,
  }
  running.push(worker)
  await waitFor(
    () => listening(worker),
    (n) => n > 0,
  )
  await Effect.runPromise(reloader.settled())
  return worker
}

const listening = (worker: Running) =>
  worker.lines.filter((line) => line.includes(`listening on ${PLUGIN_CHANGED}`))
    .length

const wired = (worker: Running, integrationId: string, job: string) =>
  worker.host.granted(integrationId, job) !== null

afterEach(async () => {
  slow.release()
  for (const worker of running.splice(0)) {
    await Effect.runPromise(Fiber.interrupt(worker.listener))
    await Effect.runPromise(worker.reloader.settled())
    await Effect.runPromise(worker.host.releaseAll())
  }
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

describe('plugin_changed', { timeout: 20_000 }, () => {
  it('enabling a row and notifying registers its queues within a second, and a job sent at once runs', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    const worker = await start(root)
    const echo = await row('echo')
    expect(wired(worker, echo.id, 'echo')).toBe(false)

    // The wired line is printed once its queues are registered.
    const notified = Date.now()
    await notify('echo')
    await waitFor(
      () => worker.lines.includes('[plugins] echo: wired echo, enrich'),
      (yes) => yes,
      1000,
    )
    expect(Date.now() - notified).toBeLessThan(1000)
    expect(wired(worker, echo.id, 'echo')).toBe(true)

    const id = await send('plugin.echo.echo', { entityId: companyId })
    expect(await settled('plugin.echo.echo', id)).toBe('completed')
    expect(worker.lines).toEqual(
      expect.arrayContaining([
        '[plugins] echo: reloading',
        '[plugins] echo 0.1.0: enabled (unpinned: no lock.json entry)',
        '[plugins] echo: wired echo, enrich',
      ]),
    )
  })

  it('disabling waits out the job in flight, then unregisters the queue and releases the scope', async () => {
    const companyId = await seedCompany()
    slow.calls.splice(0)
    slow.latch = new Promise((resolve) => {
      slow.release = resolve
    })
    const root = newPluginsRoot()
    writeSlow(root)
    const plugin = await row('slow')
    const worker = await start(root)
    expect(wired(worker, plugin.id, 'ping')).toBe(true)

    const id = await send('plugin.slow.ping', { entityId: companyId })
    await waitFor(
      () => slow.calls.length,
      (n) => n > 0,
    )
    await setEnabled(plugin.id, false)
    await notify('slow')
    await waitFor(
      () => worker.lines.includes('[plugins] slow: reloading'),
      (yes) => yes,
    )
    // The release is waiting on the job: nothing is closed under it.
    await sleep(300)
    expect(slow.calls).toEqual(['started'])
    expect(wired(worker, plugin.id, 'ping')).toBe(true)

    slow.release()
    expect(await settled('plugin.slow.ping', id)).toBe('completed')
    await waitFor(
      () => wired(worker, plugin.id, 'ping'),
      (yes) => !yes,
    )
    await Effect.runPromise(worker.reloader.settled())
    expect(slow.calls).toEqual(['started', 'finished', 'onDisable'])
    expect(worker.lines).toContain('[plugins] slow: released')

    // Unregistered: a job sent now waits for the plugin to come back.
    const queued = await send('plugin.slow.ping', { entityId: companyId })
    await sleep(1500)
    expect(await stateOf('plugin.slow.ping', queued)).toBe('created')
  })

  it('swapping current to a new version directory runs the new bundle, not the cached module', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'versioned', { from: '0.1.0', dir: '0.1.0' })
    install(root, 'versioned', { from: '0.2.0', dir: '0.2.0' })
    swapCurrent(root, 'versioned', '0.1.0')
    const plugin = await row('versioned')
    const worker = await start(root)
    expect(wired(worker, plugin.id, 'stamp')).toBe(true)

    const first = await send('plugin.versioned.stamp', { entityId: companyId })
    expect(await settled('plugin.versioned.stamp', first)).toBe('completed')

    swapCurrent(root, 'versioned', '0.2.0')
    await notify('versioned')
    await waitFor(
      () => worker.lines.includes('[plugins] versioned: reloading'),
      (yes) => yes,
    )
    await Effect.runPromise(worker.reloader.settled())
    const second = await send('plugin.versioned.stamp', { entityId: companyId })
    expect(await settled('plugin.versioned.stamp', second)).toBe('completed')

    expect(worker.logged).toEqual([
      `[plugin:versioned] stamp {"version":"0.1.0","entityId":"${companyId}"}`,
      `[plugin:versioned] stamp {"version":"0.2.0","entityId":"${companyId}"}`,
    ])
    const stored = (
      await db
        .select({ manifest: integration.manifest })
        .from(integration)
        .where(eq(integration.id, plugin.id))
    ).at(0)
    expect(stored?.manifest).toMatchObject({ version: '0.2.0' })
  })

  it('a full reconciliation reloads only the plugin whose bundle changed', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    install(root, 'versioned', { from: '0.1.0', dir: '0.1.0' })
    install(root, 'versioned', { from: '0.2.0', dir: '0.2.0' })
    swapCurrent(root, 'versioned', '0.1.0')
    const echo = await row('echo')
    await row('versioned')
    const worker = await start(root)

    // Nothing changed: nothing is released.
    worker.reloader.request(null)
    await sleep(50)
    await Effect.runPromise(worker.reloader.settled())
    expect(worker.lines.filter((line) => line.endsWith(': released'))).toEqual(
      [],
    )

    swapCurrent(root, 'versioned', '0.2.0')
    worker.reloader.request(null)
    await sleep(50)
    await Effect.runPromise(worker.reloader.settled())
    expect(worker.lines.filter((line) => line.endsWith(': released'))).toEqual([
      '[plugins] versioned: released',
    ])
    expect(wired(worker, echo.id, 'echo')).toBe(true)
    const id = await send('plugin.versioned.stamp', { entityId: companyId })
    expect(await settled('plugin.versioned.stamp', id)).toBe('completed')
    expect(worker.logged).toEqual([
      `[plugin:versioned] stamp {"version":"0.2.0","entityId":"${companyId}"}`,
    ])
  })

  it('a terminated listener reconnects within its backoff and reconciles a row changed while it was down', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    const backoff = { initialMs: 1000, maxMs: 4000 }
    const worker = await start(root, { backoff })
    expect(worker.reconciles).toEqual(['*'])

    const terminated = Date.now()
    await db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where application_name = ${LISTENER_APPLICATION_NAME}
            and datname = current_database()`,
    )
    await waitFor(
      () => worker.lines.some((line) => line.includes('listener lost')),
      (yes) => yes,
    )
    // Down: the change, and a notification nobody hears.
    const echo = await row('echo')
    await notify('echo')

    await waitFor(
      () => listening(worker),
      (n) => n > 1,
    )
    expect(Date.now() - terminated).toBeLessThan(backoff.initialMs + 1500)
    await waitFor(
      () => wired(worker, echo.id, 'echo'),
      (yes) => yes,
    )
    expect(worker.reconciles).toEqual(['*', '*'])
  })

  it('two notifications for one id arriving together are one reconciliation', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    await row('echo')
    const worker = await start(root)
    expect(worker.reconciles).toEqual(['*'])

    await Promise.all([notify('echo'), notify('echo')])
    await waitFor(
      () => worker.reconciles.length,
      (n) => n > 1,
    )
    await sleep(300)
    await Effect.runPromise(worker.reloader.settled())
    expect(worker.reconciles).toEqual(['*', 'echo'])
  })

  it('a storm while a reload runs folds into one follow-up, never a concurrent one', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    await row('echo')
    const worker = await start(root, { reconcileDelayMs: 400 })

    await notify('echo')
    await waitFor(
      () => worker.reconciles.length,
      (n) => n > 1,
    )
    for (let i = 0; i < 5; i += 1) await notify('echo')
    await sleep(100)
    // Still the first reload; the storm waits.
    expect(worker.reconciles).toEqual(['*', 'echo'])
    await waitFor(
      () => worker.reconciles.length,
      (n) => n > 2,
    )
    await sleep(600)
    await Effect.runPromise(worker.reloader.settled())
    expect(worker.reconciles).toEqual(['*', 'echo', 'echo'])
    expect(worker.overlap.peak).toBe(1)
  })
})
