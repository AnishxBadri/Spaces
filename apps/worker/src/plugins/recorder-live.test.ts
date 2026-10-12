import { Effect, Layer } from 'effect'
import { count, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  document,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { Content } from '@spaces/sdk'
import type { InteractionClaim, MeetingClaim } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { meetingLaneLive } from './meetings'
import { NoEmailLane } from '@spaces/core/writes/interactions/email-lane'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The demo, against the real arrival lane: a calendar meeting synced through
 * `Content.logMeeting`, then a recorder's payload naming its iCalUID through
 * `Content.logInteraction`. The payload lands on the meeting's row and its
 * attendees resolve to the same people; one naming nothing becomes a call;
 * a replay of either doubles nothing.
 */

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const bound = async (capabilityId: string) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId,
        version: '0.1.0',
        enabled: true,
        createdBy: FIXTURE_ACTOR.id,
      })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row
}

const content = <TValue>(
  row: { id: string; capabilityId: string },
  use: (port: Content['Service']) => Effect.Effect<TValue, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Content)
    }).pipe(
      Effect.provide(
        ContentLive(row).pipe(
          Layer.provide(
            Layer.mergeAll(noEnqueue, meetingLaneLive, NoEmailLane),
          ),
        ),
      ),
    ),
  )

const UID = 'ohmium-intro-7f3a@google.com'
const START = '2026-10-08T10:00:00.000Z'

const synced: MeetingClaim = {
  _tag: 'meeting',
  uid: UID,
  eventId: 'gcal-ohmium-intro',
  status: 'scheduled',
  startsAt: START,
  endsAt: '2026-10-08T10:30:00.000Z',
  subject: 'Ohmium intro',
  organizer: 'priya@ohmium-live.example',
  attendees: [
    {
      email: 'priya@ohmium-live.example',
      name: 'Priya Rao',
      rsvp: 'accepted',
    },
    { email: 'dev@ohmium-live.example', name: 'Dev Shah', rsvp: 'tentative' },
  ],
}

const recorded = (
  providerEventId: string,
  icalUid: string | null,
): InteractionClaim => ({
  _tag: 'interaction',
  kind: 'call',
  occurredAt: '2026-10-08T10:02:00.000Z',
  subject: 'Ohmium intro',
  participants: [
    { email: 'Priya@Ohmium-Live.example', name: 'Priya Rao' },
    { email: 'dev@ohmium-live.example', name: 'Dev Shah' },
  ],
  recorder: {
    providerEventId,
    ...(icalUid === null ? {} : { icalUid }),
    durationSeconds: 1740,
    raw: { id: providerEventId, transcript: 'Priya: hello…' },
    artifacts: [
      {
        role: 'recording_link',
        url: `https://fathom.video/calls/${providerEventId}`,
      },
    ],
  },
})

const rows = async () =>
  (await db.select({ n: count() }).from(interaction)).at(0)?.n ?? 0

const edgesOf = async (interactionId: string) =>
  (
    await db
      .select({ id: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId))
  )
    .map((r) => r.id)
    .sort()

describe('a recorder payload through the arrival lane', () => {
  it('lands on the synced meeting, a call when nothing matches, and replays double nothing', async () => {
    const calendar = await bound('google-calendar')
    const recorder = await bound('fathom')

    const meeting = await content(calendar, (port) => port.logMeeting(synced))
    if (meeting.outcome === 'refused') throw new Error(meeting.reason)
    const people = await edgesOf(meeting.interactionId)
    expect(people.length).toBeGreaterThan(0)
    const before = await rows()

    const onMeeting = await content(recorder, (port) =>
      port.logInteraction(recorded('fathom-live-1', UID)),
    )
    expect(onMeeting.interactionId).toBe(meeting.interactionId)
    expect(await rows()).toBe(before)
    // The attendees' names resolved to the same people.
    expect(await edgesOf(meeting.interactionId)).toEqual(people)
    const artifacts = await db
      .select({
        role: interactionDocument.role,
        blobSha: document.blobSha,
        externalUrl: document.externalUrl,
      })
      .from(interactionDocument)
      .innerJoin(
        document,
        eq(document.entityId, interactionDocument.documentId),
      )
      .where(eq(interactionDocument.interactionId, meeting.interactionId))
    expect(artifacts).toEqual([
      {
        role: 'recording_link',
        blobSha: null,
        externalUrl: 'https://fathom.video/calls/fathom-live-1',
      },
    ])

    const asCall = await content(recorder, (port) =>
      port.logInteraction(recorded('fathom-live-2', null)),
    )
    // No key, but every participant is on the meeting inside the window:
    // the fallback attaches it. A stranger's call is a call.
    expect(asCall.interactionId).toBe(meeting.interactionId)
    const stranger = await content(recorder, (port) =>
      port.logInteraction({
        ...recorded('fathom-live-3', null),
        participants: [{ email: 'stranger@elsewhere-live.example' }],
      }),
    )
    expect(stranger.interactionId).not.toBe(meeting.interactionId)
    const call = (
      await db
        .select({ kind: interaction.kind, messageId: interaction.messageId })
        .from(interaction)
        .where(eq(interaction.id, stranger.interactionId))
    ).at(0)
    expect(call).toEqual({ kind: 'call', messageId: 'fathom-live-3' })
    expect(await rows()).toBe(before + 1)

    // Replay all three: nothing doubles.
    await content(recorder, (port) =>
      port.logInteraction(recorded('fathom-live-1', UID)),
    )
    await content(recorder, (port) =>
      port.logInteraction(recorded('fathom-live-2', null)),
    )
    await content(recorder, (port) =>
      port.logInteraction({
        ...recorded('fathom-live-3', null),
        participants: [{ email: 'stranger@elsewhere-live.example' }],
      }),
    )
    expect(await rows()).toBe(before + 1)
    const recordings = await db
      .select({ n: count() })
      .from(interactionDocument)
      .where(eq(interactionDocument.role, 'recording_link'))
    expect(recordings.at(0)?.n).toBe(3)
  })
})
