import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { birthDealProgram, dealFromDialog } from '#/lib/deals/birth'
import { emitDomainEvent } from './emit'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Web's births emit `entity.created` through `webEnqueue` once they have
 * committed: `createCompany` (resolve, then `emitDomainEvent`) and
 * `createDeal` (`birthDealProgram` on the dialog's input). (D65)
 */

const QUEUE = 'plugin.apollo.onCompanyCreated'

/** Apollo's event job as the loader stores it, `autoEnrich` per test. */
const installApollo = (autoEnrich: boolean | null) =>
  db.insert(integration).values({
    capabilityId: 'apollo',
    version: '0.1.0',
    enabled: true,
    status: 'enabled',
    config: autoEnrich === null ? {} : { autoEnrich },
    manifest: {
      manifestVersion: 1,
      id: 'apollo',
      version: '0.1.0',
      sdk: '^1.0',
      name: 'Apollo',
      description: 'Enrichment.',
      settings: {},
      jobs: {
        onCompanyCreated: {
          trigger: 'event',
          on: ['entity.created'],
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

const eventsSent = () => enqueued.filter((e) => e.name === QUEUE)

describe('createCompany', () => {
  it('with autoEnrich on, enqueues the event job once for a new company', async () => {
    await installApollo(true)
    const born = await createCompany({ domain: domain() })
    expect(eventsSent()).toEqual([
      {
        name: QUEUE,
        data: {
          event: {
            name: 'entity.created',
            entityId: born.entityId,
            kind: 'company',
            occurredAt: expect.any(String),
          },
        },
      },
    ])
  })

  it('an attach emits nothing', async () => {
    await installApollo(true)
    const d = domain()
    await createCompany({ domain: d })
    await createCompany({ domain: d })
    expect(eventsSent()).toHaveLength(1)
  })

  it.each([
    ['off', false],
    ['absent', null],
  ])('with autoEnrich %s, enqueues nothing', async (_, autoEnrich) => {
    await installApollo(autoEnrich)
    await createCompany({ domain: domain() })
    expect(eventsSent()).toEqual([])
  })

  it('a seeded or imported company emits nothing', async () => {
    await installApollo(true)
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
  it('emits entity.created with kind deal once the birth commits', async () => {
    await installApollo(true)
    const company = await resolveEntity({
      kind: 'company',
      name: 'Deal Target',
      keys: { domain: domain() },
      source: { class: 'import' },
    })
    const deal = await Effect.runPromise(
      birthDealProgram(
        dealFromDialog(
          { companyId: company.entityId, name: 'Seed round' },
          FIXTURE_ACTOR.id,
        ),
      ),
    )
    expect(eventsSent().map((e) => e.data)).toEqual([
      {
        event: {
          name: 'entity.created',
          entityId: deal.id,
          kind: 'deal',
          occurredAt: expect.any(String),
        },
      },
    ])
  })

  it('an imported deal emits nothing', async () => {
    await installApollo(true)
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
