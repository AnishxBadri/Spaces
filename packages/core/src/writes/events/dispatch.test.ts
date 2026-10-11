import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  jobRun,
  space,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { workspace } from '@spaces/db/schema/workspace'
import type { Json } from '@spaces/db/json'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { z } from 'zod'
import { jsonRecord, jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { setValues } from '../attributes/values'
import { enrichmentRow } from '../enrichment/apply'
import { mergeEntities } from '../entities/merge'
import { resolveEntity, resolveEntityInTx } from '../entities/resolve'
import type { ResolveSource } from '../entities/resolve'
import {
  dealLinked,
  dispatchDomainEvent,
  entityCreated,
  filed,
  subscribedQueues,
} from './dispatch'

/**
 * The domain events from the writes that emit them to the plugin queues that
 * subscribe to them, gated by the row's auto-enrich scope, on a recording
 * `Enqueue`. (D65, D76)
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
/** The built-in Website out of every scope: these tests watch the plugin queues. */
const websiteOff = async () => ({
  [(await enrichmentRow()).id]: { scopes: [], spaces: [] },
})

const setScopes = async (scopes: { [id: string]: Json }) => {
  const settings = { enrichment: { scopes } }
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

// The harness isolates files, not tests: each test installs its own row.
beforeEach(async () => {
  sent.length = 0
  await db.delete(integration).where(eq(integration.capabilityId, 'apollo'))
  await setScopes(await websiteOff())
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
    settings: z.object({}),
    jobs: {
      enrichCompany: { trigger: 'action', uses: ['Read'] },
      onCompanyCreated: {
        trigger: 'event',
        on: ['entity.created', 'filed', 'deal.linked'],
        uses: ['Read'],
      },
    },
  }),
)

type Row = {
  enabled?: boolean
  status?: 'installing' | 'enabled' | 'degraded' | 'disabled'
  config?: { [k: string]: string | boolean | Array<string> }
  manifest?: unknown
}

const install = async (row: Row = {}) => {
  await db.insert(integration).values({
    capabilityId: 'apollo',
    version: '0.1.0',
    enabled: row.enabled ?? true,
    status: row.status ?? 'enabled',
    config: row.config ?? { autoEnrichScopes: ['deal'] },
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

const actorId = async () => {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('the core seed has a fixture user')
  return row.id
}

/** A space, under `parent` when given — written as core's other fixtures write one. */
const aSpace = async (slug: string, parent?: { id: string; path: string }) => {
  const ent = (
    await db
      .insert(entity)
      .values({
        kind: 'space',
        canonicalName: slug,
        sourceClass: 'manual',
        createdBy: await actorId(),
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const path = parent === undefined ? slug : `${parent.path}.${slug}`
  await db.insert(space).values({
    entityId: ent.id,
    parentId: parent?.id ?? null,
    slug,
    path,
  })
  return { id: ent.id, path }
}

const aCompany = async (name: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain: domain() },
      source: manual,
    })
  ).entityId

/** A deal on `companyId`, its parties handed back as the write found them. */
const aDeal = async (companyId: string) => {
  const deal = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: 'Deal', sourceClass: 'manual' })
      .returning({ id: entity.id })
  ).at(0)
  if (!deal) throw new Error('no deal')
  const written = await setValues({
    entityId: deal.id,
    patch: { company: companyId },
    actor: { type: 'user', id: await actorId() },
  })
  return { id: deal.id, parties: written.dealParties }
}

const at = new Date('2026-10-02T12:00:00Z')

describe('the events a write emits', () => {
  it('filed names the space; a kind no event names emits nothing', () => {
    expect(filed('e', 'company', 's', at)).toEqual({
      name: 'filed',
      entityId: 'e',
      kind: 'company',
      spaceId: 's',
      occurredAt: '2026-10-02T12:00:00.000Z',
    })
    expect(filed('e', 'note', 's')).toBeNull()
  })

  it('deal.linked names the deal, and is silent for a seed or an import', () => {
    const party = { dealId: 'd', entityId: 'e', kind: 'person' } as const
    expect(dealLinked(party, 'manual', at)).toEqual({
      name: 'deal.linked',
      entityId: 'e',
      kind: 'person',
      dealId: 'd',
      occurredAt: '2026-10-02T12:00:00.000Z',
    })
    expect(dealLinked(party, 'seed')).toBeNull()
    expect(dealLinked(party, 'import')).toBeNull()
  })

  it('setValues hands back a deal’s new parties, and only the new ones', async () => {
    const acme = await aCompany('Party Co')
    const deal = await aDeal(acme)
    expect(deal.parties).toEqual([
      { dealId: deal.id, entityId: acme, kind: 'company' },
    ])
    const ada = (
      await resolveEntity({
        kind: 'person',
        name: 'Ada Party',
        keys: { email: `ada-party-${++n}@born.example` },
        source: manual,
      })
    ).entityId
    const again = await setValues({
      entityId: deal.id,
      patch: { company: acme, people: [ada] },
      actor: { type: 'user', id: await actorId() },
    })
    expect(again.dealParties).toEqual([
      { dealId: deal.id, entityId: ada, kind: 'person' },
    ])
  })
})

describe('dispatchDomainEvent', () => {
  const event = (): DomainEvent => ({
    name: 'deal.linked',
    entityId: '00000000-0000-4000-8000-000000000001',
    kind: 'company',
    dealId: '00000000-0000-4000-8000-000000000002',
    occurredAt: '2026-10-02T12:00:00.000Z',
  })

  it('in the deal scope, enqueues deal.linked once, in the worker’s shape', async () => {
    await install()
    expect(await dispatch(event())).toEqual(['plugin.apollo.onCompanyCreated'])
    expect(sent).toEqual([
      { queue: 'plugin.apollo.onCompanyCreated', data: { event: event() } },
    ])
  })

  it.each([
    ['legacy autoEnrich: true', { autoEnrich: true }, 1],
    ['legacy autoEnrich: false', { autoEnrich: false }, 0],
    ['no scope keys (the default)', {}, 1],
    ['the space scope only', { autoEnrichScopes: ['space'] }, 0],
    ['the meeting scope only', { autoEnrichScopes: ['meeting'] }, 0],
    ['no scopes', { autoEnrichScopes: [] }, 0],
  ])('deal.linked with %s enqueues %i', async (_, config, count) => {
    await install({ config })
    await dispatch(event())
    expect(sent).toHaveLength(count)
  })

  it('takes the scope from the workspace’s enrichment settings over the row’s config', async () => {
    await install({ config: { autoEnrichScopes: ['deal'] } })
    const row = (
      await db
        .select({ id: integration.id })
        .from(integration)
        .where(eq(integration.capabilityId, 'apollo'))
    ).at(0)
    if (!row) throw new Error('no row')
    await setScopes({
      ...(await websiteOff()),
      [row.id]: { scopes: ['space'], spaces: [] },
    })
    expect(await dispatch(event())).toEqual([])
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
      subscribedQueues(
        event(),
        [{ config: { autoEnrich: true }, manifest: interactive }],
        { dealParty: false, filedPaths: [], chosenPaths: new Map() },
      ),
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

describe('filed, in and out of the space scope', () => {
  it('enqueues for a chosen space and a space below it, never for another', async () => {
    const fintech = await aSpace(`fintech_${++n}`)
    const payments = await aSpace(`payments_${n}`, fintech)
    const climate = await aSpace(`climate_${n}`)
    await install({
      config: { autoEnrichScopes: ['space'], autoEnrichSpaces: [fintech.id] },
    })
    const co = await aCompany('Filed Co')
    await dispatch(filed(co, 'company', fintech.id))
    await dispatch(filed(co, 'company', payments.id))
    expect(sent).toHaveLength(2)
    await dispatch(filed(co, 'company', climate.id))
    expect(sent).toHaveLength(2)
  })

  it('with no space chosen, any space is in scope', async () => {
    const anywhere = await aSpace(`anywhere_${++n}`)
    await install({ config: { autoEnrichScopes: ['space'] } })
    await dispatch(filed(await aCompany('Any Co'), 'company', anywhere.id))
    expect(sent).toHaveLength(1)
  })

  it('in the deal scope only, a filing runs nothing', async () => {
    const sp = await aSpace(`deal_only_${++n}`)
    await install({ config: { autoEnrichScopes: ['deal'] } })
    expect(
      await dispatch(filed(await aCompany('Not Deal Co'), 'company', sp.id)),
    ).toEqual([])
  })
})

describe('entity.created, in scope only as far as the record already is', () => {
  it('a company on no deal and in no space is out of every scope', async () => {
    await install({ config: { autoEnrichScopes: ['deal', 'space'] } })
    const born = await resolveEntity({
      kind: 'company',
      name: 'Loose Co',
      keys: { domain: domain() },
      source: manual,
    })
    expect(await dispatch(born.emit)).toEqual([])
  })

  it('a deal party, or a record already filed in a chosen space, is in', async () => {
    const sp = await aSpace(`born_in_${++n}`)
    await install({
      config: {
        autoEnrichScopes: ['deal', 'space'],
        autoEnrichSpaces: [sp.id],
      },
    })
    const party = await aCompany('Party Born Co')
    await aDeal(party)
    await dispatch(entityCreated(party, 'company', 'manual'))
    const filedCo = await aCompany('Filed Born Co')
    await db.insert(entitySpace).values({ entityId: filedCo, spaceId: sp.id })
    await dispatch(entityCreated(filedCo, 'company', 'manual'))
    expect(sent.map((s) => s.queue)).toEqual([
      'plugin.apollo.onCompanyCreated',
      'plugin.apollo.onCompanyCreated',
    ])
  })
})

describe('end to end: a company joins a deal', () => {
  it('in the deal scope, each new party enqueues once; re-writing the party adds nothing', async () => {
    await install()
    const a = await aCompany('Winner')
    const deal = await aDeal(a)
    for (const party of deal.parties)
      await dispatch(dealLinked(party, 'manual'))
    expect(sent).toHaveLength(1)
    expect(sent.at(0)).toMatchObject({
      data: { event: { name: 'deal.linked', entityId: a, dealId: deal.id } },
    })

    const again = await setValues({
      entityId: deal.id,
      patch: { company: a },
      actor: { type: 'user', id: await actorId() },
    })
    expect(again.dealParties).toEqual([])
  })

  it('a merge emits nothing', async () => {
    await install()
    const a = await aCompany('Merge Winner')
    const b = await aCompany('Merge Loser')
    await mergeEntities({ winnerId: a, loserId: b, mergedBy: await actorId() })
    expect(sent).toEqual([])
  })
})
