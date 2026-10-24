import { count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  document,
  entity,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  link,
  note,
} from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { resolveEntity } from '../entities/resolve'
import { insertReceipt } from '../ports/receipts'
import {
  ArtifactNotOwned,
  MATCH_WINDOW_MS,
  writeIntegrationInteraction,
  writeRecordedInteraction,
} from './write'
import type { RecordedInteraction } from './write'

/**
 * A recorder's payload through the one writer: it attaches to the
 * calendar meeting a key names — or the one inside the window whose
 * attendees include every payload email — and births a `call` only when
 * nothing matches. One meeting, one row.
 */

const START = new Date('2026-10-08T10:00:00.000Z')
const MINUTE = 60_000

const boundRow = async (capabilityId: string) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row
}

const person = async (name: string, email: string) =>
  (
    await resolveEntity({
      kind: 'person',
      name,
      keys: { email },
      source: { class: 'manual' },
    })
  ).entityId

const meetingMeta = (
  rsvp: MeetingMeta['rsvp'],
  status: MeetingMeta['status'] = 'scheduled',
): MeetingMeta => ({
  kind: 'meeting',
  ends_at: new Date(START.getTime() + 30 * MINUTE).toISOString(),
  status,
  conference_url: null,
  organizer: 'anish@fund.example',
  recurring_instance_id: null,
  rsvp,
  calendar_event_id: 'gcal-evt-1',
})

/** A synced meeting, as the calendar lane writes one. */
const syncedMeeting = async (
  calendarId: string,
  uid: string,
  edges: Array<string>,
  rsvp: MeetingMeta['rsvp'],
  at: Date = START,
  status: MeetingMeta['status'] = 'scheduled',
) => {
  const written = await db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId: calendarId,
      kind: 'meeting',
      messageId: uid,
      threadId: null,
      subject: 'Ohmium follow-up',
      occurredAt: at,
      meta: { ...meetingMeta(rsvp, status), calendar_event_id: `evt-${uid}` },
      body: null,
      edges,
    }),
  )
  if (written.kind !== 'written') throw new Error('meeting not written')
  return written.interactionId
}

const payload = async (
  recorderId: string,
  fields: Partial<RecordedInteraction> & { providerEventId: string },
): Promise<RecordedInteraction> => ({
  integrationId: recorderId,
  icalUid: null,
  calendarEventId: null,
  occurredAt: START,
  subject: 'Ohmium follow-up',
  durationSeconds: 1800,
  emails: [],
  receiptId: await insertReceipt(
    { id: recorderId, capabilityId: 'fathom' },
    { entityId: null, raw: { id: fields.providerEventId }, creditsUsed: null },
  ),
  edges: [],
  artifacts: [],
  ...fields,
})

const record = (r: RecordedInteraction) =>
  db.transaction((tx) => writeRecordedInteraction(tx, r))

const interactions = async () =>
  (await db.select({ n: count() }).from(interaction)).at(0)?.n ?? 0

const edgesOf = async (interactionId: string) =>
  (
    await db
      .select({ entityId: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId))
  )
    .map((e) => e.entityId)
    .sort()

describe('a recorder payload naming a synced meeting', () => {
  it('attaches participants and artifacts to the meeting its iCalUID keys; no row is born', async () => {
    const calendar = await boundRow('google-calendar')
    const recorder = await boundRow('fathom')
    const priya = await person('Priya', 'priya@ohmium-rec.example')
    const dev = await person('Dev', 'dev@ohmium-rec.example')
    const meetingId = await syncedMeeting(
      calendar.id,
      'uid-ohmium@google.com',
      [priya],
      { 'priya@ohmium-rec.example': 'accepted' },
    )
    // The transcript was filed by the recorder through Content.fileDocument.
    const transcript = (
      await db
        .insert(entity)
        .values({
          kind: 'document',
          canonicalName: 'Transcript',
          sourceClass: 'integration',
          sourceRef: recorder.id,
        })
        .returning({ id: entity.id })
    ).at(0)
    if (!transcript) throw new Error('no transcript')
    await db.insert(document).values({
      entityId: transcript.id,
      filename: 'transcript.txt',
      kind: 'other',
      sourceClass: 'integration',
      sourceRef: recorder.id,
    })
    const before = await interactions()

    const out = await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-1',
        icalUid: 'uid-ohmium@google.com',
        edges: [priya, dev],
        artifacts: [
          { role: 'transcript', documentId: transcript.id },
          {
            role: 'recording_link',
            url: 'https://fathom.video/calls/1',
            title: 'Recording',
          },
        ],
      }),
    )

    expect(out.outcome).toBe('attached')
    expect(out.interactionId).toBe(meetingId)
    expect(await interactions()).toBe(before)
    expect(await edgesOf(meetingId)).toEqual([priya, dev].sort())
    // Only the new participant is a new `interaction.logged`.
    expect(out.events.map((e) => [e.name, e.entityId])).toEqual([
      ['interaction.logged', dev],
    ])

    const artifacts = await db
      .select({
        role: interactionDocument.role,
        blobSha: document.blobSha,
        externalUrl: document.externalUrl,
        status: document.extractionStatus,
        sourceRef: document.sourceRef,
        documentId: document.entityId,
      })
      .from(interactionDocument)
      .innerJoin(
        document,
        eq(document.entityId, interactionDocument.documentId),
      )
      .where(eq(interactionDocument.interactionId, meetingId))
    const recording = artifacts.find((a) => a.role === 'recording_link')
    expect(recording).toMatchObject({
      blobSha: null,
      externalUrl: 'https://fathom.video/calls/1',
      status: 'unsupported',
      sourceRef: recorder.id,
    })
    expect(artifacts.find((a) => a.role === 'transcript')?.documentId).toBe(
      transcript.id,
    )
    // Filed on the participants' records, so their Files tab lists it.
    const filed = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(eq(link.fromEntityId, recording?.documentId ?? ''))
    expect(filed.map((f) => f.to).sort()).toEqual([priya, dev].sort())

    const meta = (
      await db
        .select({ meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.id, meetingId))
    ).at(0)?.meta
    expect(meta).toMatchObject({
      kind: 'meeting',
      calendar_event_id: 'evt-uid-ohmium@google.com',
      recorder_events: [{ provider_event_id: 'fathom-1' }],
    })
  })

  it('a replay attaches nothing twice', async () => {
    const calendar = await boundRow('google-calendar')
    const recorder = await boundRow('fathom')
    const priya = await person('Priya', 'priya@replay-rec.example')
    const meetingId = await syncedMeeting(calendar.id, 'uid-replay', [priya], {
      'priya@replay-rec.example': 'accepted',
    })
    const fields = {
      providerEventId: 'fathom-replay',
      icalUid: 'uid-replay',
      edges: [priya],
      artifacts: [
        {
          role: 'recording_link' as const,
          url: 'https://fathom.video/calls/replay',
          title: 'Recording',
        },
      ],
    }
    const first = await record(await payload(recorder.id, fields))
    const second = await record(await payload(recorder.id, fields))
    expect(second).toEqual({
      outcome: 'duplicate',
      interactionId: first.interactionId,
      events: [],
    })
    const joined = await db
      .select({ documentId: interactionDocument.documentId })
      .from(interactionDocument)
      .where(eq(interactionDocument.interactionId, meetingId))
    expect(joined).toHaveLength(1)
  })

  it('one instance of a series matches by its iCalUID inside the window', async () => {
    const calendar = await boundRow('google-calendar')
    const recorder = await boundRow('fathom')
    const priya = await person('Priya', 'priya@series-rec.example')
    const lastWeek = new Date(START.getTime() - 7 * 24 * 60 * MINUTE)
    await syncedMeeting(
      calendar.id,
      `uid-weekly#${lastWeek.toISOString()}`,
      [priya],
      { 'priya@series-rec.example': 'accepted' },
      lastWeek,
    )
    const thisWeek = await syncedMeeting(
      calendar.id,
      `uid-weekly#${START.toISOString()}`,
      [priya],
      { 'priya@series-rec.example': 'accepted' },
    )
    const out = await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-weekly',
        icalUid: 'uid-weekly',
        occurredAt: new Date(START.getTime() + 2 * MINUTE),
      }),
    )
    expect(out).toMatchObject({ outcome: 'attached', interactionId: thisWeek })
  })
})

describe('a recorder payload naming nothing', () => {
  it('births one call keyed by the provider event id; delivered twice it is still one', async () => {
    const recorder = await boundRow('fathom')
    const dev = await person('Dev', 'dev@call-rec.example')
    const before = await interactions()
    const fields = {
      providerEventId: 'fathom-call-1',
      icalUid: 'uid-nobody-synced',
      emails: ['dev@call-rec.example'],
      edges: [dev],
    }
    const first = await record(await payload(recorder.id, fields))
    const second = await record(await payload(recorder.id, fields))

    expect(first.outcome).toBe('born')
    expect(second).toMatchObject({
      outcome: 'duplicate',
      interactionId: first.interactionId,
    })
    expect(await interactions()).toBe(before + 1)
    const row = (
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, first.interactionId))
    ).at(0)
    expect(row).toMatchObject({
      kind: 'call',
      messageId: 'fathom-call-1',
      sourceRef: recorder.id,
      noteId: null,
      meta: {
        kind: 'call',
        provider_event_id: 'fathom-call-1',
        duration_seconds: 1800,
      },
    })
    expect(first.events.map((e) => e.entityId)).toEqual([dev])
  })

  it('writes no note for the payload', async () => {
    const recorder = await boundRow('fathom')
    const dev = await person('Dev', 'dev@nonote-rec.example')
    const notes = async () =>
      (await db.select({ n: count() }).from(note)).at(0)?.n ?? 0
    const before = await notes()
    await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-nonote',
        edges: [dev],
      }),
    )
    expect(await notes()).toBe(before)
  })

  it('refuses a transcript another integration filed, and writes nothing', async () => {
    const recorder = await boundRow('fathom')
    const other = await boundRow('tldv')
    const dev = await person('Dev', 'dev@notowned-rec.example')
    const doc = (
      await db
        .insert(entity)
        .values({
          kind: 'document',
          canonicalName: 'Theirs',
          sourceClass: 'integration',
          sourceRef: other.id,
        })
        .returning({ id: entity.id })
    ).at(0)
    if (!doc) throw new Error('no document')
    await db.insert(document).values({
      entityId: doc.id,
      filename: 'theirs.txt',
      kind: 'other',
      sourceClass: 'integration',
      sourceRef: other.id,
    })
    const before = await interactions()
    await expect(
      record(
        await payload(recorder.id, {
          providerEventId: 'fathom-notowned',
          edges: [dev],
          artifacts: [{ role: 'transcript', documentId: doc.id }],
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactNotOwned)
    expect(await interactions()).toBe(before)
  })
})

describe('the time-and-participants fallback', () => {
  const setUp = async (tag: string) => {
    const calendar = await boundRow('google-calendar')
    const recorder = await boundRow('fathom')
    const priya = await person('Priya', `priya@${tag}.example`)
    const meetingId = await syncedMeeting(calendar.id, `uid-${tag}`, [priya], {
      [`priya@${tag}.example`]: 'accepted',
      [`dev@${tag}.example`]: 'tentative',
    })
    return { recorder, priya, meetingId }
  }

  it('matches inside 30 minutes with every payload email on the meeting', async () => {
    const { recorder, meetingId } = await setUp('fallback-in')
    const out = await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-fallback-in',
        occurredAt: new Date(START.getTime() + MATCH_WINDOW_MS),
        emails: [
          'priya@fallback-in.example',
          'dev@fallback-in.example',
          'anish@fund.example',
        ],
      }),
    )
    expect(out).toMatchObject({ outcome: 'attached', interactionId: meetingId })
  })

  it('refuses when one payload email is not on the meeting', async () => {
    const { recorder, meetingId } = await setUp('fallback-missing')
    const out = await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-fallback-missing',
        occurredAt: new Date(START.getTime() + 5 * MINUTE),
        emails: [
          'priya@fallback-missing.example',
          'stranger@elsewhere.example',
        ],
      }),
    )
    expect(out.outcome).toBe('born')
    expect(out.interactionId).not.toBe(meetingId)
  })

  it('refuses outside 30 minutes', async () => {
    const { recorder, meetingId } = await setUp('fallback-late')
    const out = await record(
      await payload(recorder.id, {
        providerEventId: 'fathom-fallback-late',
        occurredAt: new Date(START.getTime() + MATCH_WINDOW_MS + MINUTE),
        emails: ['priya@fallback-late.example'],
      }),
    )
    expect(out.outcome).toBe('born')
    expect(out.interactionId).not.toBe(meetingId)
  })
})
