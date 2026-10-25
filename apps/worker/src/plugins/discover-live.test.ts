import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Layer } from 'effect'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  signal,
  space,
  spaceWatch,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import type { SpaceWatchSettings } from '@spaces/db/schema'
import {
  readAddRecordPayload,
  readFileRecordPayload,
} from '@spaces/core/ai/discovery'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { JobPermanent } from '@spaces/sdk'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { FIXTURE_ACTOR } from '../../vitest.seed'

/**
 * The `Discover` port end to end through the loader: the discover fixture's
 * watch runs on its space, signals on the members through Content, and
 * hands back candidates the host turns into one card each — or nothing.
 * Invoked straight through the host; the watch suite covers the queue.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)

let host: PluginHost | null = null
let integrationId = ''

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-discover-')),
    'plugins',
  )
  const dir = path.join(root, 'discover', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'discover', 'dist', file), path.join(dir, file))
  return root
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

let n = 0
const aSpace = async (name: string) => {
  n += 1
  const slug = `disc${n}`
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  await db.insert(space).values({ entityId: ent.id, slug, path: slug })
  return ent.id
}

const aCompany = async (name: string, domain: string, spaceId: string) => {
  const { entityId } = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  await db.insert(entitySpace).values({ entityId, spaceId })
  return entityId
}

const aWatch = async (spaceId: string, settings: SpaceWatchSettings) => {
  const row = (
    await db
      .insert(spaceWatch)
      .values({ integrationId, spaceId, settings })
      .returning({ id: spaceWatch.id })
  ).at(0)
  if (!row) throw new Error('no watch')
  return row.id
}

/** One watch run, as the queue would hand it to the host. */
const run = (
  watchId: string,
  spaceId: string,
  settings: SpaceWatchSettings,
) => {
  if (host === null) throw new Error('no host')
  return Effect.runPromiseExit(
    host.invoke(integrationId, 'find', {
      watchId,
      spaceId,
      settings,
      state: null,
    }),
  )
}

const openCards = (spaceId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      sql`${suggestion.payload} ->> 'spaceId' = ${spaceId} and ${suggestion.status} = 'open'`,
    )

beforeAll(async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'discover', version: '0.1.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  integrationId = row.id
  host = makePluginHost({ enqueue: noEnqueue })
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: newPluginsRoot() }),
  )
  const verdicts = await Effect.runPromise(host.wire(loaded))
  expect(verdicts.map((v) => [v.id, v.status])).toEqual([
    ['discover', 'enabled'],
  ])
})

afterAll(async () => {
  if (host !== null) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

describe('the discover fixture', () => {
  it('is granted exactly what it declares', () => {
    expect(host?.granted(integrationId, 'find')).toEqual([
      'Content',
      'Discover',
      'Log',
      'Spaces',
    ])
  })

  it('a space holding Varda: nothing for Varda, "file Redwire here?", "add the unknown?" — and a dismissed unknown stays gone', async () => {
    const launch = await aSpace('Launch')
    const elsewhere = await aSpace('Defense')
    const varda = await aCompany('Varda', 'varda.example', launch)
    const redwire = await aCompany('Redwire', 'redwire.example', elsewhere)
    const settings = {
      candidates: [
        {
          name: 'Varda Space Industries',
          domain: 'varda.example',
          evidence: [{ url: 'https://news.example/varda' }],
        },
        {
          name: 'Redwire',
          domain: 'redwire.example',
          evidence: [{ url: 'https://news.example/redwire', title: 'Redwire' }],
        },
        {
          name: 'Orbit Unknown',
          domain: 'orbit-unknown.example',
          evidence: [{ url: 'https://news.example/orbit', title: 'Orbit' }],
        },
      ],
    }
    const watchId = await aWatch(launch, settings)
    const first = await run(watchId, launch, settings)
    expect(Exit.isSuccess(first)).toBe(true)

    // The member's signal carries the integration row as its provenance.
    const signals = await db
      .select()
      .from(signal)
      .where(eq(signal.entityId, varda))
    expect(signals).toMatchObject([
      { sourceClass: 'integration', sourceRef: integrationId },
    ])

    const cards = await openCards(launch)
    expect(cards.map((c) => c.kind).sort()).toEqual([
      'add_record',
      'file_record',
    ])
    const filed = cards.find((c) => c.kind === 'file_record')
    expect(filed).toMatchObject({
      entityId: redwire,
      proposedByType: 'integration',
      proposedById: integrationId,
    })
    expect(readFileRecordPayload(filed?.payload)?.watchIds).toEqual([watchId])
    const added = cards.find((c) => c.kind === 'add_record')
    expect(readAddRecordPayload(added?.payload)).toMatchObject({
      name: 'Orbit Unknown',
      domain: 'orbit-unknown.example',
    })

    // A second watch on the space finds the unknown again: one card, two watches.
    const second = await aWatch(launch, {
      candidates: [settings.candidates[2]],
    })
    expect(
      Exit.isSuccess(
        await run(second, launch, { candidates: [settings.candidates[2]] }),
      ),
    ).toBe(true)
    const merged = await openCards(launch)
    expect(merged).toHaveLength(2)
    expect(
      readAddRecordPayload(merged.find((c) => c.kind === 'add_record')?.payload)
        ?.watchIds,
    ).toEqual([watchId, second])

    // Dismissed, then run again: it stays gone.
    await db.insert(spaceWatchDismissal).values({
      spaceId: launch,
      domain: 'orbit-unknown.example',
      dismissedBy: FIXTURE_ACTOR.id,
    })
    await db
      .update(suggestion)
      .set({
        status: 'rejected',
        decidedBy: FIXTURE_ACTOR.id,
        decidedAt: new Date(),
      })
      .where(eq(suggestion.id, added?.id ?? ''))
    expect(Exit.isSuccess(await run(watchId, launch, settings))).toBe(true)
    expect((await openCards(launch)).map((c) => c.kind)).toEqual([
      'file_record',
    ])
  })

  it('a watch that reaches for Facts fails service-not-found and writes nothing', async () => {
    const s = await aSpace('Overreach')
    const settings = { reachForFacts: true }
    const watchId = await aWatch(s, settings)
    const exit = await run(watchId, s, settings)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(JobPermanent)
      expect(error).toMatchObject({
        reason: expect.stringContaining(
          'used Facts, which its manifest does not grant it',
        ),
      })
    }
    expect(await openCards(s)).toEqual([])
  })
})
