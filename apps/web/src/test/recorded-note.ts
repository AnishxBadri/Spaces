import { randomUUID } from 'node:crypto'
import { Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  interaction,
  interactionNote,
} from '@spaces/db/schema'
import { Content } from '@spaces/sdk'
import type { RecordedNote } from '@spaces/sdk'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { NoEmailLane } from '@spaces/core/writes/interactions/email-lane'
import { MeetingLane } from '@spaces/core/writes/interactions/meeting-lane'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { FIXTURE_ACTOR } from '../../vitest.seed'

/**
 * A Granola note delivered through `Content.logRecordedNote`, for the read
 * paths' tests: a calendar meeting with Maya of Flent, the member's key
 * connection with both opt-ins on, and a participants lane that resolves
 * Maya and her company by address.
 */

export const GRANOLA_URL = 'https://notes.granola.ai/d/not_flent'

/** Every job the port sent. */
export const sentJobs: Array<{ queue: string; data: unknown }> = []

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data) =>
      Effect.sync(() => {
        sentJobs.push({ queue, data })
        return null
      }),
  }),
)

/** Maya as a person, and Flent by her domain. */
const LaneTest = Layer.succeed(
  MeetingLane,
  MeetingLane.of({
    log: () => Effect.die('no meetings here'),
    participants: (_ctx, people) =>
      Effect.promise(async () => {
        const ids: Array<string> = []
        for (const p of people) {
          if (p.email.endsWith('@fund.example')) continue
          ids.push(
            (
              await resolveEntity({
                kind: 'person',
                ...(p.name === null ? {} : { name: p.name }),
                keys: { email: p.email },
                source: { class: 'manual' },
              })
            ).entityId,
          )
          ids.push(
            (
              await resolveEntity({
                kind: 'company',
                keys: { domain: p.email.split('@')[1] ?? '' },
                source: { class: 'manual' },
              })
            ).entityId,
          )
        }
        return ids
      }),
  }),
)

/** One case's founder call: its own company domain and calendar event. */
export const callTag = () => randomUUID().slice(0, 8)

const domainOf = (tag: string) => `flent-${tag}.example`
const mayaOf = (tag: string) => `maya@${domainOf(tag)}`

/** Flent, by its domain: the company the meeting's records resolve to. */
export const flent = async (tag: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name: 'Flent',
      keys: { domain: domainOf(tag) },
      source: { class: 'manual' },
    })
  ).entityId

/** Granola installed, and the fixture member's key with these opt-ins. */
export async function granola(choices: {
  typed_notes: boolean
  transcript: boolean
}) {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'granola',
        version: '0.1.0',
        enabled: true,
        manifest: { name: 'Granola' },
      })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no integration')
  const conn = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'granola',
        product: 'notes',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { type: 'api_key', key: 'grn_test' },
          { userId: FIXTURE_ACTOR.id, provider: 'granola' },
        ),
        settings: { folder_ids: ['fld_deals'], ...choices },
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!conn) throw new Error('no connection')
  return { ...row, connectionId: conn.id }
}

/** Yesterday's founder call with Maya, as the calendar synced it. */
export async function founderCall(tag: string, start: Date) {
  const cal = (
    await db
      .insert(integration)
      .values({ capabilityId: 'google-calendar', version: '0.1.0' })
      .returning({ id: integration.id })
  ).at(0)
  if (!cal) throw new Error('no calendar')
  const written = await db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId: cal.id,
      kind: 'meeting',
      messageId: `flent-${randomUUID()}@google.com`,
      threadId: null,
      subject: 'Flent — founder call',
      occurredAt: start,
      meta: {
        kind: 'meeting',
        ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status: 'scheduled',
        conference_url: null,
        organizer: 'anish@fund.example',
        recurring_instance_id: null,
        rsvp: { [mayaOf(tag)]: 'accepted' },
        calendar_event_id: `gcal-${tag}`,
      },
      body: null,
      edges: [],
    }),
  )
  if (written.kind !== 'written') throw new Error('meeting not written')
  return written.interactionId
}

/** The note as Granola sends it. */
export const granolaNote = (
  tag: string,
  start: Date,
  extra: Partial<RecordedNote> = {},
): RecordedNote => ({
  _tag: 'recorded-note',
  providerNoteId: 'not_flent',
  title: 'Flent — founder call',
  startedAt: start.toISOString(),
  calendarEventId: `gcal-${tag}`,
  attendees: [
    { email: 'anish@fund.example' },
    { email: mayaOf(tag), name: 'Maya Rao' },
  ],
  summary:
    '## Flent\n- Raising a seed\n\n### Action items\n- Send the data room',
  webUrl: GRANOLA_URL,
  raw: { id: 'not_flent' },
  ...extra,
})

/** One delivery through the port; fails the test on a refusal. */
export async function deliver(
  row: { id: string; capabilityId: string; connectionId: string },
  claim: RecordedNote,
) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Content).logRecordedNote(claim)
    }).pipe(
      Effect.provide(
        ContentLive(row).pipe(
          Layer.provide(Layer.mergeAll(EnqueueTest, LaneTest, NoEmailLane)),
        ),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

/** What the meeting carries: its write-up and its notes by role. */
export async function carried(interactionId: string) {
  const row = (
    await db
      .select({ noteId: interaction.noteId })
      .from(interaction)
      .where(eq(interaction.id, interactionId))
  ).at(0)
  const typed = (
    await db
      .select({ id: interactionNote.noteId })
      .from(interactionNote)
      .where(
        and(
          eq(interactionNote.interactionId, interactionId),
          eq(interactionNote.role, 'typed_notes'),
        ),
      )
  ).at(0)
  return { writeUp: row?.noteId ?? null, typed: typed?.id ?? null }
}
