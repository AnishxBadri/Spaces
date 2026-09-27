import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, count, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
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
import { truncatePublicTables } from '@spaces/db/test-db'
import { FakeImapServer } from '#/test/fake-imap'
import { enqueued } from '#/test/queue-stub'
import { canRead } from '#/lib/notes/visibility'
import { recordTimelineProgram } from '#/lib/timeline/record'
import { FIXTURE_ACTOR, seedTestDatabase } from '../../../vitest.seed'
import { MAILBOX, bcc, gmailForward } from './fixtures'
import { pollMailboxProgram } from './poll'
import type { PollOutcome } from './poll'
import { MailSchedule } from './schedule'
import type { ScheduleTarget } from './schedule'
import { MAILBOX_CAPABILITY, saveMailboxProgram } from './settings'

/**
 * SPA-56 end to end, minus the network: the poll against the in-repo fake
 * IMAP server (`#/test/fake-imap`), writing to this worker's test database.
 * Each claim of the slice that is about what lands in Postgres is one test
 * here — the dedupe, the UIDVALIDITY restart, match-never-create, the
 * provenance pair, the backoff, the shared body, the inherited edges and the
 * derived deal timeline. The `job_run` row is the worker's, so its test is
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
  await truncatePublicTables((text) => db.$client.query(text))
  const speak = console.log
  console.log = () => undefined
  try {
    await seedTestDatabase()
  } finally {
    console.log = speak
  }
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

  it('matches only existing aliases: an unknown domain creates no entity and no alias', async () => {
    await configure()
    const entities = async () =>
      (await db.select({ n: count() }).from(entity)).at(0)?.n
    const aliases = async () =>
      (await db.select({ n: count() }).from(entityAlias)).at(0)?.n
    const before = { e: await entities(), a: await aliases() }

    server.deliver(
      bcc({
        messageId: 'stranger@unknown.dev',
        from: 'Stranger <bob@unknown.dev>',
        to: 'Anish <anish@fund.example>',
        subject: 'Hello from nowhere',
      }),
    )
    expect((await poll()).written).toBe(1)

    // One entity more — the body note — and not one company or person.
    expect(await entities()).toBe((before.e ?? 0) + 1)
    expect(await aliases()).toBe(before.a)
    const kinds = await db
      .select({ kind: entity.kind })
      .from(entity)
      .where(inArray(entity.kind, ['company', 'person']))
    expect(kinds).toEqual([])
    expect(await edgesOf('stranger@unknown.dev')).toEqual([])
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
    expect(await edgesOf(row?.messageId ?? '')).toEqual([acme, jane].sort())
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
    expect(await edgesOf('reply-9@elsewhere.org')).toEqual([acme, jane].sort())
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
