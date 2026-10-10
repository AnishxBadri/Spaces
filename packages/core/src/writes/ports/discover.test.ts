import { Cause, Effect, Exit } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  space,
  spaceWatch,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import { Discover, JobPermanent } from '@spaces/sdk'
import type { DiscoverClaim, Ref } from '@spaces/sdk'
import { readAddRecordPayload, readFileRecordPayload } from '../../ai/discovery'
import { previewResolve, resolveEntity } from '../entities/resolve'
import type { PreviewResolveInput } from '../entities/resolve'
import { DiscoverBinder, DiscoverLive, discoverWith } from './discover'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * The Discover hand-back against a real database: the three checks in
 * order — dismissed, member, open card — with a spy on the identity
 * lookup, and one open card per (space, domain) that later finds merge into.
 */

let n = 0
const tag = () => `${String(++n)}${Math.random().toString(36).slice(2, 6)}`

const aSpace = async (name: string, parent?: { id: string; path: string }) => {
  const slug = `d${tag()}`
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
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

const aCompany = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId })

const anIntegration = async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: `discover${tag()}`, version: '0.1.0' })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

const aWatch = async (spaceId: string, integrationId: string) => {
  const row = (
    await db
      .insert(spaceWatch)
      .values({ spaceId, integrationId, settings: { lens: tag() } })
      .returning({ id: spaceWatch.id })
  ).at(0)
  if (!row) throw new Error('no watch')
  return row.id
}

/** A spy over the live identity lookup. */
const spied = () => {
  const preview = vi.fn((input: PreviewResolveInput) => previewResolve(input))
  return { preview }
}

const claimOf = (
  spaceId: string,
  name: string,
  domain: string,
  extra: Partial<DiscoverClaim> = {},
): DiscoverClaim => ({
  spaceId,
  name,
  domain,
  evidence: [{ url: `https://news.example/${domain}`, title: name }],
  ...extra,
})

const cardsFor = (spaceId: string) =>
  db
    .select()
    .from(suggestion)
    .where(sql`${suggestion.payload} ->> 'spaceId' = ${spaceId}`)

describe('Discover.candidate — the three checks', () => {
  it('drops a member of the space or a descendant, files a company held elsewhere, adds an unknown one', async () => {
    const proposer = await anIntegration()
    const launch = await aSpace('Launch')
    const reentry = await aSpace('Re-entry', launch)
    const elsewhere = await aSpace('Elsewhere')
    const t = tag()
    const varda = await aCompany('Varda', `varda${t}.com`)
    await file(varda, reentry.id)
    const redwire = await aCompany('Redwire', `redwire${t}.com`)
    await file(redwire, elsewhere.id)
    const watchId = await aWatch(launch.id, proposer)
    const deps = spied()
    const run = (claim: DiscoverClaim) =>
      discoverWith(
        { claim, proposedBy: { type: 'integration', id: proposer }, watchId },
        deps,
      )

    expect(
      await run(
        claimOf(launch.id, 'Varda Space', `https://www.varda${t}.com/`),
      ),
    ).toEqual({ outcome: 'member', entityId: varda })

    const filed = await run(claimOf(launch.id, 'Redwire', `redwire${t}.com`))
    if (filed.outcome !== 'proposed') throw new Error('expected a card')
    expect(filed.suggestion).toMatchObject({
      kind: 'file_record',
      entityId: redwire,
      status: 'open',
      proposedByType: 'integration',
      proposedById: proposer,
    })
    expect(readFileRecordPayload(filed.suggestion.payload)).toMatchObject({
      spaceId: launch.id,
      domain: `redwire${t}.com`,
      entityId: redwire,
      watchIds: [watchId],
    })

    const added = await run(
      claimOf(launch.id, 'Orbital Unknown', `orbital${t}.io`, {
        aliases: ['Orbital'],
        subspaceHint: 'Re-entry',
      }),
    )
    if (added.outcome !== 'proposed') throw new Error('expected a card')
    expect(added.suggestion).toMatchObject({
      kind: 'add_record',
      entityId: null,
    })
    expect(readAddRecordPayload(added.suggestion.payload)).toMatchObject({
      name: 'Orbital Unknown',
      domain: `orbital${t}.io`,
      aliases: ['Orbital'],
      subspaceHint: 'Re-entry',
      evidence: [{ url: `https://news.example/orbital${t}.io` }],
    })

    expect(deps.preview).toHaveBeenCalledTimes(3)
    expect(deps.preview.mock.calls.map(([c]) => c.keys?.domain)).toEqual([
      `varda${t}.com`,
      `redwire${t}.com`,
      `orbital${t}.io`,
    ])
    // Varda left no card; Redwire and the unknown one each have one.
    expect((await cardsFor(launch.id)).map((c) => c.kind).sort()).toEqual([
      'add_record',
      'file_record',
    ])
  })

  it('a dismissed domain returns before the identity lookup and writes nothing', async () => {
    const launch = await aSpace('Dismissing')
    const domain = `gone${tag()}.com`
    await db.insert(spaceWatchDismissal).values({
      spaceId: launch.id,
      domain,
      dismissedBy: FIXTURE_ACTOR.id,
    })
    const deps = spied()
    const out = await discoverWith(
      {
        claim: claimOf(launch.id, 'Gone', `https://${domain}/about`),
        proposedBy: { type: 'system' },
        watchId: null,
      },
      deps,
    )
    expect(out).toEqual({ outcome: 'dismissed' })
    expect(deps.preview).not.toHaveBeenCalled()
    expect(await cardsFor(launch.id)).toEqual([])
  })

  it('merges a later find of the domain into the open card: both sets of evidence, both watches, the refs', async () => {
    const proposer = await anIntegration()
    const launch = await aSpace('Merging')
    const first = await aWatch(launch.id, proposer)
    const second = await aWatch(launch.id, proposer)
    const domain = `twice${tag()}.ai`
    const find = (watchId: string, url: string, refs: Array<Ref>) =>
      discoverWith({
        claim: claimOf(launch.id, 'Twice', domain, {
          evidence: [
            { url, title: url },
            // Shared by every find: kept once.
            { url: `https://shared.example/${domain}` },
          ],
          refs,
        }),
        proposedBy: { type: 'integration', id: proposer },
        watchId,
      })

    const a = await find(first, 'https://a.example/1', ['event:sig-1'])
    const again = await find(first, 'https://a.example/2', [])
    const b = await find(second, 'https://b.example/1', ['event:sig-2'])
    if (a.outcome !== 'proposed') throw new Error('expected a card')
    expect(again.outcome).toBe('merged')
    expect(b.outcome).toBe('merged')
    if (b.outcome !== 'merged') throw new Error('expected a merge')
    expect(b.suggestion.id).toBe(a.suggestion.id)

    const cards = await cardsFor(launch.id)
    expect(cards).toHaveLength(1)
    const card = readAddRecordPayload(cards.at(0)?.payload)
    expect(card?.evidence.map((e) => e.url)).toEqual([
      'https://a.example/1',
      `https://shared.example/${domain}`,
      'https://a.example/2',
      'https://b.example/1',
    ])
    expect(card?.watchIds).toEqual([first, second])
    expect(cards.at(0)?.refs).toEqual(['event:sig-1', 'event:sig-2'])
  })
})

describe('DiscoverLive', () => {
  const candidate = (claim: DiscoverClaim) =>
    Effect.gen(function* () {
      return yield* (yield* Discover).candidate(claim)
    })

  it('answers only the watch run it is bound to, as the bound integration', async () => {
    const proposer = await anIntegration()
    const launch = await aSpace('Bound')
    const other = await aSpace('Other')
    const watchId = await aWatch(launch.id, proposer)
    const layer = DiscoverLive({ id: proposer })
    const domain = `bound${tag()}.com`

    const bound = await Effect.runPromise(
      Effect.gen(function* () {
        const binder = yield* DiscoverBinder
        const port = binder.bind({ watchId, spaceId: launch.id })
        const made = yield* port.candidate(claimOf(launch.id, 'Bound', domain))
        const elsewhere = yield* Effect.exit(
          port.candidate(claimOf(other.id, 'Bound', domain)),
        )
        return { made, elsewhere }
      }).pipe(Effect.provide(layer)),
    )
    expect(bound.made.suggestionId).not.toBeNull()
    const row = (
      await db
        .select()
        .from(suggestion)
        .where(
          and(
            eq(suggestion.id, bound.made.suggestionId ?? ''),
            eq(suggestion.proposedById, proposer),
          ),
        )
    ).at(0)
    expect(row?.proposedByType).toBe('integration')
    expect(Exit.isFailure(bound.elsewhere)).toBe(true)
    if (Exit.isFailure(bound.elsewhere))
      expect(Cause.squash(bound.elsewhere.cause)).toBeInstanceOf(JobPermanent)

    // Unbound — not a watch run — it refuses.
    const unbound = await Effect.runPromiseExit(
      candidate(claimOf(launch.id, 'Bound', domain)).pipe(
        Effect.provide(layer),
      ),
    )
    expect(Exit.isFailure(unbound)).toBe(true)
    if (Exit.isFailure(unbound))
      expect(Cause.squash(unbound.cause)).toMatchObject({
        reason: expect.stringContaining(
          'only a watch run hands back candidates',
        ),
      })
  })

  it('refuses an archived space permanently and writes nothing', async () => {
    const proposer = await anIntegration()
    const shelved = await aSpace('Shelved')
    const watchId = await aWatch(shelved.id, proposer)
    await db
      .update(space)
      .set({ archivedAt: new Date() })
      .where(eq(space.entityId, shelved.id))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const port = (yield* DiscoverBinder).bind({
          watchId,
          spaceId: shelved.id,
        })
        return yield* port.candidate(
          claimOf(shelved.id, 'Late', `late${tag()}.com`),
        )
      }).pipe(Effect.provide(DiscoverLive({ id: proposer }))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toBeInstanceOf(JobPermanent)
    expect(await cardsFor(shelved.id)).toEqual([])
  })
})
