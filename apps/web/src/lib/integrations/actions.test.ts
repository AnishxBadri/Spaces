import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity, integration } from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { requireAdmin } from '#/lib/server/shared'
import {
  declaredActions,
  fireRecordActionHandler,
  recordActionsProgram,
} from './actions'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Manifest actions in the record head (D63): read from `integration.manifest`
 * for runnable rows only, matched on the record's kind, and fired by any
 * member as one `plugin.<id>.<job>` enqueue carrying `{ entityId }`. The
 * request is stubbed; `requireUser`, the database and the decode are real.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/companies'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

/** Apollo's manifest as the loader stores it. */
const APOLLO: IntegrationManifest = {
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Apollo',
  description: 'Enrichment.',
  settings: {},
  jobs: {
    enrichCompany: { trigger: 'action', uses: ['Read'] },
    enrichPerson: { trigger: 'action', uses: ['Read'] },
    onCompanyCreated: {
      trigger: 'event',
      on: ['entity.created'],
      uses: ['Read'],
    },
  },
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
    },
    { id: 'enrich-person', label: 'Enrich', on: 'person', job: 'enrichPerson' },
  ],
}

/** A deal action on an interactive job: its queue carries `.interactive`. */
const ECHO: IntegrationManifest = {
  manifestVersion: 1,
  id: 'echo',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Echo',
  description: 'Echoes.',
  settings: {},
  jobs: { echo: { trigger: 'action', uses: ['Read'], interactive: true } },
  actions: [{ id: 'echo-deal', label: 'Echo', on: 'deal', job: 'echo' }],
}

type Status = 'installing' | 'enabled' | 'degraded' | 'disabled'

const install = async (
  manifest: IntegrationManifest,
  state: { enabled: boolean; status: Status } = {
    enabled: true,
    status: 'enabled',
  },
) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: String(manifest.id),
        version: '0.1.0',
        manifest,
        ...state,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

const record = async (kind: 'company' | 'person' | 'deal') => {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: `Action ${kind}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity row')
  return row.id
}

const actionsOn = (kind: 'company' | 'person' | 'deal') =>
  Effect.runPromise(recordActionsProgram(kind))

beforeEach(async () => {
  enqueued.length = 0
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
  await db
    .delete(integration)
    .where(inArray(integration.capabilityId, ['apollo', 'echo']))
})

describe('recordActionsProgram', () => {
  it('a company head shows Apollo’s company action and nothing declared on a person', async () => {
    const id = await install(APOLLO)
    expect(await actionsOn('company')).toEqual([
      {
        integrationId: id,
        pluginId: 'apollo',
        pluginName: 'Apollo',
        actionId: 'enrich-company',
        label: 'Enrich',
      },
    ])
    expect((await actionsOn('person')).map((a) => a.actionId)).toEqual([
      'enrich-person',
    ])
    expect(await actionsOn('deal')).toEqual([])
  })

  it.each<[string, { enabled: boolean; status: Status }]>([
    ['degraded', { enabled: true, status: 'degraded' }],
    ['tripped', { enabled: true, status: 'disabled' }],
    ['switched off', { enabled: false, status: 'enabled' }],
    ['installing', { enabled: true, status: 'installing' }],
  ])('a %s plugin offers no action', async (_, state) => {
    await install(APOLLO, state)
    expect(await actionsOn('company')).toEqual([])
    expect(await actionsOn('person')).toEqual([])
  })

  it('a manifest that no longer decodes offers nothing', async () => {
    await install({ ...APOLLO, manifestVersion: 2 })
    expect(await actionsOn('company')).toEqual([])
  })
})

describe('declaredActions', () => {
  it('names the queue the worker registers, `.interactive` included', () => {
    expect(declaredActions(APOLLO).map((a) => a.queue)).toEqual([
      'plugin.apollo.enrichCompany',
      'plugin.apollo.enrichPerson',
    ])
    expect(declaredActions(ECHO).map((a) => a.queue)).toEqual([
      'plugin.echo.echo.interactive',
    ])
  })
})

describe('fireRecordActionHandler', () => {
  it('a member enqueues plugin.<id>.<job> with the entity id, and is still refused admin', async () => {
    const integrationId = await install(APOLLO)
    const company = await record('company')
    expect(
      await fireRecordActionHandler({
        integrationId,
        actionId: 'enrich-company',
        entityId: company,
      }),
    ).toEqual({ status: 'queued', queue: 'plugin.apollo.enrichCompany' })
    expect(enqueued).toEqual([
      { name: 'plugin.apollo.enrichCompany', data: { entityId: company } },
    ])
    // Settings and keys stay behind requireAdmin for the same session.
    await expect(requireAdmin()).rejects.toThrow('Admins only')
  })

  it('an interactive job goes to its .interactive queue', async () => {
    const integrationId = await install(ECHO)
    const deal = await record('deal')
    await fireRecordActionHandler({
      integrationId,
      actionId: 'echo-deal',
      entityId: deal,
    })
    expect(enqueued).toEqual([
      { name: 'plugin.echo.echo.interactive', data: { entityId: deal } },
    ])
  })

  it('refuses an action declared on a person when fired at a company or a deal', async () => {
    const integrationId = await install(APOLLO)
    for (const kind of ['company', 'deal'] as const) {
      await expect(
        fireRecordActionHandler({
          integrationId,
          actionId: 'enrich-person',
          entityId: await record(kind),
        }),
      ).rejects.toThrow(`Enrich runs on a person, not a ${kind}`)
    }
    expect(enqueued).toEqual([])
  })

  it('refuses a plugin that stopped after the page rendered', async () => {
    const integrationId = await install(APOLLO)
    await db
      .update(integration)
      .set({ status: 'degraded', lastError: 'sdk ^0.1 does not include 1.0.0' })
      .where(eq(integration.id, integrationId))
    await expect(
      fireRecordActionHandler({
        integrationId,
        actionId: 'enrich-company',
        entityId: await record('company'),
      }),
    ).rejects.toThrow('That plugin is not running')
    expect(enqueued).toEqual([])
  })

  it('refuses an action the manifest does not declare', async () => {
    const integrationId = await install(APOLLO)
    await expect(
      fireRecordActionHandler({
        integrationId,
        actionId: 'onCompanyCreated',
        entityId: await record('company'),
      }),
    ).rejects.toThrow('no longer offers this action')
    expect(enqueued).toEqual([])
  })

  it('refuses a signed-out request before reading anything', async () => {
    session.current = null
    await expect(
      fireRecordActionHandler({
        integrationId: '00000000-0000-4000-8000-000000000000',
        actionId: 'enrich-company',
        entityId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('Unauthorized')
  })
})
