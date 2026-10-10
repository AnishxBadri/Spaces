import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  integration,
  interaction,
  interactionStat,
  mergeEvent,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { mergeEntities } from '../entities/merge'
import { resolveEntity } from '../entities/resolve'
import {
  recomputeInteractionStats,
  rollElapsedInteractionStatsProgram,
} from './stats'
import { updateInteraction, writeIntegrationInteraction } from './write'

/**
 * `interaction_stat` through the writer: every path rebuilds the rows in the
 * writer's transaction, a cancelled meeting leaves `next`, and a merge
 * recomputes the winner from both histories, as the snapshot records.
 */

const DAY = 86_400_000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY)

const anIntegration = async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'calendar', version: '1.0.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

const aPerson = async (name: string) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'person', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no person')
  return row.id
}

const meetingMeta = (status: MeetingMeta['status']): MeetingMeta => ({
  kind: 'meeting',
  ends_at: daysFromNow(30).toISOString(),
  status,
  conference_url: null,
  organizer: null,
  recurring_instance_id: null,
  rsvp: {},
})

const write = (
  integrationId: string,
  kind: 'email' | 'meeting' | 'call',
  occurredAt: Date,
  edges: Array<string>,
  meta?: MeetingMeta,
) =>
  db.transaction(async (tx) => {
    const out = await writeIntegrationInteraction(tx, {
      integrationId,
      kind,
      messageId: null,
      threadId: null,
      subject: `${kind} ${occurredAt.toISOString()}`,
      occurredAt,
      body: null,
      edges,
      ...(meta === undefined ? {} : { meta }),
    })
    if (out.kind !== 'written') throw new Error('expected a written row')
    return out.interactionId
  })

const statsOf = async (entityId: string) => {
  const rows = await db
    .select()
    .from(interactionStat)
    .where(eq(interactionStat.entityId, entityId))
  return new Map(rows.map((r) => [r.kind, r]))
}

describe('interaction_stat', () => {
  it('the writer keeps first, last and next per kind and for any', async () => {
    const integrationId = await anIntegration()
    const ada = await aPerson(`Ada ${randomUUID().slice(0, 6)}`)

    const oldEmail = await write(integrationId, 'email', daysFromNow(-20), [
      ada,
    ])
    const call = await write(integrationId, 'call', daysFromNow(-3), [ada])
    const newEmail = await write(integrationId, 'email', daysFromNow(-5), [ada])
    const later = await write(integrationId, 'meeting', daysFromNow(9), [ada])
    const soon = await write(integrationId, 'meeting', daysFromNow(2), [ada])

    const stats = await statsOf(ada)
    expect([...stats.keys()].sort()).toEqual([
      'any',
      'call',
      'email',
      'meeting',
    ])
    const any = stats.get('any')
    expect(any?.firstId).toBe(oldEmail)
    expect(any?.lastId).toBe(call)
    expect(any?.nextId).toBe(soon)
    const email = stats.get('email')
    expect(email?.firstId).toBe(oldEmail)
    expect(email?.lastId).toBe(newEmail)
    expect(email?.nextId).toBeNull()
    // Only future meetings so far: no first or last, a next.
    const meeting = stats.get('meeting')
    expect(meeting?.lastId).toBeNull()
    expect(meeting?.nextId).toBe(soon)
    expect(later).not.toBe(soon)
  })

  it('a rolled-back interaction leaves the stats as they were', async () => {
    const integrationId = await anIntegration()
    const bo = await aPerson(`Bo ${randomUUID().slice(0, 6)}`)
    const kept = await write(integrationId, 'call', daysFromNow(-10), [bo])
    const before = await statsOf(bo)

    await expect(
      db.transaction(async (tx) => {
        await writeIntegrationInteraction(tx, {
          integrationId,
          kind: 'email',
          messageId: null,
          threadId: null,
          subject: 'never lands',
          occurredAt: daysFromNow(-1),
          body: null,
          edges: [bo],
        })
        // The stats moved inside the transaction…
        const inside = await tx
          .select({ lastAt: interactionStat.lastAt })
          .from(interactionStat)
          .where(
            and(
              eq(interactionStat.entityId, bo),
              eq(interactionStat.kind, 'any'),
            ),
          )
        expect(inside.at(0)?.lastAt?.getTime()).toBeGreaterThan(
          daysFromNow(-2).getTime(),
        )
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')

    // …and not outside it.
    const after = await statsOf(bo)
    expect(after).toEqual(before)
    expect(after.get('any')?.lastId).toBe(kept)
    expect(after.has('email')).toBe(false)
  })

  it('a cancelled meeting leaves next; the next uncancelled one takes its place', async () => {
    const integrationId = await anIntegration()
    const cy = await aPerson(`Cy ${randomUUID().slice(0, 6)}`)
    const first = await write(
      integrationId,
      'meeting',
      daysFromNow(1),
      [cy],
      meetingMeta('scheduled'),
    )
    const second = await write(
      integrationId,
      'meeting',
      daysFromNow(4),
      [cy],
      meetingMeta('scheduled'),
    )
    expect((await statsOf(cy)).get('any')?.nextId).toBe(first)

    await db.transaction((tx) =>
      updateInteraction(tx, first, { meta: meetingMeta('cancelled') }),
    )
    const stats = await statsOf(cy)
    expect(stats.get('any')?.nextId).toBe(second)
    expect(stats.get('meeting')?.nextId).toBe(second)

    // Cancelling the last one too leaves nothing to keep: the rows go.
    await db.transaction((tx) =>
      updateInteraction(tx, second, { meta: meetingMeta('cancelled') }),
    )
    expect((await statsOf(cy)).size).toBe(0)

    // A meeting moved into the past is last contact, not next.
    await db.transaction((tx) =>
      updateInteraction(tx, second, {
        meta: meetingMeta('scheduled'),
        occurredAt: daysFromNow(-1),
      }),
    )
    const moved = (await statsOf(cy)).get('any')
    expect(moved?.lastId).toBe(second)
    expect(moved?.nextId).toBeNull()
  })

  it('the roll turns a started next meeting into last', async () => {
    const integrationId = await anIntegration()
    const di = await aPerson(`Di ${randomUUID().slice(0, 6)}`)
    const meeting = await write(integrationId, 'meeting', daysFromNow(1), [di])
    // The clock moves: the meeting starts. Nothing wrote to say so.
    await db
      .update(interaction)
      .set({ occurredAt: daysFromNow(-1) })
      .where(eq(interaction.id, meeting))
    await db
      .update(interactionStat)
      .set({ nextAt: daysFromNow(-1) })
      .where(eq(interactionStat.entityId, di))

    const { rolled } = await Effect.runPromise(
      rollElapsedInteractionStatsProgram(),
    )
    expect(rolled).toBeGreaterThanOrEqual(1)
    const any = (await statsOf(di)).get('any')
    expect(any?.lastId).toBe(meeting)
    expect(any?.nextId).toBeNull()
  })

  it('a merge recomputes the winner from both histories, through the snapshot', async () => {
    const integrationId = await anIntegration()
    const tag = randomUUID().slice(0, 8)
    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('no fixture user')
    const winner = await resolveEntity({
      kind: 'company',
      name: `StatCo ${tag}`,
      keys: { domain: `statco-${tag}.com` },
      source: { class: 'manual' },
    })
    const loser = await resolveEntity({
      kind: 'company',
      name: `StatCo ${tag} Ltd`,
      keys: { domain: `statco-${tag}.in` },
      source: { class: 'manual' },
    })
    const winnerOld = await write(integrationId, 'email', daysFromNow(-30), [
      winner.entityId,
    ])
    const loserNew = await write(integrationId, 'call', daysFromNow(-2), [
      loser.entityId,
    ])
    const loserNext = await write(integrationId, 'meeting', daysFromNow(6), [
      loser.entityId,
    ])

    const { mergeEventId } = await mergeEntities({
      winnerId: winner.entityId,
      loserId: loser.entityId,
      mergedBy: actor.id,
    })

    const won = await statsOf(winner.entityId)
    expect(won.get('any')?.firstId).toBe(winnerOld)
    expect(won.get('any')?.lastId).toBe(loserNew)
    expect(won.get('any')?.nextId).toBe(loserNext)
    expect(won.get('email')?.lastId).toBe(winnerOld)
    expect(won.get('call')?.lastId).toBe(loserNew)
    expect((await statsOf(loser.entityId)).size).toBe(0)

    const event = (
      await db
        .select({ snapshot: mergeEvent.snapshot })
        .from(mergeEvent)
        .where(eq(mergeEvent.id, mergeEventId))
    ).at(0)
    const entries = (event?.snapshot ?? []).filter(
      (e) => e.table === 'interaction_stat',
    )
    // The loser's rows dropped, each kept whole.
    const dropped = entries.filter((e) => e.action === 'dropped')
    expect(dropped.map((e) => e.pk.kind).sort()).toEqual([
      'any',
      'call',
      'meeting',
    ])
    for (const e of dropped) expect(e.pk.entityId).toBe(loser.entityId)
    const droppedAny = dropped.find((e) => e.pk.kind === 'any')
    expect(droppedAny?.old.lastId).toBe(loserNew)
    // The winner's rows recomputed, each with what it held before.
    const recomputed = entries.filter((e) => e.action === 'recomputed')
    expect(recomputed.map((e) => e.pk.kind).sort()).toEqual([
      'any',
      'call',
      'email',
      'meeting',
    ])
    const anyBefore = recomputed.find((e) => e.pk.kind === 'any')
    expect(anyBefore?.old.lastId).toBe(winnerOld)
    expect(recomputed.find((e) => e.pk.kind === 'call')?.old).toEqual({})
  })

  it('recomputing an entity with no interactions is a no-op', async () => {
    const lone = await aPerson(`Lone ${randomUUID().slice(0, 6)}`)
    await db.transaction((tx) => recomputeInteractionStats(tx, [lone]))
    const n = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from interaction_stat where entity_id = ${lone}`,
    )
    expect(n.rows.at(0)?.n).toBe(0)
  })
})
