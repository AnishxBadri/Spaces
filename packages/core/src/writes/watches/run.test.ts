import { Effect, Exit, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  signal,
  space,
  spaceWatch,
  suggestion,
} from '@spaces/db/schema'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { jsonRecord, jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import type { EnqueueOptions } from '../../queue/sender'
import {
  dueWatchesProgram,
  runWatchNowProgram,
  watchRunSummary,
  watchRunTallyProgram,
} from './run'

/**
 * The two senders of a watch run: the tick's due read, and "Run now". The
 * slot arithmetic is pinned with explicit instants; nothing waits for a
 * clock.
 */

const manifest = toManifestJson(
  defineManifest({
    manifestVersion: 1,
    id: 'watcher',
    version: '0.1.0',
    sdk: '^1.4',
    name: 'Watcher',
    description: 'A watch.',
    settings: z.object({}),
    jobs: {
      lens: {
        trigger: 'watch',
        uses: ['Spaces'],
        settings: z.object({}),
      },
    },
  }),
)

let n = 0
const aSpace = async (parent?: { id: string; path: string }) => {
  n += 1
  const slug = `s${n}`
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: slug })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const path = parent === undefined ? slug : `${parent.path}.${slug}`
  await db
    .insert(space)
    .values({ entityId: ent.id, parentId: parent?.id ?? null, slug, path })
  return { id: ent.id, path }
}

const anIntegration = async (values: { manifest?: unknown } = {}) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'watcher',
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest: jsonRecord(jsonValue.parse(values.manifest ?? manifest)),
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

const aWatch = async (
  integrationId: string,
  spaceId: string,
  cadenceMinutes: number | null,
  lastRunAt: Date | null = null,
) => {
  const row = (
    await db
      .insert(spaceWatch)
      .values({
        integrationId,
        spaceId,
        settings: { n: (n += 1) },
        cadenceMinutes,
        lastRunAt,
      })
      .returning({ id: spaceWatch.id })
  ).at(0)
  if (!row) throw new Error('no watch')
  return row.id
}

type Sent = {
  queue: string
  data: Record<string, unknown>
  options: EnqueueOptions | undefined
}
const recording = () => {
  const sent: Array<Sent> = []
  const layer = Layer.succeed(
    Enqueue,
    Enqueue.of({
      enqueue: (queue, data, options) =>
        Effect.sync(() => {
          sent.push({ queue, data, options })
          return `job-${sent.length}`
        }),
    }),
  )
  return { sent, layer }
}

const runNow = (watchId: string, layer: Layer.Layer<Enqueue>) =>
  Effect.runPromiseExit(runWatchNowProgram(watchId).pipe(Effect.provide(layer)))

const refusedWith = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

describe('dueWatchesProgram', () => {
  // 2026-10-10T12:30Z: the hourly slot began at 12:00, the daily at 00:00.
  const now = new Date('2026-10-10T12:30:00Z')

  it('never schedules a watch with no cadence — it runs only from Run now', async () => {
    const integrationId = await anIntegration()
    const s = await aSpace()
    await aWatch(integrationId, s.id, null)
    expect(
      await Effect.runPromise(dueWatchesProgram(integrationId, now)),
    ).toEqual([])
  })

  it('is due once per cadence slot: never run, or last run before the slot began', async () => {
    const integrationId = await anIntegration()
    const s = await aSpace()
    const fresh = await aWatch(integrationId, s.id, 60)
    const ranThisHour = await aWatch(
      integrationId,
      s.id,
      60,
      new Date('2026-10-10T12:05:00Z'),
    )
    const ranLastHour = await aWatch(
      integrationId,
      s.id,
      60,
      new Date('2026-10-10T11:59:00Z'),
    )
    const ranToday = await aWatch(
      integrationId,
      s.id,
      1440,
      new Date('2026-10-10T00:10:00Z'),
    )
    const due = await Effect.runPromise(dueWatchesProgram(integrationId, now))
    expect(due.map((d) => d.watchId).sort()).toEqual(
      [fresh, ranLastHour].sort(),
    )
    expect(due.every((d) => d.spaceId === s.id)).toBe(true)
    expect(due.map((d) => d.watchId)).not.toContain(ranThisHour)
    expect(due.map((d) => d.watchId)).not.toContain(ranToday)
  })

  it('pauses a watch whose space or an ancestor is archived, and reads only its own integration', async () => {
    const integrationId = await anIntegration()
    const other = await anIntegration()
    const parent = await aSpace()
    const child = await aSpace(parent)
    const live = await aSpace()
    await aWatch(integrationId, child.id, 60)
    const kept = await aWatch(integrationId, live.id, 60)
    await aWatch(other, live.id, 60)
    await db
      .update(space)
      .set({ archivedAt: new Date() })
      .where(eq(space.entityId, parent.id))
    const due = await Effect.runPromise(dueWatchesProgram(integrationId, now))
    expect(due.map((d) => d.watchId)).toEqual([kept])
  })
})

describe('runWatchNowProgram', () => {
  it('sends at once onto the plugin watch queue, keyed by the watch, cadence or not', async () => {
    const integrationId = await anIntegration()
    const s = await aSpace()
    const manual = await aWatch(integrationId, s.id, null)
    const scheduled = await aWatch(integrationId, s.id, 60)
    const { sent, layer } = recording()
    for (const id of [manual, scheduled]) {
      const exit = await runNow(id, layer)
      expect(Exit.isSuccess(exit) && exit.value).toEqual({
        status: 'queued',
        queue: 'plugin.watcher.lens',
        jobId: `job-${sent.length}`,
      })
    }
    expect(sent).toEqual([
      {
        queue: 'plugin.watcher.lens',
        data: { watchId: manual, spaceId: s.id },
        options: { singletonKey: manual },
      },
      {
        queue: 'plugin.watcher.lens',
        data: { watchId: scheduled, spaceId: s.id },
        options: { singletonKey: scheduled },
      },
    ])
  })

  it('sends nothing for an archived space, a stopped plugin, one with no watch job, or a gone watch', async () => {
    const { sent, layer } = recording()
    const parent = await aSpace()
    const child = await aSpace(parent)
    const integrationId = await anIntegration()
    const archived = await aWatch(integrationId, child.id, 60)
    await db
      .update(space)
      .set({ archivedAt: new Date() })
      .where(eq(space.entityId, parent.id))
    expect(refusedWith(await runNow(archived, layer))).toMatchObject({
      _tag: 'WatchRunRefused',
      message: 'The space is archived — restore it to run its watches',
    })

    const live = await aSpace()
    const stopped = await anIntegration()
    await db
      .update(integration)
      .set({ status: 'degraded' })
      .where(eq(integration.id, stopped))
    expect(
      refusedWith(await runNow(await aWatch(stopped, live.id, null), layer)),
    ).toMatchObject({ _tag: 'WatchRunRefused' })

    const noWatch = await anIntegration({
      manifest: { ...manifest, jobs: {} },
    })
    expect(
      refusedWith(await runNow(await aWatch(noWatch, live.id, null), layer)),
    ).toMatchObject({ message: 'That plugin no longer offers a watch' })

    expect(
      refusedWith(await runNow('00000000-0000-4000-8000-000000000000', layer)),
    ).toMatchObject({ message: 'That watch is gone' })
    expect(sent).toEqual([])
  })
})

describe('watchRunTallyProgram', () => {
  const aCompany = async (name: string, spaceId: string | null) => {
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: name })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('no company')
    if (spaceId !== null)
      await db.insert(entitySpace).values({ entityId: ent.id, spaceId })
    return ent.id
  }

  it('counts the cards born citing the watch and its signals on members, since the run began', async () => {
    const root = await aSpace()
    const sub = await aSpace(root)
    const integrationId = await anIntegration()
    const watchId = await aWatch(integrationId, root.id, null)
    const other = await aWatch(integrationId, root.id, null)
    const since = new Date(Date.now() - 60_000)
    const before = new Date(since.getTime() - 60_000)
    const card = (domain: string, watchIds: Array<string>, at: Date) => ({
      kind: 'add_record' as const,
      entityId: null,
      payload: { spaceId: root.id, domain, name: domain, watchIds },
      proposedByType: 'integration' as const,
      proposedById: integrationId,
      createdAt: at,
    })
    await db
      .insert(suggestion)
      .values([
        card('a.example', [watchId], new Date()),
        card('b.example', [other, watchId], new Date()),
        card('c.example', [other], new Date()),
        card('d.example', [watchId], before),
      ])
    const member = await aCompany('Varda', sub.id)
    const outsider = await aCompany('Elsewhere', null)
    const emitted = (entityId: string, at: Date) => ({
      entityId,
      source: 'watcher',
      payload: { kind: 'web' },
      sourceClass: 'integration' as const,
      sourceRef: integrationId,
      observedAt: at,
    })
    await db
      .insert(signal)
      .values([
        emitted(member, new Date()),
        emitted(outsider, new Date()),
        emitted(member, before),
      ])

    const tally = await Effect.runPromise(
      watchRunTallyProgram({ watchId, integrationId, spaceId: root.id }, since),
    )
    expect(tally).toEqual({ cards: 2, signals: 1 })
    expect(watchRunSummary(tally)).toBe('3 found · 2 cards')
    expect(watchRunSummary({ cards: 1, signals: 0 })).toBe('1 found · 1 card')
  })
})
