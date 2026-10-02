import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration, jobRun } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { z } from 'zod'
import { jsonRecord, jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { mergeEntities } from '../entities/merge'
import { resolveEntity, resolveEntityInTx } from '../entities/resolve'
import type { ResolveSource } from '../entities/resolve'
import {
  dispatchDomainEvent,
  entityCreated,
  subscribedQueues,
} from './dispatch'

/**
 * `entity.created` from the births that emit it to the plugin queues that
 * subscribe to it, on a recording `Enqueue`. (D65)
 */

const sent: Array<{ queue: string; data: unknown }> = []
const recording = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data) =>
      Effect.sync(() => {
        sent.push({ queue, data })
        return `job-${sent.length}`
      }),
  }),
)
// The harness isolates files, not tests: each test installs its own row.
beforeEach(async () => {
  sent.length = 0
  await db.delete(integration).where(eq(integration.capabilityId, 'apollo'))
})

const dispatch = (event: DomainEvent | null) =>
  Effect.runPromise(dispatchDomainEvent(event).pipe(Effect.provide(recording)))

const apollo = toManifestJson(
  defineManifest({
    manifestVersion: 1,
    id: 'apollo',
    version: '0.1.0',
    sdk: '^1.0',
    name: 'Apollo',
    description: 'Enrichment.',
    settings: z.object({ autoEnrich: z.boolean().default(false) }),
    jobs: {
      enrichCompany: { trigger: 'action', uses: ['Read'] },
      onCompanyCreated: {
        trigger: 'event',
        on: ['entity.created'],
        uses: ['Read'],
      },
    },
  }),
)

type Row = {
  enabled?: boolean
  status?: 'installing' | 'enabled' | 'degraded' | 'disabled'
  config?: { [k: string]: string | boolean }
  manifest?: unknown
}

const install = async (row: Row = {}) => {
  await db.insert(integration).values({
    capabilityId: 'apollo',
    version: '0.1.0',
    enabled: row.enabled ?? true,
    status: row.status ?? 'enabled',
    config: row.config ?? { autoEnrich: true },
    manifest: jsonRecord(jsonValue.parse(row.manifest ?? apollo)),
  })
}

const manual: ResolveSource = { class: 'manual' }
let n = 0
const domain = () => `born-${Date.now()}-${++n}.example`

describe('entityCreated', () => {
  it('is null for a seed or an import birth and an event for any other', () => {
    expect(entityCreated('e', 'company', 'seed')).toBeNull()
    expect(entityCreated('e', 'company', 'import')).toBeNull()
    const at = new Date('2026-10-02T12:00:00Z')
    expect(entityCreated('e', 'deal', 'manual', at)).toEqual({
      name: 'entity.created',
      entityId: 'e',
      kind: 'deal',
      occurredAt: '2026-10-02T12:00:00.000Z',
    })
    expect(entityCreated('e', 'person', 'integration')?.kind).toBe('person')
  })
})

describe('resolveEntity hands back the birth it emits', () => {
  it('a manual company: entity.created, kind company, once', async () => {
    const born = await resolveEntity({
      kind: 'company',
      name: 'Born Co',
      keys: { domain: domain() },
      source: manual,
    })
    expect(born.action).toBe('created')
    expect(born.emit).toMatchObject({
      name: 'entity.created',
      entityId: born.entityId,
      kind: 'company',
    })
  })

  it('an attach emits nothing', async () => {
    const d = domain()
    await resolveEntity({
      kind: 'company',
      keys: { domain: d },
      source: manual,
    })
    const again = await resolveEntity({
      kind: 'company',
      name: 'Again',
      keys: { domain: d },
      source: manual,
    })
    expect(again.action).toBe('attached')
    expect(again.emit).toBeNull()
  })

  it.each(['seed', 'import'] as const)(
    'a %s birth emits nothing',
    async (c) => {
      const born = await resolveEntity({
        kind: 'company',
        keys: { domain: domain() },
        source: { class: c },
      })
      expect(born.action).toBe('created')
      expect(born.emit).toBeNull()
    },
  )

  it('in a caller transaction: the event waits for the caller to dispatch', async () => {
    const out = await db.transaction((tx) =>
      resolveEntityInTx(tx, {
        kind: 'person',
        name: 'Ada Born',
        keys: { email: `ada-${++n}@born.example` },
        source: manual,
      }),
    )
    expect(out.emit).toMatchObject({ kind: 'person', entityId: out.entityId })
    const imported = await db.transaction((tx) =>
      resolveEntityInTx(tx, {
        kind: 'company',
        keys: { domain: domain() },
        source: { class: 'import' },
      }),
    )
    expect(imported.emit).toBeNull()
  })
})

describe('dispatchDomainEvent', () => {
  const event = (): DomainEvent => ({
    name: 'entity.created',
    entityId: '00000000-0000-4000-8000-000000000001',
    kind: 'company',
    occurredAt: '2026-10-02T12:00:00.000Z',
  })

  it('with autoEnrich on, enqueues the subscribed event job once, in the worker’s shape', async () => {
    await install()
    expect(await dispatch(event())).toEqual(['plugin.apollo.onCompanyCreated'])
    expect(sent).toEqual([
      { queue: 'plugin.apollo.onCompanyCreated', data: { event: event() } },
    ])
  })

  it.each([
    ['absent', {}],
    ['off', { autoEnrich: false }],
    ['not a boolean', { autoEnrich: 'true' }],
  ])('with autoEnrich %s, enqueues nothing', async (_, config) => {
    await install({ config })
    expect(await dispatch(event())).toEqual([])
    expect(sent).toEqual([])
  })

  it('with no subscribers, enqueues nothing and no job runs', async () => {
    await install({
      manifest: {
        ...apollo,
        jobs: { enrichCompany: apollo.jobs.enrichCompany },
      },
    })
    expect(await dispatch(event())).toEqual([])
    expect(sent).toEqual([])
    expect(await db.select().from(jobRun)).toEqual([])
  })

  it.each([
    ['degraded', { status: 'degraded' }],
    ['operator-disabled', { enabled: false }],
    ['breaker-tripped', { status: 'disabled' }],
    ['still installing', { status: 'installing' }],
  ] as const)('skips a %s subscriber', async (_, row) => {
    await install(row)
    expect(await dispatch(event())).toEqual([])
    expect(sent).toEqual([])
  })

  it('skips a row whose manifest does not parse', async () => {
    await install({ manifest: { id: 'apollo' } })
    expect(await dispatch(event())).toEqual([])
  })

  it('names the interactive queue for an interactive event job', () => {
    const interactive = {
      ...apollo,
      jobs: {
        onCompanyCreated: {
          ...apollo.jobs.onCompanyCreated,
          interactive: true,
        },
      },
    }
    expect(
      subscribedQueues(event(), [
        { config: { autoEnrich: true }, manifest: interactive },
      ]),
    ).toEqual(['plugin.apollo.onCompanyCreated.interactive'])
  })

  it('never raises into the write that emitted it', async () => {
    await install()
    const dying = Layer.succeed(
      Enqueue,
      Enqueue.of({ enqueue: () => Effect.die(new Error('queue gone')) }),
    )
    await expect(
      Effect.runPromise(
        dispatchDomainEvent(event()).pipe(Effect.provide(dying)),
      ),
    ).resolves.toEqual([])
  })

  it('a null event reads nothing and sends nothing', async () => {
    await install()
    expect(await dispatch(null)).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('end to end through resolveEntity', () => {
  it('a manual birth with a domain enqueues the job; an attach and a merge add nothing', async () => {
    await install()
    const a = await resolveEntity({
      kind: 'company',
      name: 'Winner',
      keys: { domain: domain() },
      source: manual,
    })
    const loserDomain = domain()
    const b = await resolveEntity({
      kind: 'company',
      name: 'Loser',
      keys: { domain: loserDomain },
      source: manual,
    })
    await dispatch(a.emit)
    await dispatch(b.emit)
    expect(sent.map((s) => s.queue)).toEqual([
      'plugin.apollo.onCompanyCreated',
      'plugin.apollo.onCompanyCreated',
    ])

    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('the core seed has a fixture user')
    await mergeEntities({
      winnerId: a.entityId,
      loserId: b.entityId,
      mergedBy: actor.id,
    })
    const reResolved = await resolveEntity({
      kind: 'company',
      keys: { domain: loserDomain },
      source: manual,
    })
    expect(reResolved).toMatchObject({
      action: 'attached',
      entityId: a.entityId,
      emit: null,
    })
    await dispatch(reResolved.emit)
    expect(sent).toHaveLength(2)
  })
})
