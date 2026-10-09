import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  jobRun,
  space,
  spaceWatch,
} from '@spaces/db/schema'
import type { SpaceWatchState } from '@spaces/db/schema'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { runWatchNowProgram } from '@spaces/core/writes/watches/run'
import { pgBossHost } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { tickWatches } from './queues'

/**
 * The `watch` trigger end to end against a real pg-boss: the watcher fixture
 * wired through the loader, its runs sent by "Run now" and by the tick,
 * worked through `runJob`, with `Spaces.brief` read live. A tick is called
 * directly with its instant — no test waits for the cron.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const QUEUE = 'plugin.watcher.lens'
const TICK = 'plugin.watcher.lens.tick'

let boss: PgBoss
let host: PluginHost | null = null
let integrationId = ''
const lines: Array<string> = []

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-watch-')),
    'plugins',
  )
  const dir = path.join(root, 'watcher', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'watcher', 'dist', file), path.join(dir, file))
  return root
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** "Run now" as web sends it, onto this test's pg-boss. */
const bossEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data, options) =>
      Effect.promise(() => boss.send(queue, data, options ?? {})),
  }),
)

const runNow = async (watchId: string) => {
  const sent = await Effect.runPromise(
    runWatchNowProgram(watchId).pipe(Effect.provide(bossEnqueue)),
  )
  if (sent.status !== 'queued') throw new Error(`not sent: ${sent.status}`)
  return sent.jobId
}

const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** One watch's `job_run` rows, once none is still running. */
const runsOf = (watchId: string, count: number) =>
  waitFor(
    () => db.select().from(jobRun).where(eq(jobRun.watchId, watchId)),
    (rows) => rows.length >= count && rows.every((r) => r.status !== 'running'),
  )

const watchRow = async (watchId: string) =>
  (await db.select().from(spaceWatch).where(eq(spaceWatch.id, watchId))).at(0)

let n = 0
const aSpace = async (
  name: string,
  flags: { sensitive?: boolean; parent?: { id: string; path: string } } = {},
) => {
  n += 1
  const slug = `w${n}`
  const ent = (
    await db
      .insert(entity)
      .values({
        kind: 'space',
        canonicalName: name,
        sensitive: flags.sensitive ?? false,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const p = flags.parent === undefined ? slug : `${flags.parent.path}.${slug}`
  await db.insert(space).values({
    entityId: ent.id,
    parentId: flags.parent?.id ?? null,
    slug,
    path: p,
    criteria: `What belongs in ${name}.`,
  })
  return { id: ent.id, path: p }
}

const aWatch = async (
  spaceId: string,
  values: {
    cadenceMinutes?: number | null
    settings?: { [k: string]: boolean | number }
    state?: SpaceWatchState | null
  } = {},
) => {
  const row = (
    await db
      .insert(spaceWatch)
      .values({
        integrationId,
        spaceId,
        settings: values.settings ?? { cap: (n += 1) },
        cadenceMinutes: values.cadenceMinutes ?? null,
        state: values.state ?? null,
      })
      .returning({ id: spaceWatch.id })
  ).at(0)
  if (!row) throw new Error('no watch')
  return row.id
}

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

  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'watcher', version: '0.1.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  integrationId = row.id

  host = makePluginHost({
    enqueue: noEnqueue,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    sink: (_level, line) => void lines.push(line),
  })
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: newPluginsRoot() }),
  )
  const verdicts = await Effect.runPromise(host.wire(loaded))
  expect(verdicts.map((v) => [v.id, v.status])).toEqual([
    ['watcher', 'enabled'],
  ])
  // The manifest the web reads, as install would have stored it.
  const wired = host.loaded(integrationId)
  await db
    .update(integration)
    .set({
      manifest: jsonRecord(jsonValue.parse(wired?.manifest)),
      status: 'enabled',
    })
    .where(eq(integration.id, integrationId))
})

afterEach(() => {
  lines.splice(0)
})

afterAll(async () => {
  if (host !== null) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  await boss.stop({ graceful: false })
})

describe('a watch job is registered', () => {
  it('on a stately queue keyed by watch, with its tick on a one-minute cron', async () => {
    expect(await boss.getQueue(QUEUE)).toMatchObject({ policy: 'stately' })
    expect(await boss.getQueue(TICK)).toMatchObject({ policy: 'singleton' })
    const schedules = (
      await db.execute<{ name: string; cron: string }>(
        sql`select name, cron from pgboss.schedule where name like 'plugin.watcher.%'`,
      )
    ).rows
    expect(schedules).toEqual([{ name: TICK, cron: '* * * * *' }])
    expect(host?.granted(integrationId, 'lens')).toEqual(['Log', 'Spaces'])
  })
})

describe('Run now', () => {
  it('runs a watch with no cadence: one job_run carrying the watch, the brief logged, the state written back and handed to the next run', async () => {
    const launch = await aSpace('Launch')
    const { entityId: varda } = await resolveEntity({
      kind: 'company',
      name: 'Varda',
      keys: { domain: 'varda.example' },
      source: { class: 'manual' },
    })
    await db.insert(entitySpace).values({ entityId: varda, spaceId: launch.id })
    const watchId = await aWatch(launch.id)

    await runNow(watchId)
    const first = await runsOf(watchId, 1)
    expect(first).toHaveLength(1)
    expect(first.at(0)).toMatchObject({
      queue: QUEUE,
      integrationId,
      entityId: launch.id,
      watchId,
      status: 'succeeded',
    })
    const logged = lines.find((l) => l.startsWith('[plugin:watcher] brief '))
    expect(logged).toBeDefined()
    const fields: unknown = JSON.parse(
      (logged ?? '').slice('[plugin:watcher] brief '.length),
    )
    expect(fields).toMatchObject({
      watchId,
      brief: {
        space: { id: launch.id, name: 'Launch' },
        path: [{ id: launch.id, name: 'Launch' }],
        members: [{ entityId: varda, name: 'Varda' }],
        memberCount: 1,
      },
    })
    expect((await watchRow(watchId))?.state).toEqual({ runs: 1, members: 1 })

    await runNow(watchId)
    await runsOf(watchId, 2)
    const after = await watchRow(watchId)
    expect(after?.state).toEqual({ runs: 2, members: 1 })
    expect(after).toMatchObject({ lastStatus: 'succeeded', lastError: null })
    expect(after?.lastRunAt).toBeInstanceOf(Date)
  })

  it('a run that throws leaves the state as it was and says why', async () => {
    const s = await aSpace('Robotics')
    const watchId = await aWatch(s.id, {
      settings: { fail: true },
      state: { runs: 5 },
    })
    await runNow(watchId)
    const runs = await runsOf(watchId, 1)
    expect(runs.map((r) => r.status)).toEqual(['failed'])
    expect(runs.at(0)?.error).toContain('failed on purpose')
    const row = await watchRow(watchId)
    expect(row?.state).toEqual({ runs: 5 })
    expect(row?.lastStatus).toBe('failed')
  })

  it('a sensitive space in the path refuses the brief, and the run closes with the reason', async () => {
    const hushed = await aSpace('Hushed', { sensitive: true })
    const under = await aSpace('Under', { parent: hushed })
    const watchId = await aWatch(under.id, { state: { runs: 1 } })
    await runNow(watchId)
    const runs = await runsOf(watchId, 1)
    expect(runs.map((r) => r.status)).toEqual(['failed'])
    expect(runs.at(0)?.error).toContain('Under is sensitive (via Hushed)')
    expect((await watchRow(watchId))?.state).toEqual({ runs: 1 })
  })

  it('a run already queued when its space is archived is skipped, not run', async () => {
    const s = await aSpace('Shelved')
    const watchId = await aWatch(s.id)
    await db
      .update(space)
      .set({ archivedAt: new Date() })
      .where(eq(space.entityId, s.id))
    await boss.send(
      QUEUE,
      { watchId, spaceId: s.id },
      { singletonKey: watchId },
    )
    const runs = await runsOf(watchId, 1)
    expect(runs.map((r) => r.status)).toEqual(['skipped'])
    expect(lines.filter((l) => l.includes(watchId))).toEqual([])
  })
})

describe('the cadence tick', () => {
  it('sends one run per due watch, never one with no cadence, and nothing for an archived space', async () => {
    const live = await aSpace('Ticking')
    const scheduled = await aWatch(live.id, { cadenceMinutes: 60 })
    const manual = await aWatch(live.id)
    const parent = await aSpace('Gone')
    const child = await aSpace('Gone child', { parent })
    const paused = await aWatch(child.id, { cadenceMinutes: 60 })
    await db
      .update(space)
      .set({ archivedAt: new Date() })
      .where(eq(space.entityId, parent.id))

    const sent = await Effect.runPromise(
      tickWatches({ boss }, integrationId, QUEUE, new Date()),
    )
    expect(sent).toBe('sent 1 of 1 due')
    const runs = await runsOf(scheduled, 1)
    expect(runs.at(0)).toMatchObject({
      status: 'succeeded',
      watchId: scheduled,
    })
    expect(
      await db
        .select()
        .from(jobRun)
        .where(and(eq(jobRun.queue, QUEUE), eq(jobRun.watchId, manual))),
    ).toEqual([])
    expect(
      await db.select().from(jobRun).where(eq(jobRun.watchId, paused)),
    ).toEqual([])

    // Run in this slot: the next tick in it sends nothing.
    expect(
      await Effect.runPromise(
        tickWatches({ boss }, integrationId, QUEUE, new Date()),
      ),
    ).toBeUndefined()
  })

  it('Run now on a scheduled watch runs at once, and the next cadence tick still fires', async () => {
    // Only this watch is scheduled.
    await db
      .update(spaceWatch)
      .set({ cadenceMinutes: null })
      .where(eq(spaceWatch.integrationId, integrationId))
    const s = await aSpace('Both')
    const watchId = await aWatch(s.id, { cadenceMinutes: 60 })
    await runNow(watchId)
    await runsOf(watchId, 1)
    // The next slot begins at the top of the next hour.
    const next = new Date()
    next.setUTCHours(next.getUTCHours() + 1, 0, 30, 0)
    expect(
      await Effect.runPromise(
        tickWatches({ boss }, integrationId, QUEUE, next),
      ),
    ).toBe('sent 1 of 1 due')
    const runs = await runsOf(watchId, 2)
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded'])
    expect((await watchRow(watchId))?.state).toMatchObject({ runs: 2 })
  })
})
