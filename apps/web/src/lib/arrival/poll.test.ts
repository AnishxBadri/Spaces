import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, count, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  duplicateCandidate,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  link,
  mailbox,
  note,
  person,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FakeImapServer } from '#/test/fake-imap'
import { truncateAndReseed } from '#/test/reseed'
import { enqueued } from '#/test/queue-stub'
import { canRead } from '#/lib/notes/visibility'
import { recordTimelineProgram } from '#/lib/timeline/record'
import {
  createObjectProgram,
  createRecordProgram,
} from '#/lib/attributes/object-registry'
import { entityContext } from '#/lib/inbox/context'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { MAILBOX, OUTLOOK_FORWARD, bcc, gmailForward } from './fixtures'
import { arrivalFromSource } from './message'
import { participantRecordsProgram } from './participant-records'
import { pollMailboxProgram } from './poll'
import type { PollOutcome } from './poll'
import { MailSchedule } from './schedule'
import type { ScheduleTarget } from './schedule'
import { MAILBOX_CAPABILITY, saveMailboxProgram } from './settings'

/**
 * SPA-56 end to end, minus the network: the poll against the in-repo fake
 * IMAP server (`#/test/fake-imap`), writing to this worker's test database.
 * Each claim of the slice that is about what lands in Postgres is one test
 * here — the dedupe, the UIDVALIDITY restart, the provenance pair, the
 * backoff, the shared body, the inherited edges and the derived deal
 * timeline. SPA-86 turned match-never-create into participants-become-
 * records; its claims are the second `describe` below. The `job_run` row is the worker's, so its test is
 * `worker/jobs/poll-mailbox.test.ts` (the web tree may not import the worker).
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const PASSWORD = 'app-password-1234'

let server: FakeImapServer
let port = 0
const syncs: Array<ScheduleTarget | null> = []
const schedule = Layer.succeed(
  MailSchedule,
  MailSchedule.of({
    sync: (target) => Effect.sync(() => void syncs.push(target)),
  }),
)

beforeEach(async () => {
  // Isolation per test, not per file: every test here configures the one
  // mailbox row and asserts counts of what it wrote. The same structural
  // truncate-and-reseed the harness runs before each file, no delete list.
  await truncateAndReseed()
  server = new FakeImapServer({ user: MAILBOX, password: PASSWORD })
  port = await server.start()
  syncs.length = 0
  enqueued.length = 0
})

afterEach(async () => {
  await server.stop()
})

async function configure(password = PASSWORD): Promise<void> {
  await Effect.runPromise(
    saveMailboxProgram(FIXTURE_ACTOR.id, {
      address: MAILBOX,
      host: '127.0.0.1',
      port,
      useTls: false,
      folder: 'INBOX',
      cadenceMinutes: 5,
      password,
    }),
  )
}

function poll(now = new Date()): Promise<PollOutcome> {
  return Effect.runPromise(
    pollMailboxProgram(now).pipe(Effect.provide(schedule)),
  )
}

async function aCompany(name: string, domain: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no company')
  await db.insert(company).values({ entityId: row.id })
  await db.insert(entityAlias).values({
    entityId: row.id,
    kind: 'domain',
    value: domain,
    valueNorm: domain,
    isIdentity: true,
  })
  return row.id
}

async function aPerson(name: string, email: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'person', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no person')
  await db.insert(person).values({ entityId: row.id })
  await db.insert(entityAlias).values({
    entityId: row.id,
    kind: 'email',
    value: email,
    valueNorm: email,
    isIdentity: true,
  })
  return row.id
}

async function aDeal(name: string, companyId: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no deal')
  await db.insert(link).values({
    fromEntityId: row.id,
    toEntityId: companyId,
    relation: 'references',
    attrSlug: 'company',
  })
  return row.id
}

async function aMember(email: string): Promise<string> {
  const id = `member-${randomUUID().slice(0, 8)}`
  await db.insert(user).values({ id, name: email, email, emailVerified: true })
  return id
}

async function interactionCount(): Promise<number> {
  return (await db.select({ n: count() }).from(interaction)).at(0)?.n ?? 0
}

async function edgesOf(messageId: string): Promise<Array<string>> {
  const rows = await db
    .select({ id: interactionEntity.entityId })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .where(eq(interaction.messageId, messageId))
  return rows.map((r) => r.id).sort()
}

/** The record holding an identity alias; throws when there is none. */
async function holderOf(
  kind: 'email' | 'domain',
  valueNorm: string,
): Promise<string> {
  const row = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, kind),
          eq(entityAlias.valueNorm, valueNorm),
          eq(entityAlias.isIdentity, true),
        ),
      )
  ).at(0)
  if (!row) throw new Error(`nobody holds ${kind} ${valueNorm}`)
  return row.id
}

const janeMail = (id = 'seed-1@acme.io') =>
  bcc({
    messageId: id,
    from: 'Jane Founder <jane@acme.io>',
    to: 'Anish <anish@fund.example>',
    subject: 'Seed round',
  })

describe('the forwarding mailbox poll', () => {
  it('writes one interaction per Message-ID, on the matched person and company, as the core integration', async () => {
    const acme = await aCompany('Acme', 'acme.io')
    const jane = await aPerson('Jane Founder', 'jane@acme.io')
    await configure()
    server.deliver(janeMail())

    const outcome = await poll()
    expect(outcome.written).toBe(1)

    const row = (
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.messageId, 'seed-1@acme.io'))
    ).at(0)
    expect(row?.kind).toBe('email')
    expect(row?.subject).toBe('Seed round')
    expect(row?.occurredAt.toISOString()).toBe('2026-09-21T10:04:00.000Z')
    expect(row?.threadId).toBe('seed-1@acme.io')
    // The provenance pair: class `integration`, ref the core mailbox row.
    expect(row?.sourceClass).toBe('integration')
    const owner = (
      await db
        .select({ capabilityId: integration.capabilityId })
        .from(integration)
        .where(eq(integration.id, row?.sourceRef ?? randomUUID()))
    ).at(0)
    expect(owner?.capabilityId).toBe(MAILBOX_CAPABILITY)
    expect(await edgesOf('seed-1@acme.io')).toEqual([acme, jane].sort())

    // The schedule followed the row.
    expect(syncs.at(-1)).toMatchObject({ cadenceMinutes: 5 })
    // Saving sent one poll at once.
    expect(enqueued.map((e) => e.name)).toEqual(['mail.poll'])
  })

  it('forwarding the same message twice leaves one interaction — the unique index is the dedupe', async () => {
    await configure()
    server.deliver(janeMail())
    await poll()
    // A second copy of the same message at a new UID, and a re-poll.
    server.deliver(janeMail())
    const second = await poll()
    expect(second).toMatchObject({ fetched: 1, written: 0, duplicate: 1 })
    const third = await poll()
    expect(third.fetched).toBe(0)
    expect(await interactionCount()).toBe(1)

    // A true forward pressed twice — two wrapper Message-IDs — is one row too.
    server.deliver(gmailForward('press-1@mail.gmail.com'))
    server.deliver(gmailForward('press-2@mail.gmail.com'))
    const forwards = await poll()
    expect(forwards).toMatchObject({ written: 1, duplicate: 1 })
    expect(await interactionCount()).toBe(2)
  })

  it('restarts from UID 1 when UIDVALIDITY changes, and writes nothing twice', async () => {
    await configure()
    server.deliver(janeMail('a@acme.io'))
    server.deliver(janeMail('b@acme.io'))
    server.deliver(janeMail('c@acme.io'))
    await poll()
    expect(await interactionCount()).toBe(3)

    // The folder is recreated: new validity, the same mail renumbered 1..2.
    server.messages = server.messages.slice(1)
    server.renumber(99)
    const after = await poll()
    expect(after).toMatchObject({ fetched: 2, written: 0, duplicate: 2 })
    expect(after.summary).toContain('UIDVALIDITY changed')
    expect(server.commands).toContain('UID FETCH 1:* UID')
    expect(await interactionCount()).toBe(3)

    const box = (await db.select().from(mailbox)).at(0)
    expect(box).toMatchObject({ lastUid: 2, lastUidValidity: 99 })
  })

  it('refuses auto-replies, list mail, role senders and a missing Message-ID before any write', async () => {
    await configure()
    server.deliver(
      bcc({
        messageId: 'ooo@acme.io',
        from: 'jane@acme.io',
        to: MAILBOX,
        subject: 'Automatic reply: Seed round',
        extra: 'Auto-Submitted: auto-replied',
      }),
    )
    server.deliver(
      bcc({
        messageId: 'news@acme.io',
        from: 'news@substack.com',
        to: MAILBOX,
        subject: 'This week',
        extra: 'List-Unsubscribe: <https://x.example/u>',
      }),
    )
    server.deliver(
      bcc({
        messageId: 'n@docsend.com',
        from: 'noreply@docsend.com',
        to: MAILBOX,
        subject: 'Someone viewed your deck',
      }),
    )
    server.deliver(
      bcc({ messageId: '', from: 'jane@acme.io', to: MAILBOX, subject: 'x' }),
    )
    const outcome = await poll()
    expect(outcome).toMatchObject({ fetched: 4, written: 0 })
    expect(outcome.refused).toEqual({
      'auto-submitted': 1,
      'list-mail': 1,
      'role-sender': 1,
      'no-message-id': 1,
    })
    expect(await interactionCount()).toBe(0)
    expect(outcome.summary).toContain('auto-submitted 1')
  })

  it('a wrong password marks the mailbox in error with the server’s reason and backs off', async () => {
    await configure('the-wrong-password')
    server.deliver(janeMail())

    const failure = await Effect.runPromise(
      Effect.flip(
        pollMailboxProgram(new Date()).pipe(Effect.provide(schedule)),
      ),
    )
    expect(failure._tag).toBe('MailboxUnavailable')
    const box = (await db.select().from(mailbox)).at(0)
    expect(box?.status).toBe('error')
    expect(box?.failureCount).toBe(1)
    expect(box?.lastError).toBe(
      'Login refused: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    )

    // The next tick, a minute later, does not even connect.
    const logins = server.commands.filter((c) => c === 'LOGIN').length
    const skipped = await poll(new Date(Date.now() + 60_000))
    expect(skipped.summary).toMatch(/^backing off after 1 failed poll until /)
    expect(server.commands.filter((c) => c === 'LOGIN')).toHaveLength(logins)

    // Saving the right password resets the backoff, and the poll goes through.
    await configure(PASSWORD)
    expect((await db.select().from(mailbox)).at(0)).toMatchObject({
      status: 'pending',
      failureCount: 0,
      lastError: null,
    })
    expect((await poll()).written).toBe(1)
    expect((await db.select().from(mailbox)).at(0)?.status).toBe('ok')
  })

  it('files a true forward on the original: its sender, its date, its people', async () => {
    const acme = await aCompany('Acme', 'acme.io')
    const jane = await aPerson('Jane Founder', 'jane@acme.io')
    const anish = await aMember('anish@fund.example')
    await configure()
    server.deliver(gmailForward())
    expect((await poll()).written).toBe(1)

    const row = (await db.select().from(interaction)).at(0)
    expect(row?.subject).toBe('Seed round')
    expect(row?.occurredAt.toISOString()).toBe('2026-09-21T10:04:00.000Z')
    // Raj, on the Cc, had no record; arrival-2 made one (SPA-86).
    const raj = await holderOf('email', 'raj@acme.io')
    expect(await edgesOf(row?.messageId ?? '')).toEqual(
      [acme, jane, raj].sort(),
    )
    const body = (
      await db
        .select()
        .from(note)
        .where(eq(note.entityId, row?.noteId ?? randomUUID()))
    ).at(0)
    // Authored by the member who forwarded it.
    expect(body?.authorId).toBe(anish)
  })

  it('a forwarded body is born shared, and a second member reads it through the timeline', async () => {
    const acme = await aCompany('Acme', 'acme.io')
    await aMember('anish@fund.example')
    const second = await aMember('partner@fund.example')
    await configure()
    server.deliver(gmailForward())
    await poll()

    const items = await Effect.runPromise(recordTimelineProgram(acme))
    const thread = items.find((i) => i.type === 'interaction')
    expect(thread?.type === 'interaction' && thread.subject).toBe('Seed round')
    const noteId = thread?.type === 'interaction' ? thread.noteId : null
    const body = (
      await db
        .select()
        .from(note)
        .where(eq(note.entityId, noteId ?? randomUUID()))
    ).at(0)
    expect(body?.visibility).toBe('shared')
    expect(body?.bodyMd).toContain('We are raising $3M')
    expect(body && canRead({ id: second }, body)).toBe(true)
    // Provenance on the note's entity too.
    const noteEntity = (
      await db
        .select()
        .from(entity)
        .where(eq(entity.id, noteId ?? randomUUID()))
    ).at(0)
    expect(noteEntity?.sourceClass).toBe('integration')
  })

  it('a reply inherits the thread’s edges when its only overlap is the thread root', async () => {
    const acme = await aCompany('Acme', 'acme.io')
    const jane = await aPerson('Jane Founder', 'jane@acme.io')
    await configure()
    server.deliver(janeMail('root-1@acme.io'))
    await poll()

    // A week later: someone nobody knows replies on the thread.
    server.deliver(
      bcc({
        messageId: 'reply-9@elsewhere.org',
        from: 'Kim <kim@elsewhere.org>',
        to: 'Anish <anish@fund.example>',
        subject: 'Re: Seed round',
        date: 'Mon, 28 Sep 2026 09:00:00 +0000',
        inReplyTo: 'root-1@acme.io',
        references: '<root-1@acme.io>',
      }),
    )
    await poll()
    // Kim and her company are records now (SPA-86); the thread's are
    // inherited beside them.
    const kim = await holderOf('email', 'kim@elsewhere.org')
    const elsewhere = await holderOf('domain', 'elsewhere.org')
    expect(await edgesOf('reply-9@elsewhere.org')).toEqual(
      [acme, jane, kim, elsewhere].sort(),
    )
  })

  it('never edges a deal; a company with two deals shows the thread on both', async () => {
    const acme = await aCompany('Acme', 'acme.io')
    const seed = await aDeal('Acme seed', acme)
    const bridge = await aDeal('Acme bridge', acme)
    await configure()
    server.deliver(janeMail())
    await poll()

    const dealEdges = await db
      .select({ n: count() })
      .from(interactionEntity)
      .where(inArray(interactionEntity.entityId, [seed, bridge]))
    expect(dealEdges.at(0)?.n).toBe(0)

    for (const deal of [seed, bridge]) {
      const items = await Effect.runPromise(recordTimelineProgram(deal))
      const subjects = items.flatMap((i) =>
        i.type === 'interaction' ? [i.subject] : [],
      )
      expect(subjects).toEqual(['Seed round'])
    }
  })

  it('with no mailbox row, a poll unschedules and does nothing', async () => {
    const outcome = await poll()
    expect(outcome.summary).toBe('no mailbox configured')
    expect(syncs).toEqual([null])
    expect(server.commands).toEqual([])
    const any = await db
      .select({ n: count() })
      .from(mailbox)
      .where(and(eq(mailbox.address, MAILBOX)))
    expect(any.at(0)?.n).toBe(0)
  })
})

/** People and companies, and the identity aliases they hold. */
async function graphCounts(): Promise<{
  companies: number
  people: number
  identities: number
}> {
  const kinds = await db
    .select({ kind: entity.kind, n: count() })
    .from(entity)
    .where(inArray(entity.kind, ['company', 'person']))
    .groupBy(entity.kind)
  const identities = await db
    .select({ n: count() })
    .from(entityAlias)
    .where(eq(entityAlias.isIdentity, true))
  return {
    companies: kinds.find((k) => k.kind === 'company')?.n ?? 0,
    people: kinds.find((k) => k.kind === 'person')?.n ?? 0,
    identities: identities.at(0)?.n ?? 0,
  }
}

async function mailboxIntegrationId(): Promise<string> {
  const row = (
    await db
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.capabilityId, MAILBOX_CAPABILITY))
  ).at(0)
  if (!row) throw new Error('no mailbox integration')
  return row.id
}

/** A custom "Fund" object that keys its records on `domain`, and one record. */
async function aFundRecord(name: string, domain: string): Promise<string> {
  const object = await Effect.runPromise(
    createObjectProgram({
      singular: 'Fund',
      plural: 'Funds',
      identityKeys: ['domain'],
      createdBy: FIXTURE_ACTOR.id,
    }),
  )
  const row = await Effect.runPromise(
    createRecordProgram({
      objectId: object.id,
      name,
      values: { domain },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    }),
  )
  return row.id
}

describe('participants become records (SPA-86)', () => {
  it('a forwarded thread from a work domain creates one company and one person per non-member, each edged, as the mailbox', async () => {
    await aMember('anish@fund.example')
    await configure()
    server.deliver(gmailForward())
    expect((await poll()).written).toBe(1)

    // Jane (From) and Raj (Cc) at acme.io; Anish (To) is a member.
    expect(await graphCounts()).toEqual({
      companies: 1,
      people: 2,
      identities: 3,
    })
    const acme = await holderOf('domain', 'acme.io')
    const jane = await holderOf('email', 'jane@acme.io')
    const raj = await holderOf('email', 'raj@acme.io')
    const row = (await db.select().from(interaction)).at(0)
    expect(await edgesOf(row?.messageId ?? '')).toEqual(
      [acme, jane, raj].sort(),
    )

    const names = await db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(entity)
      .where(inArray(entity.id, [acme, jane, raj]))
    expect(new Map(names.map((n) => [n.id, n.name]))).toEqual(
      new Map([
        [acme, 'Acme'],
        [jane, 'Jane Founder'],
        [raj, 'Raj Mehta'],
      ]),
    )

    // The provenance pair on every record and every identity alias it holds.
    const ref = await mailboxIntegrationId()
    const records = await db
      .select({ sourceClass: entity.sourceClass, sourceRef: entity.sourceRef })
      .from(entity)
      .where(inArray(entity.id, [acme, jane, raj]))
    expect(records).toEqual(
      Array(3).fill({ sourceClass: 'integration', sourceRef: ref }),
    )
    const aliases = await db
      .select({
        isIdentity: entityAlias.isIdentity,
        sourceClass: entityAlias.sourceClass,
        sourceRef: entityAlias.sourceRef,
      })
      .from(entityAlias)
      .where(
        and(
          inArray(entityAlias.entityId, [acme, jane, raj]),
          eq(entityAlias.isIdentity, true),
        ),
      )
    expect(aliases).toEqual(
      Array(3).fill({
        isIdentity: true,
        sourceClass: 'integration',
        sourceRef: ref,
      }),
    )
    // And the inbox card says which channel, not the bare class.
    const side = await entityContext(acme)
    expect(side.label).toBe('mailbox')
  })

  it('a participant on a free provider is a person with no company', async () => {
    await configure()
    server.deliver(
      bcc({
        messageId: 'intro-1@newco.dev',
        from: 'Sam Founder <sam@newco.dev>',
        to: 'Anish <anish@fund.example>',
        cc: 'Lee Counsel <lee.counsel@gmail.com>',
        subject: 'Intro',
      }),
    )
    await poll()

    const lee = await holderOf('email', 'leecounsel@gmail.com')
    const companies = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    expect(companies.map((c) => c.id)).toEqual([
      await holderOf('domain', 'newco.dev'),
    ])
    const gmail = await db
      .select({ n: count() })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'gmail.com'),
        ),
      )
    expect(gmail.at(0)?.n).toBe(0)
    expect(await edgesOf('intro-1@newco.dev')).toContain(lee)
  })

  it('members and own-domain addresses create nothing, and are still named when their record exists', async () => {
    await aMember('anish@fund.example')
    await aMember('partner@fund.example')
    // Anish is also a person record (someone made one by hand); nobody else
    // at the fund is.
    const anishRecord = await aPerson('Anish Badri', 'anish@fund.example')
    const acme = await aCompany('Acme', 'acme.io')
    await configure()
    server.deliver(
      bcc({
        messageId: 'ic-1@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        to: 'Anish <anish@fund.example>',
        cc: 'Partner <partner@fund.example>, New Associate <associate@fund.example>',
        subject: 'Diligence call',
      }),
    )
    await poll()

    // Jane was created; nobody at fund.example, and no fund.example company.
    expect(await graphCounts()).toEqual({
      companies: 1,
      people: 2,
      identities: 3,
    })
    const jane = await holderOf('email', 'jane@acme.io')
    expect(await edgesOf('ic-1@acme.io')).toEqual(
      [acme, jane, anishRecord].sort(),
    )
  })

  it('a key another record already holds is a duplicate_candidate — not an error, not a second alias — and asked again, the same record', async () => {
    // Sequoia is tracked as a Fund, which claimed sequoia.com.
    const fund = await aFundRecord('Sequoia Capital', 'sequoia.com')
    expect(await holderOf('domain', 'sequoia.com')).toBe(fund)
    await configure()
    server.deliver(
      bcc({
        messageId: 'coinvest-1@sequoia.com',
        from: 'Pat Partner <pat@sequoia.com>',
        to: 'Anish <anish@fund.example>',
        subject: 'Co-invest on Acme?',
      }),
    )
    const outcome = await poll()
    expect(outcome.written).toBe(1)

    // A company was made for the thread, without the claim.
    const companies = await db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    expect(companies.map((c) => c.name)).toEqual(['Sequoia'])
    const sequoia = companies[0].id
    const claims = await db
      .select({ entityId: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'sequoia.com'),
        ),
      )
    expect(claims).toEqual([{ entityId: fund }])

    // The pair is in the inbox, keyed on what collided.
    const [a, b] = sequoia < fund ? [sequoia, fund] : [fund, sequoia]
    const pairs = await db
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          eq(duplicateCandidate.entityA, a),
          eq(duplicateCandidate.entityB, b),
        ),
      )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({
      status: 'open',
      score: 1,
      reason: { shared: 'domain', value: 'sequoia.com' },
    })
    // The thread is on the company and on Pat all the same.
    const pat = await holderOf('email', 'pat@sequoia.com')
    expect(await edgesOf('coinvest-1@sequoia.com')).toEqual(
      [sequoia, pat].sort(),
    )

    // Next week, a reply from Sequoia: the same company, no second pair.
    const before = await graphCounts()
    server.deliver(
      bcc({
        messageId: 'coinvest-2@sequoia.com',
        from: 'Pat Partner <pat@sequoia.com>',
        to: 'Anish <anish@fund.example>',
        subject: 'Re: Co-invest on Acme?',
        inReplyTo: 'coinvest-1@sequoia.com',
        references: '<coinvest-1@sequoia.com>',
      }),
    )
    await poll()
    expect(await graphCounts()).toEqual(before)
    expect(
      (await db.select({ n: count() }).from(duplicateCandidate)).at(0)?.n,
    ).toBe(1)
    expect(await edgesOf('coinvest-2@sequoia.com')).toEqual(
      [sequoia, pat].sort(),
    )
  })

  it('re-polling the same thread creates no second entity: the second run is all attaches', async () => {
    await aMember('anish@fund.example')
    await configure()
    server.deliver(gmailForward())
    server.deliver(OUTLOOK_FORWARD)
    await poll()
    const first = await graphCounts()
    // Acme, Beta, Gamma; Jane, Raj, Priya, Sam, Lee.
    expect(first).toEqual({ companies: 3, people: 5, identities: 8 })

    // The folder is recreated: both messages come round again.
    server.renumber(7)
    const again = await poll()
    expect(again).toMatchObject({ fetched: 2, written: 0, duplicate: 2 })
    expect(await graphCounts()).toEqual(first)

    // The same judgement, run by hand, attaches every record it names.
    const arrival = await arrivalFromSource(gmailForward(), {
      mailboxAddress: MAILBOX,
      receivedAt: new Date(),
    })
    if (arrival.kind !== 'message') throw new Error('refused')
    const records = await Effect.runPromise(
      participantRecordsProgram(arrival.message, {
        integrationId: await mailboxIntegrationId(),
        authorId: FIXTURE_ACTOR.id,
      }),
    )
    expect(records).toMatchObject({ created: 0, attached: 4 })
    expect(await graphCounts()).toEqual(first)
  })
})
