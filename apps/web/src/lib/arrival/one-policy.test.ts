import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entityAlias, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fileArrivalProgram } from './file'
import { MAILBOX, bcc } from './fixtures'
import type * as FreeDomains from './free-email-domains'
import { logMeetingProgram } from './meeting'
import { arrivalFromSource } from './message'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * One participants policy for mail and calendar: the free-provider list —
 * the policy's tested data — is changed here, and the same addresses arriving
 * by mail and as calendar attendees change the same way. Neither lane keeps
 * a copy of the judgement for the change to miss.
 */
const policy = vi.hoisted(() => ({ alsoFree: new Set<string>() }))
vi.mock('./free-email-domains', async (importOriginal) => {
  const real = await importOriginal<typeof FreeDomains>()
  return {
    ...real,
    isFreeEmailDomain: (host: string) =>
      policy.alsoFree.has(host.trim().toLowerCase()) ||
      real.isFreeEmailDomain(host),
  }
})

const anIntegration = async (capabilityId: string) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return { integrationId: row.id, authorId: FIXTURE_ACTOR.id }
}

const holds = async (kind: 'email' | 'domain', valueNorm: string) =>
  (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.kind, kind), eq(entityAlias.valueNorm, valueNorm)),
      )
  ).length > 0

/** One founder by mail at `mailDomain`, one at a meeting at `meetingDomain`. */
const arriveBothWays = async (mailDomain: string, meetingDomain: string) => {
  const mail = await anIntegration('core.mailbox')
  const arrival = await arrivalFromSource(
    bcc({
      messageId: `${randomUUID()}@${mailDomain}`,
      from: `Jane <jane@${mailDomain}>`,
      to: 'Anish <anish@fund.example>',
      subject: 'Raising',
    }),
    { mailboxAddress: MAILBOX, receivedAt: new Date() },
  )
  if (arrival.kind !== 'message') throw new Error('refused')
  const filed = await Effect.runPromise(
    fileArrivalProgram(arrival.message, mail),
  )
  expect(filed.kind).toBe('written')

  const calendar = await anIntegration('google-calendar')
  const met = await Effect.runPromise(
    logMeetingProgram(calendar, {
      _tag: 'meeting',
      uid: `${randomUUID()}@google.com`,
      eventId: randomUUID(),
      status: 'scheduled',
      startsAt: new Date('2026-10-12T10:00:00.000Z'),
      endsAt: new Date('2026-10-12T11:00:00.000Z'),
      subject: 'Intro',
      organizer: null,
      conferenceUrl: null,
      recurringInstanceId: null,
      attendees: [
        {
          email: 'anish@fund.example',
          name: null,
          rsvp: 'accepted',
          self: true,
        },
        {
          email: `sam@${meetingDomain}`,
          name: 'Sam',
          rsvp: 'accepted',
          self: false,
        },
      ],
    }),
  )
  expect(met.outcome).toBe('created')
  return {
    mail: {
      person: await holds('email', `jane@${mailDomain}`),
      company: await holds('domain', mailDomain),
    },
    calendar: {
      person: await holds('email', `sam@${meetingDomain}`),
      company: await holds('domain', meetingDomain),
    },
  }
}

beforeEach(async () => {
  await truncateAndReseed()
  policy.alsoFree.clear()
  await db.insert(user).values({
    id: `member-${randomUUID().slice(0, 8)}`,
    name: 'Anish',
    email: 'anish@fund.example',
    emailVerified: true,
  })
})

describe('the participants policy is one module', () => {
  it('a work domain makes a company in both lanes', async () => {
    expect(await arriveBothWays('mailco.example', 'meetco.example')).toEqual({
      mail: { person: true, company: true },
      calendar: { person: true, company: true },
    })
  })

  it('the same domain on the free-provider list makes a company in neither', async () => {
    policy.alsoFree.add('mailco.example').add('meetco.example')
    expect(await arriveBothWays('mailco.example', 'meetco.example')).toEqual({
      mail: { person: true, company: false },
      calendar: { person: true, company: false },
    })
  })
})
