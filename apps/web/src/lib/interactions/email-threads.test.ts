import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  company,
  emailDraft,
  emailGrant,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  note,
  person,
} from '@spaces/db/schema'
import type { EmailMeta } from '@spaces/db/schema/interactions'
import { user } from '@spaces/db/schema/auth'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import type { ThreadFilter } from '#/lib/email/threads'
import { listEmailThreadsProgram } from './email-threads'

/**
 * The Email page's Threads: one row per thread, newest first, drawn from
 * its newest message; the three filters; the search; paging by cursor with
 * a total that counts the filter, never the page.
 */

const READER = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-threads-teammate',
  name: 'Priya Raman',
  email: 'priya@fund.example',
  emailVerified: true,
}

let mailbox = ''

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
  const conn = (
    await db
      .insert(accountConnection)
      .values({
        userId: READER.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: 'anish@fund.example',
        tokensEnc: Buffer.from('never read'),
        scopes: ['openid', 'email', 'gmail.readonly'],
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!conn) throw new Error('no connection')
  const lane = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId: conn.id,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!lane) throw new Error('no integration')
  mailbox = lane.id
})

const run = (
  input: {
    filter?: ThreadFilter
    q?: string
    cursor?: string
    limit?: number
  } = {},
) => Effect.runPromise(listEmailThreadsProgram(READER, input))

const emailMeta = (over: Partial<EmailMeta> = {}): EmailMeta => ({
  kind: 'email',
  from: 'dev@exponent.example',
  to: ['anish@fund.example'],
  cc: [],
  date: '2026-10-15T09:00:00.000Z',
  mime_blob_sha: null,
  ...over,
})

async function aRecord(kind: 'company' | 'person', name: string) {
  const [ent] = await db
    .insert(entity)
    .values({ kind, canonicalName: name })
    .returning({ id: entity.id })
  if (kind === 'company') await db.insert(company).values({ entityId: ent.id })
  else await db.insert(person).values({ entityId: ent.id })
  return ent.id
}

/**
 * One email. `body` gives it a body note owned by that member; `viaMailbox`
 * syncs it through the reader's mailbox.
 */
async function anEmail(input: {
  subject: string | null
  at: string
  thread?: string
  body?: { authorId: string; visibility: 'shared' | 'private' }
  viaMailbox?: boolean
  meta?: EmailMeta | null
  records?: ReadonlyArray<string>
}): Promise<string> {
  let noteId: string | null = null
  if (input.body !== undefined) {
    const [n] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: input.subject ?? 'Email' })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: n.id,
      authorId: input.body.authorId,
      visibility: input.body.visibility,
      bodyMd: 'The body nobody else may read.',
    })
    noteId = n.id
  }
  const [row] = await db
    .insert(interaction)
    .values({
      kind: 'email',
      subject: input.subject,
      occurredAt: new Date(input.at),
      threadId: input.thread ?? null,
      noteId,
      meta: input.meta === undefined ? emailMeta() : input.meta,
      ...(input.viaMailbox === true
        ? { sourceClass: 'integration' as const, sourceRef: mailbox }
        : {}),
    })
    .returning({ id: interaction.id })
  for (const entityId of input.records ?? [])
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
  return row.id
}

const subjects = (page: { threads: ReadonlyArray<{ subject: string }> }) =>
  page.threads.map((t) => t.subject)

describe('listEmailThreadsProgram', () => {
  it('lists one row per thread, newest first, drawn from its newest message', async () => {
    const exponent = await aRecord('company', 'Exponent')
    const dev = await aRecord('person', 'Dev Shah')
    const priya = await aRecord('person', 'Priya Raman')
    await anEmail({
      subject: 'Series A data room',
      at: '2026-10-13T18:40:00.000Z',
      thread: 'g-1',
      records: [priya, exponent],
    })
    const newest = await anEmail({
      subject: 'Re: Series A data room',
      at: '2026-10-15T10:42:00.000Z',
      thread: 'g-1',
      meta: emailMeta({ summary: 'Dev asked for the cohort file.' }),
      records: [dev, exponent],
    })
    await anEmail({ subject: 'Q3 board deck', at: '2026-10-14T09:00:00.000Z' })

    const page = await run()
    expect(subjects(page)).toEqual(['Re: Series A data room', 'Q3 board deck'])
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeNull()
    const top = page.threads[0]
    expect(top.id).toBe(newest)
    expect(top.messages).toBe(2)
    expect(top.summary).toBe('Dev asked for the cohort file.')
    expect(top.attendees.map((a) => a.name)).toEqual([
      'Priya Raman',
      'Dev Shah',
    ])
    expect(top.records.map((r) => r.name)).toEqual(['Exponent'])
    expect(page.threads[1].messages).toBe(1)
  })

  it('draws a bare email — no meta, no body — with its subject and day', async () => {
    await anEmail({
      subject: 'Seeded hello',
      at: '2026-10-10T09:00:00.000Z',
      meta: null,
    })
    const [row] = (await run()).threads
    expect(row.subject).toBe('Seeded hello')
    expect(row.at).toBe('2026-10-10T09:00:00.000Z')
    expect(row.summary).toBeNull()
    expect(row.privateBody).toBe(false)
    expect(row.attendees).toEqual([])
  })

  it('keeps a private body’s thread under All with its subject, and nothing of its body', async () => {
    await anEmail({
      subject: 'Their private thread',
      at: '2026-10-12T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'private' },
      meta: emailMeta({ summary: 'What it says.' }),
    })
    const [row] = (await run()).threads
    expect(row.subject).toBe('Their private thread')
    expect(row.privateBody).toBe(true)
    expect(row.summary).toBeNull()
  })

  it('Mine: a body the reader owns, or a message through the reader’s mailbox', async () => {
    await anEmail({
      subject: 'My own body',
      at: '2026-10-14T09:00:00.000Z',
      body: { authorId: READER.id, visibility: 'private' },
    })
    await anEmail({
      subject: 'Through my mailbox',
      at: '2026-10-13T09:00:00.000Z',
      viaMailbox: true,
    })
    await anEmail({
      subject: 'Priya’s',
      at: '2026-10-12T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'private' },
    })
    await anEmail({ subject: 'Nobody’s', at: '2026-10-11T09:00:00.000Z' })

    const page = await run({ filter: 'mine' })
    expect(subjects(page)).toEqual(['My own body', 'Through my mailbox'])
    expect(page.total).toBe(2)
  })

  it('Shared with me: someone else’s body opened to the reader, by a grant or a shared mailbox', async () => {
    const granted = await anEmail({
      subject: 'Granted to me',
      at: '2026-10-14T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'private' },
    })
    await db.insert(emailGrant).values({
      interactionId: granted,
      userId: READER.id,
      grantedBy: TEAMMATE.id,
    })
    await anEmail({
      subject: 'Her mailbox, shared',
      at: '2026-10-13T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'shared' },
    })
    await anEmail({
      subject: 'Still hers alone',
      at: '2026-10-12T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'private' },
    })
    await anEmail({
      subject: 'My own',
      at: '2026-10-11T09:00:00.000Z',
      body: { authorId: READER.id, visibility: 'shared' },
    })

    const page = await run({ filter: 'shared' })
    expect(subjects(page)).toEqual(['Granted to me', 'Her mailbox, shared'])
    expect(page.total).toBe(2)
    expect(page.threads[0].privateBody).toBe(false)
  })

  it('passes a thread through a filter when any one of its messages does', async () => {
    await anEmail({
      subject: 'Intro',
      at: '2026-10-10T09:00:00.000Z',
      thread: 'g-2',
      viaMailbox: true,
    })
    await anEmail({
      subject: 'Re: Intro',
      at: '2026-10-11T09:00:00.000Z',
      thread: 'g-2',
    })
    const page = await run({ filter: 'mine' })
    expect(subjects(page)).toEqual(['Re: Intro'])
    expect(page.threads[0].messages).toBe(2)
  })

  it('pages by cursor, newest first, with the filter’s total on every page', async () => {
    for (const day of [10, 11, 12, 13, 14])
      await anEmail({
        subject: `Thread ${String(day)}`,
        at: `2026-10-${String(day)}T09:00:00.000Z`,
        viaMailbox: day !== 12,
      })

    const one = await run({ limit: 2 })
    expect(subjects(one)).toEqual(['Thread 14', 'Thread 13'])
    expect(one.total).toBe(5)
    if (one.nextCursor === null) throw new Error('no second page')
    const two = await run({ limit: 2, cursor: one.nextCursor })
    expect(subjects(two)).toEqual(['Thread 12', 'Thread 11'])
    expect(two.total).toBe(5)
    if (two.nextCursor === null) throw new Error('no third page')
    const three = await run({ limit: 2, cursor: two.nextCursor })
    expect(subjects(three)).toEqual(['Thread 10'])
    expect(three.nextCursor).toBeNull()

    const mine = await run({ filter: 'mine', limit: 3 })
    expect(subjects(mine)).toEqual(['Thread 14', 'Thread 13', 'Thread 11'])
    expect(mine.total).toBe(4)
    if (mine.nextCursor === null) throw new Error('no second mine page')
    expect(
      subjects(
        await run({ filter: 'mine', limit: 3, cursor: mine.nextCursor }),
      ),
    ).toEqual(['Thread 10'])
  })

  it('reads an unreadable cursor as page one', async () => {
    await anEmail({ subject: 'Only', at: '2026-10-10T09:00:00.000Z' })
    expect(subjects(await run({ cursor: 'not a cursor' }))).toEqual(['Only'])
  })

  it('searches subjects and the records on a thread, never a body', async () => {
    const lattice = await aRecord('company', 'Lattice Capital')
    await anEmail({ subject: 'Pilot terms', at: '2026-10-14T09:00:00.000Z' })
    await anEmail({
      subject: 'Intro',
      at: '2026-10-13T09:00:00.000Z',
      records: [lattice],
    })
    await anEmail({
      subject: 'Unrelated',
      at: '2026-10-12T09:00:00.000Z',
      body: { authorId: TEAMMATE.id, visibility: 'private' },
    })
    expect(subjects(await run({ q: 'pilot' }))).toEqual(['Pilot terms'])
    expect(subjects(await run({ q: 'lattice' }))).toEqual(['Intro'])
    expect((await run({ q: 'nobody else may read' })).total).toBe(0)
  })

  it('marks a thread the reader holds a reply draft on, and no one else’s', async () => {
    const first = await anEmail({
      subject: 'Term sheet',
      at: '2026-10-10T09:00:00.000Z',
      thread: 'g-3',
    })
    await anEmail({
      subject: 'Re: Term sheet',
      at: '2026-10-11T09:00:00.000Z',
      thread: 'g-3',
    })
    const other = await anEmail({
      subject: 'Theirs to answer',
      at: '2026-10-09T09:00:00.000Z',
    })
    await db.insert(emailDraft).values([
      { userId: READER.id, mode: 'reply', inReplyToId: first },
      { userId: TEAMMATE.id, mode: 'reply', inReplyToId: other },
    ])
    const page = await run()
    expect(page.threads.map((t) => [t.subject, t.draft])).toEqual([
      ['Re: Term sheet', true],
      ['Theirs to answer', false],
    ])
  })

  it('marks the reader among the people, for the row to leave out', async () => {
    const me = await aRecord('person', 'Anish Badri')
    await db.insert(entityAlias).values({
      entityId: me,
      kind: 'email',
      value: FIXTURE_ACTOR.email,
      valueNorm: FIXTURE_ACTOR.email.toLowerCase(),
    })
    const dana = await aRecord('person', 'Dana Moreau')
    await anEmail({
      subject: 'LP update',
      at: '2026-10-10T09:00:00.000Z',
      records: [me, dana],
    })
    const [row] = (await run()).threads
    expect(row.attendees).toEqual([
      { name: 'Anish Badri', self: true },
      { name: 'Dana Moreau', self: false },
    ])
  })
})
