import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entitySpace,
  entityAlias,
  integration,
  link,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { QUEUES } from '@spaces/core/queue/names'
import { FakeImapServer } from '#/test/fake-imap'
import { minimalPdf } from '#/test/minimal-pdf'
import { truncateAndReseed } from '#/test/reseed'
import { enqueued } from '#/test/queue-stub'
import { storage } from '@spaces/core/writes/storage'
import {
  countUnfiledProgram,
  listDocumentsProgram,
} from '#/lib/documents/shelf'
import { documentProvenance } from '#/lib/server/shared'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { MAILBOX, bccHeaders, fillerBytes, withParts } from './fixtures'
import type { FixturePart } from './fixtures'
import { pollMailboxProgram } from './poll'
import type { PollOutcome } from './poll'
import { MailSchedule } from './schedule'
import { MAILBOX_CAPABILITY, saveMailboxProgram } from './settings'

/**
 * SPA-115 against a real database: forwarded attachments go through the
 * documents intake (core's `writes/documents/intake.ts`) and land on the company the
 * thread matched, or nowhere. The poll runs against the fake IMAP server as
 * in `poll.test.ts`; the byte half is the real intake over the real storage
 * driver, so "one blob" is a statement about the store, not a mock.
 *
 * The `job_run` refusal and the extraction-to-Cmd-K half need the worker, so
 * they are `worker/jobs/poll-mailbox.attachments.test.ts`.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const PASSWORD = 'app-password-1234'
let server: FakeImapServer
let port = 0
const shas = new Set<string>()

const schedule = Layer.succeed(
  MailSchedule,
  MailSchedule.of({ sync: () => Effect.void }),
)

beforeEach(async () => {
  await truncateAndReseed()
  server = new FakeImapServer({ user: MAILBOX, password: PASSWORD })
  port = await server.start()
  enqueued.length = 0
})

afterEach(async () => {
  await server.stop()
  for (const sha of shas) await storage().delete(sha)
  shas.clear()
})

async function configure(): Promise<void> {
  await Effect.runPromise(
    saveMailboxProgram(FIXTURE_ACTOR.id, {
      address: MAILBOX,
      host: '127.0.0.1',
      port,
      useTls: false,
      folder: 'INBOX',
      cadenceMinutes: 5,
      password: PASSWORD,
    }),
  )
}

function poll(): Promise<PollOutcome> {
  return Effect.runPromise(
    pollMailboxProgram(new Date()).pipe(Effect.provide(schedule)),
  )
}

async function aMember(email: string): Promise<void> {
  await db.insert(user).values({
    id: `member-${randomUUID().slice(0, 8)}`,
    name: email,
    email,
    emailVerified: true,
  })
}

/** A deck unique to this test, remembered for cleanup. */
function aDeck(phrase: string): { bytes: Buffer; sha: string } {
  const bytes = minimalPdf(`${phrase} ${randomUUID().slice(0, 8)}`)
  const sha = createHash('sha256').update(bytes).digest('hex')
  shas.add(sha)
  return { bytes, sha }
}

function deckPart(filename: string, bytes: Buffer): FixturePart {
  return {
    filename,
    mime: 'application/pdf',
    content: bytes,
    disposition: 'attachment',
  }
}

function mail(opts: {
  messageId: string
  from: string
  to?: string
  cc?: string
  subject: string
  parts: Array<FixturePart>
  html?: string
}): string {
  return withParts({
    headers: bccHeaders({
      messageId: opts.messageId,
      from: opts.from,
      to: opts.to ?? 'Anish <anish@fund.example>',
      ...(opts.cc === undefined ? {} : { cc: opts.cc }),
      subject: opts.subject,
    }),
    text: 'Deck attached.',
    ...(opts.html === undefined ? {} : { html: opts.html }),
    parts: opts.parts,
  })
}

async function holderOf(kind: 'email' | 'domain', value: string) {
  const row = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(and(eq(entityAlias.kind, kind), eq(entityAlias.valueNorm, value)))
  ).at(0)
  if (!row) throw new Error(`nobody holds ${value}`)
  return row.id
}

async function documentsWith(sha: string) {
  return db
    .select({
      id: document.entityId,
      filename: document.filename,
      kind: document.kind,
      sourceClass: document.sourceClass,
      sourceRef: document.sourceRef,
      sourcePath: document.sourcePath,
      uploadedBy: document.uploadedBy,
    })
    .from(document)
    .where(eq(document.blobSha, sha))
}

async function filedOn(documentId: string): Promise<Array<string>> {
  const rows = await db
    .select({ to: link.toEntityId })
    .from(link)
    .where(
      and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
    )
  return rows.map((r) => r.to).sort()
}

async function spacesOf(documentId: string): Promise<number> {
  return (
    await db
      .select({ id: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, documentId))
  ).length
}

async function mailboxIntegration(): Promise<string> {
  const row = (
    await db
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.capabilityId, MAILBOX_CAPABILITY))
  ).at(0)
  if (!row) throw new Error('no mailbox integration')
  return row.id
}

describe('forwarded attachments file themselves (SPA-115)', () => {
  it('a founder’s deck lands on the company the thread made, as the mailbox, kind other, queued to extract', async () => {
    await aMember('anish@fund.example')
    await configure()
    const deck = aDeck('Acme seed deck')
    server.deliver(
      mail({
        messageId: 'deck-1@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        subject: 'Acme seed deck',
        html: '<p>Deck attached.</p><img src="cid:sig@acme.io">',
        parts: [
          deckPart('Acme seed.pdf', deck.bytes),
          {
            filename: 'logo.png',
            mime: 'image/png',
            content: fillerBytes(30_000),
            disposition: 'inline',
            cid: 'sig@acme.io',
          },
        ],
      }),
    )

    const outcome = await poll()
    expect(outcome.written).toBe(1)
    expect(outcome.attachments).toEqual({
      filed: 1,
      unfiled: 0,
      skipped: 1,
      refused: [],
    })
    expect(outcome.summary).toContain(
      'attachments filed 1, unfiled 0, skipped 1, refused 0',
    )

    const acme = await holderOf('domain', 'acme.io')
    const ref = await mailboxIntegration()
    const rows = await documentsWith(deck.sha)
    expect(rows).toEqual([
      {
        id: expect.any(String),
        filename: 'Acme seed.pdf',
        // The classify lane's to propose, after extraction (SPA-62).
        kind: 'other',
        sourceClass: 'integration',
        sourceRef: ref,
        sourcePath: 'Acme seed deck',
        // A mailbox is not a person: every user column stays null.
        uploadedBy: null,
      },
    ])
    const doc = rows[0].id
    expect(await filedOn(doc)).toEqual([acme])
    expect(await spacesOf(doc)).toBe(0)
    expect(await storage().exists(deck.sha)).toBe(true)

    // Extraction queued, and no classify call from this lane.
    expect(enqueued.map((e) => e.name)).toEqual([
      QUEUES.pollMailbox,
      QUEUES.extractDocument,
    ])
    expect(enqueued.at(1)?.data).toEqual({ documentId: doc })

    // What the Files row prints its "· via <integration>" suffix from.
    const provenance = await documentProvenance([doc])
    expect(provenance.get(doc)).toEqual({
      sourceClass: 'integration',
      sourceCapability: MAILBOX_CAPABILITY,
    })
  })

  it('the same deck forwarded twice is one blob and one row on the company; a re-delivery files nothing', async () => {
    await configure()
    const deck = aDeck('Acme seed deck')
    server.deliver(
      mail({
        messageId: 'deck-1@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        subject: 'Acme seed deck',
        parts: [deckPart('Acme seed.pdf', deck.bytes)],
      }),
    )
    await poll()
    // A week later Jane sends it again, under a new subject and a new name.
    server.deliver(
      mail({
        messageId: 'deck-2@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        subject: 'Re-sending the deck',
        parts: [deckPart('Acme seed v1.pdf', deck.bytes)],
      }),
    )
    // And the first message arrives a second time (a second BCC copy).
    server.deliver(
      mail({
        messageId: 'deck-1@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        subject: 'Acme seed deck',
        parts: [deckPart('Acme seed.pdf', deck.bytes)],
      }),
    )
    const second = await poll()
    expect(second).toMatchObject({ written: 1, duplicate: 1 })
    // §3.4 answered the existing row: filed, not a second one.
    expect(second.attachments).toMatchObject({ filed: 1, unfiled: 0 })

    const acme = await holderOf('domain', 'acme.io')
    const rows = await documentsWith(deck.sha)
    expect(rows).toHaveLength(1)
    expect(await filedOn(rows[0].id)).toEqual([acme])
    const all = await db.select({ id: document.entityId }).from(document)
    expect(all).toHaveLength(1)
  })

  it('the same deck sent to two companies is one blob and two rows, one on each', async () => {
    await configure()
    const deck = aDeck('Shared market map')
    server.deliver(
      mail({
        messageId: 'map-1@acme.io',
        from: 'Jane Founder <jane@acme.io>',
        subject: 'Market map',
        parts: [deckPart('market-map.pdf', deck.bytes)],
      }),
    )
    server.deliver(
      mail({
        messageId: 'map-2@beta.dev',
        from: 'Priya Rao <priya@beta.dev>',
        subject: 'Market map',
        parts: [deckPart('market-map.pdf', deck.bytes)],
      }),
    )
    expect((await poll()).attachments).toMatchObject({ filed: 2 })

    const acme = await holderOf('domain', 'acme.io')
    const beta = await holderOf('domain', 'beta.dev')
    const rows = await documentsWith(deck.sha)
    expect(rows).toHaveLength(2)
    const filings = await Promise.all(rows.map((r) => filedOn(r.id)))
    expect(filings.flat().sort()).toEqual([acme, beta].sort())
    expect(await storage().exists(deck.sha)).toBe(true)
  })

  it('a thread with no company files its attachments with no edge at all — the unfiled inbox and Today’s count', async () => {
    await aMember('anish@fund.example')
    await configure()
    const deck = aDeck('Stranger deck')
    const other = aDeck('Two-company memo')
    // A stranger on a free provider: a person, no company.
    server.deliver(
      mail({
        messageId: 'cold-1@mail.gmail.com',
        from: 'Sam Stranger <sam.stranger@gmail.com>',
        subject: 'Our deck',
        parts: [deckPart('deck.pdf', deck.bytes)],
      }),
    )
    // A member writing to two companies at once: ambiguous, so unfiled
    // rather than filed on both.
    server.deliver(
      mail({
        messageId: 'intro-2@fund.example',
        from: 'Anish <anish@fund.example>',
        to: 'Jane Founder <jane@acme.io>',
        cc: 'Priya Rao <priya@beta.dev>',
        subject: 'Intro: Acme <> Beta',
        parts: [deckPart('memo.pdf', other.bytes)],
      }),
    )
    const outcome = await poll()
    expect(outcome.attachments).toMatchObject({ filed: 0, unfiled: 2 })

    const docs = [
      ...(await documentsWith(deck.sha)),
      ...(await documentsWith(other.sha)),
    ]
    expect(docs).toHaveLength(2)
    for (const d of docs) {
      expect(await filedOn(d.id)).toEqual([])
      expect(await spacesOf(d.id)).toBe(0)
    }
    // docsurf-7's readers, unchanged, see them.
    const unfiled = await Effect.runPromise(
      listDocumentsProgram({ filed: 'unfiled' }),
    )
    expect(unfiled.map((d) => d.id).sort()).toEqual(
      docs.map((d) => d.id).sort(),
    )
    expect(await Effect.runPromise(countUnfiledProgram())).toBe(2)

    // The document entities carry the mailbox's provenance too.
    const ents = await db
      .select({ sourceClass: entity.sourceClass })
      .from(entity)
      .where(
        inArray(
          entity.id,
          docs.map((d) => d.id),
        ),
      )
    expect(ents).toEqual([
      { sourceClass: 'integration' },
      { sourceClass: 'integration' },
    ])
  })
})
