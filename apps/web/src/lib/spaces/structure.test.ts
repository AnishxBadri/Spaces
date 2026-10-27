import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  chunk,
  entity,
  entitySpace,
  link,
  note,
  space,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { QUEUES } from '@spaces/core/queue/names'
import { sensitivityFor } from '@spaces/core/writes/ai/sensitivity-for'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { renameRecordProgram } from '@spaces/core/writes/entities/rename'
import {
  MoveUnderSelf,
  SeededRootHasChildren,
  SpaceSlugCollision,
  archiveSpaceProgram,
  moveSpaceProgram,
  restoreSpaceProgram,
  spaceWriteMessage,
} from '@spaces/core/writes/entities/space'
import { enqueued } from '#/test/queue-stub'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { setEntitySensitiveProgram } from '#/lib/ai/sensitivity-for'
import { createSpaceRow } from '#/lib/server/shared'
import { recordSpaces } from './filed-in'
import { moveTargets } from './move-targets'
import { getSpaceProgram, listSpacesProgram } from './read'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Spaces are malleable: rename, archive and restore from the head, and
 * move as one path rewrite. Every reader computes from the path and the
 * archive flag at read time, so each case asserts on the readers.
 */

const me = FIXTURE_ACTOR.id
let n = 0
const tag = () => `${String(++n)}${Math.random().toString(36).slice(2, 6)}`

const aSpace = (name: string, parentId: string | null = null) =>
  createSpaceRow(`${name} ${tag()}`, parentId, me)

async function aCompany(name: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `${name} ${tag()}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(chunk).values({
    entityId: row.id,
    sourceKind: 'attribute',
    sourceKey: 'description',
    idx: 0,
    text: `${name} builds launch vehicles`,
  })
  return row.id
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId, source: 'manual' })

/** A memo filed in a space — what the assembler climbs to. */
async function aMemo(spaceId: string, title: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: title, createdBy: me })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(note).values({
    entityId: row.id,
    title,
    bodyMd: `${title} body`,
    kind: 'memo',
    authorId: me,
  })
  await db.insert(link).values({
    fromEntityId: row.id,
    toEntityId: spaceId,
    relation: 'tagged_in',
    source: 'manual',
  })
  return row.id
}

async function spaceRow(id: string) {
  const r = (
    await db
      .select({
        path: space.path,
        slug: space.slug,
        parentId: space.parentId,
        archivedAt: space.archivedAt,
      })
      .from(space)
      .where(eq(space.entityId, id))
  ).at(0)
  if (!r) throw new Error(`no space ${id}`)
  return r
}

const listed = async () =>
  (await Effect.runPromise(listSpacesProgram(me))).map((s) => s.id)

const climb = async (entityId: string) =>
  (
    await Effect.runPromise(
      assembleProgram(
        { entityId },
        { user: { id: me }, asOf: '2026-10-10T00:00:00Z', budgetChars: 8000 },
      ).pipe(Effect.provide(SimilarLaneLive)),
    )
  ).items.map((i) => i.ref)

/** The typed refusal; a success fails the test. */
const failureOf = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(Effect.flip(effect))

const filingsOf = (spaceIds: Array<string>) =>
  db
    .select({ entityId: entitySpace.entityId, spaceId: entitySpace.spaceId })
    .from(entitySpace)
    .where(inArray(entitySpace.spaceId, spaceIds))

beforeEach(() => {
  enqueued.length = 0
})

describe('rename from the space head', () => {
  it('changes the name everywhere it is read and leaves slug and path', async () => {
    const parent = await aSpace('In space mfg')
    const child = await aSpace('Orbital fabs', parent)
    const co = await aCompany('Varda')
    await file(co, parent)
    const before = await spaceRow(parent)

    await Effect.runPromise(
      renameRecordProgram(me, { id: parent, name: 'In-space manufacturing' }),
    )

    expect(await spaceRow(parent)).toEqual(before)
    const picker = await Effect.runPromise(listSpacesProgram(me))
    expect(picker.find((s) => s.id === parent)?.name).toBe(
      'In-space manufacturing',
    )
    const crumb = await Effect.runPromise(getSpaceProgram(child, me))
    expect(crumb.ancestors.map((a) => a.name)).toEqual([
      'In-space manufacturing',
    ])
    expect((await recordSpaces(co)).map((s) => s.name)).toEqual([
      'In-space manufacturing',
    ])
  })
})

describe('archive and restore', () => {
  it('archives the space and every descendant at one instant, keeps filings, and leaves the picker, the tree and the climb', async () => {
    const root = await aSpace('Launch')
    const dead = await aSpace('Small-lift', root)
    const deeper = await aSpace('Air-launch', dead)
    const co = await aCompany('Rocket Lab')
    await file(co, deeper)
    const rootMemo = await aMemo(root, 'Launch thesis')
    const deadMemo = await aMemo(dead, 'Small-lift memo')
    const filingsBefore = await filingsOf([dead, deeper])
    expect(await climb(co)).toEqual(
      expect.arrayContaining([`memo:${rootMemo}`, `memo:${deadMemo}`]),
    )

    const result = await Effect.runPromise(archiveSpaceProgram(me, dead))

    expect(result.spaces).toBe(2)
    const [a, b] = [await spaceRow(dead), await spaceRow(deeper)]
    expect(a.archivedAt).not.toBeNull()
    expect(a.archivedAt?.getTime()).toBe(b.archivedAt?.getTime())
    expect(await filingsOf([dead, deeper])).toEqual(filingsBefore)
    const live = await listed()
    expect(live).toContain(root)
    expect(live).not.toContain(dead)
    expect(live).not.toContain(deeper)
    const parentPage = await Effect.runPromise(getSpaceProgram(root, me))
    expect(parentPage.children.map((c) => c.id)).not.toContain(dead)
    const refs = await climb(co)
    expect(refs).toContain(`memo:${rootMemo}`)
    expect(refs).not.toContain(`memo:${deadMemo}`)
  })

  it('keeps an archived filing on the record, flagged archived', async () => {
    const live = await aSpace('Reusable')
    const dead = await aSpace('Expendable')
    const co = await aCompany('Relativity')
    await file(co, live)
    await file(co, dead)
    await Effect.runPromise(archiveSpaceProgram(me, dead))

    const spaces = await recordSpaces(co)
    expect(spaces.map((s) => [s.id, s.archived])).toEqual(
      expect.arrayContaining([
        [live, false],
        [dead, true],
      ]),
    )
    expect(spaces).toHaveLength(2)
  })

  it('shows the archive on the head with its filings count, and Restore returns only the rows archived with it', async () => {
    const root = await aSpace('Propulsion')
    const mid = await aSpace('Electric', root)
    const earlier = await aSpace('Ion', mid)
    const withIt = await aSpace('Hall', mid)
    const co = await aCompany('Busek')
    await file(co, withIt)
    await file(await aCompany('Phase Four'), mid)

    await Effect.runPromise(archiveSpaceProgram(me, earlier))
    const earlierAt = (await spaceRow(earlier)).archivedAt
    await new Promise((r) => setTimeout(r, 5))
    await Effect.runPromise(archiveSpaceProgram(me, mid))

    const head = await Effect.runPromise(getSpaceProgram(mid, me))
    expect(head.archive).toMatchObject({ spaces: 2, filings: 2 })
    expect(head.archivedUnder).toBeNull()
    const child = await Effect.runPromise(getSpaceProgram(withIt, me))
    expect(child.archivedUnder).toEqual({ id: mid, name: head.name })

    const restored = await Effect.runPromise(restoreSpaceProgram(me, mid))

    expect(restored.spaces).toBe(2)
    expect((await spaceRow(mid)).archivedAt).toBeNull()
    expect((await spaceRow(withIt)).archivedAt).toBeNull()
    expect((await spaceRow(earlier)).archivedAt?.getTime()).toBe(
      earlierAt?.getTime(),
    )
    const live = await listed()
    expect(live).toEqual(expect.arrayContaining([mid, withIt]))
    expect(live).not.toContain(earlier)
    const verbs = await db
      .select({ verb: activity.verb })
      .from(activity)
      .where(eq(activity.subjectEntityId, mid))
    expect(verbs.map((v) => v.verb).sort()).toEqual([
      'space.archived',
      'space.restored',
    ])
  })

  it('refuses a seeded root that still holds unarchived children, and archives it once they are gone', async () => {
    const root = await aSpace('Seeded root')
    const child = await aSpace('Seeded child', root)
    await db
      .update(space)
      .set({ isSeeded: true })
      .where(eq(space.entityId, root))

    const refusal = await failureOf(archiveSpaceProgram(me, root))
    expect(refusal).toBeInstanceOf(SeededRootHasChildren)
    expect(spaceWriteMessage(refusal)).toMatch(/seeded root with 1 live/)
    expect((await spaceRow(root)).archivedAt).toBeNull()

    await Effect.runPromise(archiveSpaceProgram(me, child))
    await Effect.runPromise(archiveSpaceProgram(me, root))
    expect((await spaceRow(root)).archivedAt).not.toBeNull()
  })
})

describe('move', () => {
  it('rewrites every descendant path and the root parent in one statement, leaves filings, writes one event', async () => {
    const launch = await aSpace('Launch')
    const smallLift = await aSpace('Small-lift', launch)
    const deeper = await aSpace('Air-launch', smallLift)
    const reusable = await aSpace('Reusable', launch)
    const co = await aCompany('Astra')
    await file(co, deeper)
    const [before, deepBefore, target] = [
      await spaceRow(smallLift),
      await spaceRow(deeper),
      await spaceRow(reusable),
    ]
    const filingsBefore = await filingsOf([smallLift, deeper])

    const moved = await Effect.runPromise(
      moveSpaceProgram(me, { id: smallLift, parentId: reusable }),
    )

    const to = `${target.path}.${before.slug}`
    expect(moved).toMatchObject({ moved: true, from: before.path, to })
    expect(await spaceRow(smallLift)).toMatchObject({
      path: to,
      parentId: reusable,
    })
    expect(await spaceRow(deeper)).toMatchObject({
      path: `${to}.${deepBefore.slug}`,
      parentId: smallLift,
    })
    expect(await filingsOf([smallLift, deeper])).toEqual(filingsBefore)
    const events = await db
      .select({ verb: activity.verb, meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, smallLift),
          eq(activity.verb, 'space.moved'),
        ),
      )
    expect(events).toEqual([
      { verb: 'space.moved', meta: { from: before.path, to } },
    ])
    const crumb = await Effect.runPromise(getSpaceProgram(deeper, me))
    expect(crumb.ancestors.map((a) => a.id)).toEqual([
      launch,
      reusable,
      smallLift,
    ])
  })

  it('moves to the root', async () => {
    const parent = await aSpace('Energy')
    const child = await aSpace('Fusion', parent)
    const { slug } = await spaceRow(child)
    await Effect.runPromise(moveSpaceProgram(me, { id: child, parentId: null }))
    expect(await spaceRow(child)).toMatchObject({ path: slug, parentId: null })
  })

  it('refuses a move under itself or a descendant, before any write', async () => {
    const root = await aSpace('Defence')
    const child = await aSpace('Drones', root)
    const before = await spaceRow(root)

    for (const target of [root, child]) {
      const refusal = await failureOf(
        moveSpaceProgram(me, { id: root, parentId: target }),
      )
      expect(refusal).toBeInstanceOf(MoveUnderSelf)
    }
    expect(await spaceRow(root)).toEqual(before)
  })

  it('refuses a slug collision under the new parent, and at the root, naming the sibling', async () => {
    const a = await aSpace('Robotics')
    const b = await aSpace('Automation')
    const name = `Grippers ${tag()}`
    const underA = await createSpaceRow(name, a, me)
    const underB = await createSpaceRow(name, b, me)
    const refusal = await failureOf(
      moveSpaceProgram(me, { id: underA, parentId: b }),
    )
    expect(refusal).toBeInstanceOf(SpaceSlugCollision)
    expect(refusal).toMatchObject({ siblingId: underB, siblingName: name })
    expect(spaceWriteMessage(refusal)).toContain(name)

    const rootTwin = await createSpaceRow(name, null, me)
    const atRoot = await failureOf(
      moveSpaceProgram(me, { id: underA, parentId: null }),
    )
    expect(atRoot).toMatchObject({ siblingId: rootTwin })
    expect((await spaceRow(underA)).parentId).toBe(a)
  })

  it('carries sensitivity and the climb with the path, with no second write', async () => {
    const open = await aSpace('Open')
    const secret = await aSpace('Secret')
    const moving = await aSpace('Payloads', open)
    const co = await aCompany('Muon')
    await file(co, moving)
    const secretMemo = await aMemo(secret, 'Secret thesis')
    await Effect.runPromise(setEntitySensitiveProgram(secret, true))
    expect((await Effect.runPromise(sensitivityFor(co))).sensitivity).not.toBe(
      'sensitive',
    )
    expect(await climb(co)).not.toContain(`memo:${secretMemo}`)

    await Effect.runPromise(
      moveSpaceProgram(me, { id: moving, parentId: secret }),
    )

    expect((await Effect.runPromise(sensitivityFor(co))).sensitivity).toBe(
      'sensitive',
    )
    const stamped = await db
      .select({ sensitive: chunk.sensitive })
      .from(chunk)
      .where(eq(chunk.entityId, co))
    expect(stamped.map((c) => c.sensitive)).toEqual([true])
    expect(await climb(co)).toContain(`memo:${secretMemo}`)

    // Out again: the lowering is handed back for the restamp job.
    const out = await Effect.runPromise(
      moveSpaceProgram(me, { id: moving, parentId: open }),
    )
    expect(out.restamp).toContain(co)
    expect((await Effect.runPromise(sensitivityFor(co))).sensitivity).not.toBe(
      'sensitive',
    )
    expect(
      enqueued.filter((e) => e.name === QUEUES.restampSensitivity),
    ).toEqual([])
  })

  it('moves an archived space and keeps it archived', async () => {
    const a = await aSpace('Old')
    const b = await aSpace('New')
    const dead = await aSpace('Gone', a)
    await Effect.runPromise(archiveSpaceProgram(me, dead))
    await Effect.runPromise(moveSpaceProgram(me, { id: dead, parentId: b }))
    expect((await spaceRow(dead)).archivedAt).not.toBeNull()
    expect((await spaceRow(dead)).parentId).toBe(b)
  })
})

describe('the move window', () => {
  it('greys the space and its descendants with the reason and marks the parent "now here"', () => {
    const tree = [
      { id: 'l', name: 'Launch', path: 'launch', depth: 0 },
      { id: 's', name: 'Small-lift', path: 'launch.small', depth: 1 },
      { id: 'a', name: 'Air-launch', path: 'launch.small.air', depth: 2 },
      { id: 'sl', name: 'Smaller', path: 'launch.smaller', depth: 1 },
      { id: 'r', name: 'Reusable', path: 'launch.reusable', depth: 1 },
    ]
    const rows = moveTargets(tree, {
      id: 's',
      path: 'launch.small',
      parentId: 'l',
    })
    expect(rows.map((r) => [r.id, r.refused, r.current])).toEqual([
      [null, null, false],
      ['l', null, true],
      ['s', 'this space', false],
      ['a', 'inside this space', false],
      ['sl', null, false],
      ['r', null, false],
    ])
    expect(rows.at(0)?.name).toBe('Top level')
    // Top-level spaces sit beside it, their children one step in.
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 2, 1, 1])
  })
})
