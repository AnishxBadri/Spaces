import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity, integration, space } from '@spaces/db/schema'
import type { IntegrationConfig } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { birthDealProgram, dealFromDialog } from '#/lib/deals/birth'
import { insertSpaceTag } from '#/lib/spaces/tag'
import { emitDomainEvent } from './emit'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Web's writes emit their domain events through `webEnqueue` once they have
 * committed, and the dispatcher sends only what the row's auto-enrich scope
 * covers: `createCompany` (`entity.created`), `createDeal` (the deal's
 * `entity.created` and its company's `deal.linked`) and a space tag
 * (`filed`). (D65, D76)
 */

const QUEUE = 'plugin.apollo.autoEnrich'

/** Apollo's event job as the loader stores it, its config per test. */
const installApollo = (config: IntegrationConfig) =>
  db.insert(integration).values({
    capabilityId: 'apollo',
    version: '0.1.0',
    enabled: true,
    status: 'enabled',
    config,
    manifest: {
      manifestVersion: 1,
      id: 'apollo',
      version: '0.1.0',
      sdk: '^1.2',
      name: 'Apollo',
      description: 'Enrichment.',
      settings: {},
      jobs: {
        autoEnrich: {
          trigger: 'event',
          on: ['entity.created', 'filed', 'deal.linked'],
          uses: ['Read'],
        },
      },
    },
  })

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(integration).where(eq(integration.capabilityId, 'apollo'))
})

let n = 0
const domain = () => `emit-${Date.now()}-${++n}.example`

/** `createCompany`'s handler below `requireUser`. */
const createCompany = async (keys: { domain?: string }) => {
  const result = await resolveEntity({
    kind: 'company',
    name: `Emit ${++n}`,
    keys,
    source: { class: 'manual' },
    createdBy: FIXTURE_ACTOR.id,
  })
  await emitDomainEvent(result.emit)
  return result
}

/** `createDeal`'s handler below `requireUser`. */
const createDeal = (companyId: string) =>
  Effect.runPromise(
    birthDealProgram(
      dealFromDialog({ companyId, name: 'Seed round' }, FIXTURE_ACTOR.id),
    ),
  )

/** `tagIntoSpace`'s handler below `requireUser`. */
const tagIntoSpace = async (entityId: string, spaceId: string) => {
  const { emit } = await db.transaction((tx) =>
    insertSpaceTag(tx, {
      entityId,
      spaceId,
      source: 'manual',
      confidence: null,
      createdBy: FIXTURE_ACTOR.id,
    }),
  )
  await emitDomainEvent(emit)
}

const aSpace = async (slug: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: slug, sourceClass: 'manual' })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  await db.insert(space).values({ entityId: ent.id, slug, path: slug })
  return ent.id
}

const eventsSent = () => enqueued.filter((e) => e.name === QUEUE)

describe('createCompany', () => {
  it('a company on no deal and in no space is outside the deal scope: nothing runs', async () => {
    await installApollo({ autoEnrich: true })
    await createCompany({ domain: domain() })
    expect(eventsSent()).toEqual([])
  })

  it('a seeded or imported company emits nothing', async () => {
    await installApollo({ autoEnrichScopes: ['deal', 'space'] })
    const seeded = await resolveEntity({
      kind: 'company',
      name: 'Seeded',
      keys: { domain: domain() },
      source: { class: 'import' },
    })
    await emitDomainEvent(seeded.emit)
    expect(seeded.emit).toBeNull()
    expect(eventsSent()).toEqual([])
  })
})

describe('createDeal', () => {
  it.each([
    ['the legacy switch on', { autoEnrich: true }],
    ['the default', {}],
    ['the deal scope', { autoEnrichScopes: ['deal'] }],
  ])(
    'with %s, the company joining the deal is enriched once',
    async (_, config) => {
      await installApollo(config)
      const company = await createCompany({ domain: domain() })
      const deal = await createDeal(company.entityId)
      expect(eventsSent().map((e) => e.data)).toEqual([
        {
          event: {
            name: 'deal.linked',
            entityId: company.entityId,
            kind: 'company',
            dealId: deal.id,
            occurredAt: expect.any(String),
          },
        },
      ])
    },
  )

  it('outside the deal scope, a new deal runs nothing', async () => {
    await installApollo({ autoEnrich: false })
    const company = await createCompany({ domain: domain() })
    await createDeal(company.entityId)
    expect(eventsSent()).toEqual([])
  })

  it('an imported deal emits nothing', async () => {
    await installApollo({ autoEnrichScopes: ['deal'] })
    const company = await resolveEntity({
      kind: 'company',
      name: 'Imported Target',
      keys: { domain: domain() },
      source: { class: 'import' },
    })
    await Effect.runPromise(
      birthDealProgram({
        name: 'Imported round',
        companyId: company.entityId,
        actorId: FIXTURE_ACTOR.id,
        source: 'import',
      }),
    )
    expect(eventsSent()).toEqual([])
  })
})

describe('tagIntoSpace', () => {
  it('filing into a chosen space runs once; into another, or again, nothing', async () => {
    const chosen = await aSpace(`chosen_${++n}`)
    const other = await aSpace(`other_${n}`)
    await installApollo({
      autoEnrichScopes: ['space'],
      autoEnrichSpaces: [chosen],
    })
    const company = await createCompany({ domain: domain() })
    await tagIntoSpace(company.entityId, chosen)
    expect(eventsSent().map((e) => e.data)).toEqual([
      {
        event: {
          name: 'filed',
          entityId: company.entityId,
          kind: 'company',
          spaceId: chosen,
          occurredAt: expect.any(String),
        },
      },
    ])
    await tagIntoSpace(company.entityId, chosen)
    await tagIntoSpace(
      (await createCompany({ domain: domain() })).entityId,
      other,
    )
    expect(eventsSent()).toHaveLength(1)
  })

  it('with the deal scope only, a filing runs nothing', async () => {
    const sp = await aSpace(`deal_only_${++n}`)
    await installApollo({ autoEnrichScopes: ['deal'] })
    const company = await createCompany({ domain: domain() })
    await tagIntoSpace(company.entityId, sp)
    expect(eventsSent()).toEqual([])
  })
})
