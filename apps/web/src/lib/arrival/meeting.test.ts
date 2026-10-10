import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, count, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  entityAlias,
  integration,
  interaction,
  interactionEntity,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type {
  MeetingInput,
  MeetingLaneContext,
} from '@spaces/core/writes/interactions/meeting-lane'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { logMeetingProgram } from './meeting'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The calendar's arrival lane against a real database: one event is one
 * `meeting` row keyed by its uid, born once — unless the noise rules refuse
 * it — and then followed in place; attendees become records through the
 * participants module the mailbox uses.
 */

type Meeting = Extract<MeetingInput, { _tag: 'meeting' }>

const anIntegration = async (): Promise<MeetingLaneContext> => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-calendar',
        version: '0.1.0',
        enabled: true,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return { integrationId: row.id, authorId: FIXTURE_ACTOR.id }
}

const aMember = async (email: string) => {
  await db.insert(user).values({
    id: `member-${randomUUID().slice(0, 8)}`,
    name: email,
    email,
    emailVerified: true,
  })
}

const meeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  _tag: 'meeting',
  uid: 'acme-catchup@google.com',
  eventId: 'acme-catchup',
  status: 'scheduled',
  startsAt: new Date('2026-10-12T10:00:00.000Z'),
  endsAt: new Date('2026-10-12T11:00:00.000Z'),
  subject: 'Acme catch-up',
  organizer: 'anish@fund.example',
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  recurringInstanceId: null,
  attendees: [
    { email: 'anish@fund.example', name: null, rsvp: 'accepted', self: true },
    {
      email: 'jane@acme-robotics.example',
      name: 'Jane Founder',
      rsvp: 'accepted',
      self: false,
    },
  ],
  ...overrides,
})

const log = (ctx: MeetingLaneContext, input: MeetingInput) =>
  Effect.runPromise(logMeetingProgram(ctx, input))

const meetings = async () =>
  (
    await db
      .select({ n: count() })
      .from(interaction)
      .where(eq(interaction.kind, 'meeting'))
  ).at(0)?.n ?? 0

const rowOf = async (uid: string) => {
  const row = (
    await db.select().from(interaction).where(eq(interaction.messageId, uid))
  ).at(0)
  if (!row) throw new Error(`no row ${uid}`)
  return row
}

const edgesOf = async (interactionId: string) =>
  (
    await db
      .select({ id: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId))
  )
    .map((r) => r.id)
    .sort()

const holderOf = async (kind: 'email' | 'domain', valueNorm: string) => {
  const row = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.kind, kind), eq(entityAlias.valueNorm, valueNorm)),
      )
  ).at(0)
  if (!row) throw new Error(`nobody holds ${kind} ${valueNorm}`)
  return row.id
}

beforeEach(async () => {
  // Per-test isolation: every test counts the meetings it wrote.
  await truncateAndReseed()
  await aMember('anish@fund.example')
})

describe('the meeting lane', () => {
  it('births an external meeting on its uid, with its attendees as records', async () => {
    const ctx = await anIntegration()
    const out = await log(ctx, meeting())
    expect(out.outcome).toBe('created')
    const row = await rowOf('acme-catchup@google.com')
    expect(row).toMatchObject({
      kind: 'meeting',
      sourceClass: 'integration',
      sourceRef: ctx.integrationId,
      subject: 'Acme catch-up',
      noteId: null,
    })
    expect(row.occurredAt.toISOString()).toBe('2026-10-12T10:00:00.000Z')
    expect(row.meta).toEqual({
      kind: 'meeting',
      ends_at: '2026-10-12T11:00:00.000Z',
      status: 'scheduled',
      conference_url: 'https://meet.google.com/abc-defg-hij',
      organizer: 'anish@fund.example',
      recurring_instance_id: null,
      rsvp: {
        'anish@fund.example': 'accepted',
        'jane@acme-robotics.example': 'accepted',
      },
      calendar_event_id: 'acme-catchup',
    })
    const jane = await holderOf('email', 'jane@acme-robotics.example')
    const acme = await holderOf('domain', 'acme-robotics.example')
    expect(await edgesOf(row.id)).toEqual([acme, jane].sort())
  })

  it('writes nothing for an internal standup, a declined pitch or a cancelled event it never saw', async () => {
    const ctx = await anIntegration()
    await aMember('partner@fund.example')
    const standup = await log(
      ctx,
      meeting({
        uid: 'standup@google.com',
        attendees: [
          {
            email: 'anish@fund.example',
            name: null,
            rsvp: 'accepted',
            self: true,
          },
          {
            email: 'partner@fund.example',
            name: null,
            rsvp: 'accepted',
            self: false,
          },
        ],
      }),
    )
    const declined = await log(
      ctx,
      meeting({
        uid: 'declined@google.com',
        attendees: [
          {
            email: 'anish@fund.example',
            name: null,
            rsvp: 'declined',
            self: true,
          },
          {
            email: 'kim@delta.example',
            name: null,
            rsvp: 'accepted',
            self: false,
          },
        ],
      }),
    )
    const cancelled = await log(
      ctx,
      meeting({ uid: 'gone@google.com', status: 'cancelled' }),
    )
    expect([standup, declined, cancelled]).toEqual([
      { outcome: 'refused', reason: 'no attendee from outside' },
      { outcome: 'refused', reason: 'declined by the calendar owner' },
      { outcome: 'refused', reason: 'cancelled before it was synced' },
    ])
    expect(await meetings()).toBe(0)
  })

  it('follows a changed event in place: time, attendees and RSVPs on the same row', async () => {
    const ctx = await anIntegration()
    const born = await log(ctx, meeting())
    if (born.outcome !== 'created') throw new Error('not born')
    const jane = await holderOf('email', 'jane@acme-robotics.example')

    const moved = await log(
      ctx,
      meeting({
        startsAt: new Date('2026-10-13T15:00:00.000Z'),
        endsAt: new Date('2026-10-13T15:30:00.000Z'),
        attendees: [
          {
            email: 'anish@fund.example',
            name: null,
            rsvp: 'accepted',
            self: true,
          },
          {
            email: 'raj@acme-robotics.example',
            name: 'Raj',
            rsvp: 'tentative',
            self: false,
          },
        ],
      }),
    )
    expect(moved).toEqual({
      outcome: 'updated',
      interactionId: born.interactionId,
    })
    expect(await meetings()).toBe(1)
    const row = await rowOf('acme-catchup@google.com')
    expect(row.occurredAt.toISOString()).toBe('2026-10-13T15:00:00.000Z')
    expect(row.meta).toMatchObject({
      ends_at: '2026-10-13T15:30:00.000Z',
      rsvp: {
        'anish@fund.example': 'accepted',
        'raj@acme-robotics.example': 'tentative',
      },
    })
    const raj = await holderOf('email', 'raj@acme-robotics.example')
    const acme = await holderOf('domain', 'acme-robotics.example')
    // Jane left the invite: her edge goes; the company stays through Raj.
    expect(await edgesOf(row.id)).toEqual([acme, raj].sort())
    expect(await edgesOf(row.id)).not.toContain(jane)
  })

  it('marks a cancelled meeting and never deletes or resurrects it', async () => {
    const ctx = await anIntegration()
    await log(ctx, meeting())
    const cancelled = await log(ctx, meeting({ status: 'cancelled' }))
    expect(cancelled.outcome).toBe('updated')
    const again = await log(ctx, meeting({ status: 'cancelled' }))
    expect(again.outcome).toBe('updated')
    expect(await meetings()).toBe(1)
    expect((await rowOf('acme-catchup@google.com')).meta).toMatchObject({
      status: 'cancelled',
    })
  })

  it('finds a meeting by its event id when the cancellation names nothing else', async () => {
    const ctx = await anIntegration()
    const born = await log(ctx, meeting())
    if (born.outcome !== 'created') throw new Error('not born')
    expect(
      await log(ctx, {
        _tag: 'meeting-cancelled',
        eventId: 'acme-catchup',
        uid: null,
      }),
    ).toEqual({ outcome: 'updated', interactionId: born.interactionId })
    expect((await rowOf('acme-catchup@google.com')).meta).toMatchObject({
      status: 'cancelled',
      ends_at: '2026-10-12T11:00:00.000Z',
    })
    expect(
      await log(ctx, {
        _tag: 'meeting-cancelled',
        eventId: 'never',
        uid: null,
      }),
    ).toEqual({ outcome: 'refused', reason: 'no meeting holds this event' })
    expect(await meetings()).toBe(1)
  })

  it('is one row when two calendars hold the same event — the second write conflicts', async () => {
    const anish = await anIntegration()
    const partner = await anIntegration()
    const [a, b] = await Promise.all([
      log(anish, meeting()),
      log(partner, meeting({ eventId: 'partner-copy' })),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['created', 'updated'])
    expect(await meetings()).toBe(1)
    const row = await rowOf('acme-catchup@google.com')
    expect(a).toMatchObject({ interactionId: row.id })
    expect(b).toMatchObject({ interactionId: row.id })
  })
})
