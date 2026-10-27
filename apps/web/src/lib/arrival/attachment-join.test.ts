import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entityAlias,
  integration,
  interaction,
  interactionDocument,
  link,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { renderMessage } from '@spaces/sdk/testing'
import type { FakeGmailMessage } from '@spaces/sdk/testing'
import { storage } from '@spaces/core/writes/storage'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { webEnqueue } from '#/lib/enqueue-live'
import {
  countUnfiledProgram,
  listDocumentsProgram,
} from '#/lib/documents/shelf'
import { searchAllProgram } from '#/lib/search/query'
import { truncateAndReseed } from '#/test/reseed'
import { attachmentEmailsProgram } from '#/lib/documents/attachment-emails'
import { emailDetailProgram } from '#/lib/interactions/email-read'
import { hasAttachmentsSql, recordTimelineProgram } from '#/lib/timeline/record'
import { documentPreviewCard } from '#/lib/documents/preview-card'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fileAttachmentsProgram } from './attachment-filing'
import { FORWARDED, fileArrivalProgram } from './file'
import { saveMailboxSyncProgram } from './mailbox-sync'
import { withParts } from './fixtures'
import { arrivalFromSource } from './message'
import { logSyncedEmailProgram } from './synced'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Every mail attachment is a document joined to its email as `attachment`:
 * filed on each participant record, one row for one sha across the
 * forwarded and the synced lane, and private with the email's body.
 */

const HOUR = 3_600_000
const OWNER_ADDRESS = 'anish@fund.example'
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}
const OTHER = { id: 'member-other' }
const shas = new Set<string>()
let gmail = ''
let connectionId = ''

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
  await db.insert(user).values({
    ...OTHER,
    name: 'Sam',
    email: 'sam@spaces.test',
    emailVerified: true,
  })
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: OWNER_ADDRESS,
        tokensEnc: Buffer.from('never read'),
        scopes: ['openid', 'email', 'gmail.readonly'],
        createdAt: new Date(Date.now() - HOUR),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
  connectionId = connection.id
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId: connection.id,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  gmail = row.id
})

afterEach(async () => {
  for (const sha of shas) await storage().delete(sha)
  shas.clear()
})

/** Text unique to this test, remembered for cleanup by its digest. */
function content(phrase: string): string {
  const text = `%PDF-1.4\n${phrase} ${randomUUID()}\n%%EOF\n`
  shas.add(createHash('sha256').update(text).digest('hex'))
  return text
}

const message = (over: Partial<FakeGmailMessage>): FakeGmailMessage => ({
  id: `m-${randomUUID().slice(0, 8)}`,
  labelIds: ['INBOX'],
  receivedAt: Date.now() - 10 * 60_000,
  messageId: `${randomUUID()}@acme.io`,
  from: 'Jane Founder <jane@acme.io>',
  to: [OWNER_ADDRESS],
  cc: ['Raj Mehta <raj@acme.io>'],
  subject: 'Re: Seed round',
  body: 'The deck is attached.',
  ...over,
})

const sync = (m: FakeGmailMessage) =>
  Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId: gmail },
      {
        providerMessageId: m.id,
        raw: Buffer.from(renderMessage(m)),
        receivedAt: new Date(m.receivedAt),
        labels: ['Inbox'],
      },
    ),
  )

async function coreMailbox(): Promise<string> {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'core.mailbox', version: '1', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no core mailbox')
  return row.id
}

/** A Gmail forward of Jane's mail — no Message-ID in the block — with the deck. */
async function forward(deck: string, messageId = 'fwd-1@mail.gmail.com') {
  const raw = withParts({
    headers: [
      'From: Anish Badri <anish@fund.example>',
      'To: deals@fund.example',
      'Subject: Fwd: Re: Seed round',
      'Date: Tue, 22 Sep 2026 09:00:00 +0000',
      `Message-ID: <${messageId}>`,
    ],
    text: [
      'Worth a look.',
      '',
      '---------- Forwarded message ---------',
      'From: Jane Founder <jane@acme.io>',
      'Date: Mon, Sep 21, 2026 at 10:04 AM',
      'Subject: Re: Seed round',
      'To: Anish Badri <anish@fund.example>',
      '',
      '',
      'The deck is attached.',
    ].join('\n'),
    parts: [
      {
        filename: 'Acme seed.pdf',
        mime: 'application/pdf',
        content: Buffer.from(deck),
        disposition: 'attachment',
      },
    ],
  })
  const arrival = await arrivalFromSource(raw, {
    mailboxAddress: 'deals@fund.example',
    receivedAt: new Date(),
  })
  if (arrival.kind !== 'message') throw new Error('refused')
  return Effect.runPromise(
    fileArrivalProgram(arrival.message, {
      integrationId: await coreMailbox(),
      authorId: FIXTURE_ACTOR.id,
    }),
  )
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

async function filedOn(documentId: string): Promise<Array<string>> {
  const rows = await db
    .select({ to: link.toEntityId })
    .from(link)
    .where(
      and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
    )
  return rows.map((r) => r.to).sort()
}

const interactionOf = async (messageId: string) => {
  const row = (
    await db
      .select({ id: interaction.id })
      .from(interaction)
      .where(eq(interaction.messageId, messageId))
  ).at(0)
  if (!row) throw new Error(`no interaction ${messageId}`)
  return row.id
}

const joins = () =>
  db
    .select({
      interactionId: interactionDocument.interactionId,
      documentId: interactionDocument.documentId,
      role: interactionDocument.role,
    })
    .from(interactionDocument)

/** Whether `viewer` may see the document at all: the Files tab's predicate. */
const visibleTo = async (viewer: { id: string }, doc: string) =>
  (
    await db
      .select({ id: document.entityId })
      .from(document)
      .where(and(eq(document.entityId, doc), canReadDocumentSql(viewer.id)))
  ).length > 0

const privacyOf = async (doc: string) =>
  (
    await db
      .select({ visibility: document.visibility, authorId: document.authorId })
      .from(document)
      .where(eq(document.entityId, doc))
  ).at(0)

const shelf = async (viewer: { id: string }) =>
  (await Effect.runPromise(listDocumentsProgram({ filed: 'all', viewer }))).map(
    (d) => d.id,
  )

/** Cmd-K finds the document by its name. */
const found = async (viewer: { id: string }, doc: string) =>
  (
    await Effect.runPromise(
      searchAllProgram({ userId: viewer.id, q: 'Quokkaplan' }),
    )
  ).some((h) => h.id === doc)

describe('a synced email’s attachments', () => {
  it('are two documents for two attachments, joined as attachment and filed on each participant record', async () => {
    const m = message({
      attachments: [
        {
          filename: 'deck.pdf',
          mime: 'application/pdf',
          content: content('deck'),
        },
        {
          filename: 'model.pdf',
          mime: 'application/pdf',
          content: content('model'),
        },
      ],
    })
    expect((await sync(m)).outcome).toBe('created')
    const email = await interactionOf(m.messageId ?? '')

    const docs = await db
      .select({ id: document.entityId, filename: document.filename })
      .from(document)
    expect(docs.map((d) => d.filename).sort()).toEqual([
      'deck.pdf',
      'model.pdf',
    ])
    const joined = await joins()
    expect(joined.map((j) => [j.interactionId, j.role])).toEqual([
      [email, 'attachment'],
      [email, 'attachment'],
    ])
    expect(joined.map((j) => j.documentId).sort()).toEqual(
      docs.map((d) => d.id).sort(),
    )
    const participants = [
      await holderOf('domain', 'acme.io'),
      await holderOf('email', 'jane@acme.io'),
      await holderOf('email', 'raj@acme.io'),
    ].sort()
    for (const d of docs) expect(await filedOn(d.id)).toEqual(participants)
  })

  it('the same deck forwarded and synced is one document joined to both emails', async () => {
    const deck = content('Acme seed deck')
    const forwarded = await forward(deck)
    if (forwarded.kind !== 'written') throw new Error('not written')

    const m = message({
      attachments: [
        { filename: 'Acme seed.pdf', mime: 'application/pdf', content: deck },
      ],
    })
    expect((await sync(m)).outcome).toBe('created')
    const synced = await interactionOf(m.messageId ?? '')
    // Two emails: the forward's block carried no Message-ID.
    expect(synced).not.toBe(forwarded.interactionId)

    const docs = await db.select({ id: document.entityId }).from(document)
    expect(docs).toHaveLength(1)
    const doc = docs[0].id
    expect((await joins()).map((j) => j.interactionId).sort()).toEqual(
      [forwarded.interactionId, synced].sort(),
    )
    // Raj was only on the synced copy; the shared row gained him.
    expect(await filedOn(doc)).toContain(await holderOf('email', 'raj@acme.io'))
  })
})

describe('an attachment is private with its email’s body (D67)', () => {
  const syncDeck = async (
    phrase: string,
    over: Partial<FakeGmailMessage> = {},
  ) => {
    const deck = content(phrase)
    const m = message({
      attachments: [
        { filename: 'Quokkaplan.pdf', mime: 'application/pdf', content: deck },
      ],
      ...over,
    })
    expect((await sync(m)).outcome).toBe('created')
    const doc = (await db.select({ id: document.entityId }).from(document)).at(
      0,
    )?.id
    if (doc === undefined) throw new Error('no document')
    return { deck, doc, email: await interactionOf(m.messageId ?? '') }
  }

  it('hides a private synced email’s attachment from a teammate on the Files tab, the ledger, the viewer, the shelf and Cmd-K', async () => {
    const { doc, email } = await syncDeck('private deck')
    const acme = await holderOf('domain', 'acme.io')

    // The owner: listed, named by its email, counted on the ledger.
    expect(await visibleTo(FIXTURE_ACTOR, doc)).toBe(true)
    expect(
      (
        await Effect.runPromise(attachmentEmailsProgram(FIXTURE_ACTOR, [doc]))
      ).get(doc),
    ).toMatchObject({ interactionId: email, subject: 'Re: Seed round' })
    const ownRow = (
      await Effect.runPromise(recordTimelineProgram(acme, FIXTURE_ACTOR))
    ).find((i) => i.id === email)
    expect(ownRow).toMatchObject({ attachments: 1, hasAttachments: true })
    const ownView = await Effect.runPromise(
      emailDetailProgram(FIXTURE_ACTOR, email),
    )
    expect(ownView.attachments).toEqual([
      {
        documentId: doc,
        name: 'Quokkaplan.pdf',
        filename: 'Quokkaplan.pdf',
        mime: 'application/pdf',
        sizeBytes: expect.any(Number),
        lane: 'gmail',
      },
    ])
    expect(await shelf(FIXTURE_ACTOR)).toEqual([doc])
    expect(await found(FIXTURE_ACTOR, doc)).toBe(true)

    // A teammate: none of it.
    expect(await visibleTo(TEAMMATE, doc)).toBe(false)
    expect(
      (await Effect.runPromise(attachmentEmailsProgram(TEAMMATE, [doc]))).has(
        doc,
      ),
    ).toBe(false)
    const theirRow = (
      await Effect.runPromise(recordTimelineProgram(acme, TEAMMATE))
    ).find((i) => i.id === email)
    expect(theirRow).toMatchObject({
      privateBody: true,
      attachments: 0,
      hasAttachments: false,
    })
    expect(
      (await Effect.runPromise(emailDetailProgram(TEAMMATE, email)))
        .attachments,
    ).toEqual([])
    expect(await shelf(TEAMMATE)).toEqual([])
    expect(await found(TEAMMATE, doc)).toBe(false)
  })

  it('keeps an unfiled private attachment out of a teammate’s unfiled inbox and count', async () => {
    const { doc } = await syncDeck('unfiled deck', {
      from: 'Priya <priya@spaces.test>',
      cc: [],
    })
    expect(await filedOn(doc)).toEqual([])
    const unfiled = (viewer: { id: string }) =>
      Effect.runPromise(listDocumentsProgram({ filed: 'unfiled', viewer }))
    expect((await unfiled(FIXTURE_ACTOR)).map((d) => d.id)).toEqual([doc])
    expect(await Effect.runPromise(countUnfiledProgram(FIXTURE_ACTOR))).toBe(1)
    expect(await unfiled(OTHER)).toEqual([])
    expect(await Effect.runPromise(countUnfiledProgram(OTHER))).toBe(0)
  })

  it('shows it to a teammate who uploads the same deck to the same record, deduped onto it', async () => {
    const { deck, doc } = await syncDeck('dedupe deck')
    const acme = await holderOf('domain', 'acme.io')
    const born = await Effect.runPromise(
      birthDocumentProgram({
        blobSha: createHash('sha256').update(deck).digest('hex'),
        filename: 'Quokkaplan.pdf',
        mime: 'application/pdf',
        sizeBytes: deck.length,
        kind: 'other',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: acme }],
        actor: { userId: TEAMMATE.id },
      }).pipe(Effect.provide(webEnqueue)),
    )
    expect(born).toEqual({ id: doc, deduped: true })
    // The uploader sees their own upload; a third member, who has neither
    // the email nor an upload, does too: the bytes came from a person.
    expect(await visibleTo(TEAMMATE, doc)).toBe(true)
    expect(await visibleTo(OTHER, doc)).toBe(true)
  })

  it('shows it to the teammate once a forward of the thread shares the body', async () => {
    const { deck, doc } = await syncDeck('shared deck')
    expect(await visibleTo(TEAMMATE, doc)).toBe(false)
    await forward(deck)
    expect(await visibleTo(TEAMMATE, doc)).toBe(true)
    expect(
      (await Effect.runPromise(attachmentEmailsProgram(TEAMMATE, [doc]))).get(
        doc,
      )?.subject,
    ).toBe('Re: Seed round')
  })

  it('is born private to the mailbox owner on the synced lane, and shared on the forwarded one', async () => {
    const { doc } = await syncDeck('born private deck')
    expect(await privacyOf(doc)).toEqual({
      visibility: 'private',
      authorId: FIXTURE_ACTOR.id,
    })

    const forwarded = await forward(content('forwarded deck'))
    if (forwarded.kind !== 'written') throw new Error('not written')
    const other = (
      await db
        .select({ id: interactionDocument.documentId })
        .from(interactionDocument)
        .where(eq(interactionDocument.interactionId, forwarded.interactionId))
    ).at(0)
    if (!other) throw new Error('no forwarded attachment')
    expect(await privacyOf(other.id)).toEqual({
      visibility: 'shared',
      authorId: null,
    })
  })

  it('refuses a teammate the private attachment in the preview, and opens it for the owner', async () => {
    const { doc } = await syncDeck('preview deck')
    expect(await documentPreviewCard(FIXTURE_ACTOR, doc)).toMatchObject({
      id: doc,
      filename: 'Quokkaplan.pdf',
    })
    expect(await documentPreviewCard(TEAMMATE, doc)).toBeNull()
  })

  it('shares it when the same Message-ID is forwarded, with no author left', async () => {
    const m = message({
      attachments: [
        {
          filename: 'Quokkaplan.pdf',
          mime: 'application/pdf',
          content: content('re-forwarded deck'),
        },
      ],
    })
    expect((await sync(m)).outcome).toBe('created')
    const doc = (await db.select({ id: document.entityId }).from(document)).at(
      0,
    )?.id
    if (doc === undefined) throw new Error('no document')
    expect(await visibleTo(TEAMMATE, doc)).toBe(false)

    const arrival = await arrivalFromSource(Buffer.from(renderMessage(m)), {
      mailboxAddress: 'deals@fund.example',
      receivedAt: new Date(),
    })
    if (arrival.kind !== 'message') throw new Error('refused')
    const again = await Effect.runPromise(
      fileArrivalProgram(
        arrival.message,
        { integrationId: await coreMailbox(), authorId: FIXTURE_ACTOR.id },
        FORWARDED,
      ),
    )
    expect(again).toEqual({ kind: 'duplicate' })
    expect(await privacyOf(doc)).toEqual({
      visibility: 'shared',
      authorId: null,
    })
    expect(await visibleTo(TEAMMATE, doc)).toBe(true)
  })

  it('moves with the mailbox’s share toggle while the owner still authors it', async () => {
    const { doc } = await syncDeck('toggled deck')
    const save = (shareBodies: boolean) =>
      Effect.runPromise(
        saveMailboxSyncProgram(FIXTURE_ACTOR.id, {
          connectionId,
          shareBodies,
          excludeSenders: [],
          excludeLabels: [],
        }),
      )
    await save(true)
    expect(await visibleTo(TEAMMATE, doc)).toBe(true)
    await save(false)
    expect(await visibleTo(TEAMMATE, doc)).toBe(false)
    expect(await visibleTo(FIXTURE_ACTOR, doc)).toBe(true)
  })
})

describe('a failed join', () => {
  it('is reported filed and unjoined, never refused', async () => {
    const deck = content('unjoined deck')
    const outcome = await Effect.runPromise(
      fileAttachmentsProgram(
        {
          file: [
            {
              filename: 'deck.pdf',
              mime: 'application/pdf',
              content: Buffer.from(deck),
            },
          ],
          skipped: [],
        },
        {
          integrationId: gmail,
          // No such email: the join's foreign key refuses it.
          interactionId: randomUUID(),
          subject: 'Re: Seed round',
          records: [],
          privacy: { visibility: 'shared', authorId: null },
        },
      ),
    )
    expect(outcome).toEqual({
      filed: 0,
      unfiled: 1,
      unjoined: 1,
      skipped: 0,
      refused: [],
    })
    expect(await db.select().from(document)).toHaveLength(1)
  })

  it('is rejoined when the Message-ID is delivered again, with no second document', async () => {
    const deck = content('rejoin deck')
    const m = message({
      attachments: [
        { filename: 'deck.pdf', mime: 'application/pdf', content: deck },
      ],
    })
    await sync(m)
    const email = await interactionOf(m.messageId ?? '')
    await db
      .delete(interactionDocument)
      .where(eq(interactionDocument.interactionId, email))
    expect(await joins()).toEqual([])

    expect(await sync({ ...m, id: `${m.id}-again` })).toEqual({
      outcome: 'duplicate',
    })
    const docs = await db.select({ id: document.entityId }).from(document)
    expect(docs).toHaveLength(1)
    expect(await joins()).toEqual([
      { interactionId: email, documentId: docs[0].id, role: 'attachment' },
    ])
  })
})

describe('the has-attachments filter', () => {
  it('compiles to an exists over interaction_document', () => {
    const compiled = db
      .select({ has: hasAttachmentsSql() })
      .from(interaction)
      .toSQL().sql
    expect(compiled).toContain(
      `exists (select 1 from interaction_document d where d.interaction_id = "interaction"."id" and d.role = 'attachment')`,
    )
  })

  it('marks only the email that carries one', async () => {
    const plain = message({})
    const withDeck = message({
      attachments: [
        {
          filename: 'deck.pdf',
          mime: 'application/pdf',
          content: content('filter deck'),
        },
      ],
    })
    await sync(plain)
    await sync(withDeck)
    const acme = await holderOf('domain', 'acme.io')
    const rows = await Effect.runPromise(
      recordTimelineProgram(acme, FIXTURE_ACTOR),
    )
    const flag = (messageId: string | undefined) =>
      interactionOf(messageId ?? '').then(
        (id) => rows.find((r) => r.id === id) ?? null,
      )
    expect(await flag(plain.messageId)).toMatchObject({
      attachments: 0,
      hasAttachments: false,
    })
    expect(await flag(withDeck.messageId)).toMatchObject({
      attachments: 1,
      hasAttachments: true,
    })
  })
})

describe('the migration’s backfill', () => {
  /** The hand-added statement at the end of the migration that adds the columns. */
  const backfill = readFileSync(
    new URL(
      '../../../../../packages/db/drizzle/0085_document_visibility.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .at(-1)

  const run = async () => {
    if (backfill === undefined) throw new Error('no backfill statement')
    await db.execute(sql.raw(backfill))
  }

  /** A synced attachment as it stood before the columns: shared, no author. */
  const before = async (phrase: string) => {
    const m = message({
      attachments: [
        {
          filename: 'Quokkaplan.pdf',
          mime: 'application/pdf',
          content: content(phrase),
        },
      ],
    })
    expect((await sync(m)).outcome).toBe('created')
    const doc = (await db.select({ id: document.entityId }).from(document)).at(
      0,
    )?.id
    if (doc === undefined) throw new Error('no document')
    await db
      .update(document)
      .set({ visibility: 'shared', authorId: null })
      .where(eq(document.entityId, doc))
    return doc
  }

  it('makes an attachment only a private mail filing brought in private to that body’s author', async () => {
    const doc = await before('backfilled deck')
    await run()
    expect(await privacyOf(doc)).toEqual({
      visibility: 'private',
      authorId: FIXTURE_ACTOR.id,
    })
  })

  it('leaves one a person also filed shared', async () => {
    const doc = await before('person-filed deck')
    const target = await holderOf('domain', 'acme.io')
    await db
      .update(link)
      .set({ createdBy: TEAMMATE.id })
      .where(and(eq(link.fromEntityId, doc), eq(link.toEntityId, target)))
    await run()
    expect(await privacyOf(doc)).toEqual({
      visibility: 'shared',
      authorId: null,
    })
  })
})
