import { Effect, Schema } from 'effect'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  interaction,
  meetingRemoval,
} from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import {
  updateInteraction,
  writeIntegrationInteraction,
} from '@spaces/core/writes/interactions/write'
import { dispatchDomainEvent } from '@spaces/core/writes/events/dispatch'
import type {
  MeetingInput,
  MeetingLaneContext,
  ParticipantInput,
} from '@spaces/core/writes/interactions/meeting-lane'
import type { DomainEvent, MeetingResult } from '@spaces/sdk'
import { webEnqueue } from '#/lib/enqueue-live'
import { PRODUCTS } from '#/lib/connections/products'
import { seriesUidOf } from '#/lib/meetings/removal'
import type { Address } from './forwarded'
import { matchParticipants } from './file'
import { meetingRefusal } from './noise'
import type { MailExclude } from './noise'
import { syncedMailSettingsOf } from './synced-settings'
import {
  participantDecisionsProgram,
  resolveParticipantsProgram,
} from './participant-records'
import type { ParticipantAddresses } from './participant-records'

/**
 * The calendar's arrival lane: one event → one `meeting` interaction, keyed
 * by its `uid` in `message_id`, born once and then followed. What
 * `Content.logMeeting` runs, through the `MeetingLane` service.
 *
 * - **One policy.** The organizer and the attendees are addresses, judged by
 *   `decideParticipants` and resolved by the same program the mailbox uses;
 *   the refusals are `meetingRefusal`, beside the mail ones.
 * - **Refusals gate a birth only.** A meeting already held follows its event
 *   whatever it became — moved, cancelled, declined — and is never deleted
 *   by a sync. A meeting a member removed from Spaces, or its whole series,
 *   is never born again (`meeting_removal`).
 * - **One row across calendars.** Two syncs racing on one event both try the
 *   insert; `interaction_message_id_unique` keeps one and the loser follows it.
 * - **Edges follow the attendees.** Each sync edges what the current list
 *   resolves to and drops what only a departed attendee matched; deals and
 *   pins are never touched.
 * - **Each new participant is an `interaction.logged`**, dispatched once the
 *   write commits: the meeting auto-enrich scope's trigger.
 */

export class MeetingWriteFailed extends Schema.TaggedError<MeetingWriteFailed>()(
  'MeetingWriteFailed',
  { cause: Schema.Defect() },
) {}

type Meeting = Extract<MeetingInput, { _tag: 'meeting' }>

type Held = { id: string; kind: string; meta: MeetingMeta | null }

const write = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new MeetingWriteFailed({ cause }),
  })

/** Dispatch what a committed write handed back; never fails. */
const dispatchAll = (events: ReadonlyArray<DomainEvent> | null) =>
  Effect.forEach(events ?? [], (event) =>
    dispatchDomainEvent(event).pipe(Effect.provide(webEnqueue)),
  )

/** The row a uid, or failing that a calendar event id, names. */
async function heldMeeting(
  uid: string | null,
  eventId: string | null,
): Promise<Held | null> {
  const select = () =>
    db
      .select({
        id: interaction.id,
        kind: interaction.kind,
        meta: interaction.meta,
      })
      .from(interaction)
  const byUid =
    uid === null
      ? undefined
      : (await select().where(eq(interaction.messageId, uid))).at(0)
  const row =
    byUid ??
    (eventId === null
      ? undefined
      : (
          await select()
            .where(
              and(
                eq(interaction.kind, 'meeting'),
                sql`${interaction.meta} ->> 'calendar_event_id' = ${eventId}`,
              ),
            )
            .limit(1)
        ).at(0))
  if (row === undefined) return null
  return {
    id: row.id,
    kind: row.kind,
    meta: row.meta?.kind === 'meeting' ? row.meta : null,
  }
}

const addressesOf = (meeting: Meeting): ParticipantAddresses => ({
  from:
    meeting.organizer === null
      ? null
      : { email: meeting.organizer, name: null },
  to: meeting.attendees.map((a) => ({ email: a.email, name: a.name })),
  cc: [],
})

const allAddresses = (a: ParticipantAddresses): Array<Address> => [
  ...(a.from === null ? [] : [a.from]),
  ...a.to,
  ...a.cc,
]

/**
 * The meeting's meta from its event. What only Spaces writes (a recorder's
 * events, `Nothing to note`) is kept from the held row; the place is the
 * event's, so one taken off the event goes here too.
 */
const metaOf = (meeting: Meeting, held: MeetingMeta | null): MeetingMeta => ({
  ...withoutPlace(held),
  ...(meeting.location === null ? {} : { location: meeting.location }),
  kind: 'meeting',
  ends_at: meeting.endsAt.toISOString(),
  status: meeting.status,
  conference_url: meeting.conferenceUrl,
  organizer: meeting.organizer,
  recurring_instance_id: meeting.recurringInstanceId,
  rsvp: Object.fromEntries(meeting.attendees.map((a) => [a.email, a.rsvp])),
  calendar_event_id: held?.calendar_event_id ?? meeting.eventId,
})

const withoutPlace = (held: MeetingMeta | null): Partial<MeetingMeta> => {
  if (held === null) return {}
  const { location: _place, ...rest } = held
  return rest
}

/** Whether a member removed this meeting, or the series it is one of. */
const removedFromSpaces = (uid: string) =>
  write(async () => {
    const series = seriesUidOf(uid)
    const rows = await db
      .select({ uid: meetingRemoval.uid })
      .from(meetingRemoval)
      .where(
        or(
          eq(meetingRemoval.uid, uid),
          and(eq(meetingRemoval.uid, series), eq(meetingRemoval.series, true)),
        ),
      )
      .limit(1)
    return rows.length > 0
  })

const mailbox = alias(accountConnection, 'mailbox')
const mailIntegration = alias(integration, 'mail_integration')

/**
 * The exclude list of the mailbox the calendar's owner connected on the
 * calendar's own address; null when there is none, so nothing is excluded.
 */
const calendarExclude = (integrationId: string) =>
  write(async (): Promise<MailExclude | null> => {
    const rows = await db
      .select({ config: mailIntegration.config })
      .from(integration)
      .innerJoin(
        accountConnection,
        eq(accountConnection.id, integration.connectionId),
      )
      .innerJoin(
        mailbox,
        and(
          eq(mailbox.userId, accountConnection.userId),
          sql`lower(${mailbox.externalEmail}) = lower(${accountConnection.externalEmail})`,
        ),
      )
      .innerJoin(mailIntegration, eq(mailIntegration.connectionId, mailbox.id))
      .where(
        and(
          eq(integration.id, integrationId),
          eq(mailIntegration.capabilityId, PRODUCTS.google.gmail.plugin),
          isNull(mailIntegration.removedAt),
        ),
      )
      .limit(1)
    const row = rows.at(0)
    return row === undefined ? null : syncedMailSettingsOf(row.config).exclude
  })

/** A held meeting rewritten from the event, its edges with it. */
const follow = (meeting: Meeting, heldId: string, records: Array<string>) =>
  write(() =>
    db.transaction(async (tx) => {
      const locked = (
        await tx
          .select({ meta: interaction.meta })
          .from(interaction)
          .where(eq(interaction.id, heldId))
          .for('update')
      ).at(0)
      const before = locked?.meta?.kind === 'meeting' ? locked.meta : null
      const addresses = addressesOf(meeting)
      const current = [
        ...records,
        ...(await matchParticipants(tx, allAddresses(addresses))),
      ]
      const kept = new Set(Object.keys(metaOf(meeting, null).rsvp))
      const departed = Object.keys(before?.rsvp ?? {})
        .filter((email) => !kept.has(email))
        .map((email): Address => ({ email, name: null }))
      const lost = (await matchParticipants(tx, departed)).filter(
        (id) => !current.includes(id),
      )
      return updateInteraction(tx, heldId, {
        subject: meeting.subject,
        occurredAt: meeting.startsAt,
        meta: metaOf(meeting, before),
        edges: { add: current, remove: lost },
      })
    }),
  ).pipe(Effect.tap(dispatchAll))

const logFull = Effect.fn('logMeeting.full')(function* (
  ctx: MeetingLaneContext,
  meeting: Meeting,
): Effect.fn.Return<MeetingResult, MeetingWriteFailed> {
  const held = yield* write(() => heldMeeting(meeting.uid, null))
  if (held !== null && held.kind !== 'meeting')
    return {
      outcome: 'refused',
      reason: `${meeting.uid} is already a ${held.kind}'s key`,
    }
  const addresses = addressesOf(meeting)
  const decisions = yield* participantDecisionsProgram(
    addresses,
    ctx.integrationId,
  ).pipe(Effect.mapError((e) => new MeetingWriteFailed({ cause: e.cause })))
  if (held === null) {
    if (yield* removedFromSpaces(meeting.uid))
      return { outcome: 'refused', reason: 'removed from Spaces' }
    const refused = meetingRefusal({
      status: meeting.status,
      selfRsvp: meeting.attendees.find((a) => a.self)?.rsvp ?? null,
      decisions,
      exclude: yield* calendarExclude(ctx.integrationId),
    })
    if (refused !== null) return { outcome: 'refused', reason: refused.detail }
  }
  // Before the transaction: `resolveEntity` commits its own.
  const records = yield* resolveParticipantsProgram(decisions, ctx).pipe(
    Effect.mapError((e) => new MeetingWriteFailed({ cause: e.cause })),
  )
  if (held === null) {
    const written = yield* write(() =>
      db.transaction((tx) =>
        writeIntegrationInteraction(tx, {
          integrationId: ctx.integrationId,
          kind: 'meeting',
          messageId: meeting.uid,
          threadId: null,
          subject: meeting.subject,
          occurredAt: meeting.startsAt,
          meta: metaOf(meeting, null),
          body: null,
          edges: async () => [
            ...records.entityIds,
            ...(await matchParticipants(tx, allAddresses(addresses))),
          ],
        }),
      ),
    )
    if (written.kind === 'written') {
      yield* dispatchAll(written.events)
      return { outcome: 'created', interactionId: written.interactionId }
    }
  }
  // Held, or born by another calendar's sync a moment ago.
  const row = held ?? (yield* write(() => heldMeeting(meeting.uid, null)))
  if (row === null)
    return yield* new MeetingWriteFailed({
      cause: new Error(`${meeting.uid} conflicted but no row holds it`),
    })
  yield* follow(meeting, row.id, records.entityIds)
  return { outcome: 'updated', interactionId: row.id }
})

const logCancellation = Effect.fn('logMeeting.cancellation')(function* (
  input: Extract<MeetingInput, { _tag: 'meeting-cancelled' }>,
): Effect.fn.Return<MeetingResult, MeetingWriteFailed> {
  const held = yield* write(() => heldMeeting(input.uid, input.eventId))
  if (held === null || held.kind !== 'meeting' || held.meta === null)
    return { outcome: 'refused', reason: 'no meeting holds this event' }
  const meta: MeetingMeta = { ...held.meta, status: 'cancelled' }
  yield* write(() =>
    db.transaction((tx) => updateInteraction(tx, held.id, { meta })),
  )
  return { outcome: 'updated', interactionId: held.id }
})

export const logMeetingProgram = (
  ctx: MeetingLaneContext,
  input: MeetingInput,
): Effect.Effect<MeetingResult, MeetingWriteFailed> =>
  input._tag === 'meeting' ? logFull(ctx, input) : logCancellation(input)

/**
 * People a recorder names, through the participants module the mailbox and
 * the calendar run on: the records they resolve to, plus the ones their
 * addresses already match. No noise rule — a recorded call happened.
 */
export const resolveAttendeesProgram = Effect.fn('resolveAttendees')(function* (
  ctx: MeetingLaneContext,
  people: ReadonlyArray<ParticipantInput>,
): Effect.fn.Return<ReadonlyArray<string>, MeetingWriteFailed> {
  const addresses: ParticipantAddresses = {
    from: null,
    to: people.map((p) => ({ email: p.email, name: p.name })),
    cc: [],
  }
  const decisions = yield* participantDecisionsProgram(
    addresses,
    ctx.integrationId,
  ).pipe(Effect.mapError((e) => new MeetingWriteFailed({ cause: e.cause })))
  const records = yield* resolveParticipantsProgram(decisions, ctx).pipe(
    Effect.mapError((e) => new MeetingWriteFailed({ cause: e.cause })),
  )
  const matched = yield* write(() =>
    db.transaction((tx) => matchParticipants(tx, addresses.to)),
  )
  return [...new Set([...records.entityIds, ...matched])]
})
