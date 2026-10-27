import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  entity,
  entityAlias,
  integration,
  interactionDocument,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { EmailMeta } from '@spaces/db/schema/interactions'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  countDraftsProgram,
  deleteDraftProgram,
  getDraftProgram,
  listDraftsProgram,
  openReplyProgram,
  saveDraftProgram,
  searchRecipientsProgram,
} from './email-drafts'
import type { DraftSave } from './email-drafts'

/**
 * Drafts: author-private rows, the reply and forward prefills from the
 * parent's headers, the recipient search over names and aliases, and Trash.
 */

const ME = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@fund.example',
  emailVerified: true,
}
/** The fixture user's connected mailbox: an own alias beside the login. */
const MAILBOX = 'anish@fund.example'

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

const aPerson = async (name: string, emails: ReadonlyArray<string>) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'person', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no person')
  for (const [i, email] of emails.entries())
    await db.insert(entityAlias).values({
      entityId: ent.id,
      kind: 'email',
      value: email,
      valueNorm: email.toLowerCase(),
      isIdentity: i === 0,
    })
  return ent.id
}

const aDocument = async (name: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document')
  await db
    .insert(document)
    .values({ entityId: ent.id, filename: name, kind: 'other' })
  return ent.id
}

let integrationId = ''

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: ME.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: MAILBOX,
        tokensEnc: Buffer.from('never read'),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
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
  integrationId = row.id
})

const META: EmailMeta = {
  kind: 'email',
  from: 'dana@flent.example',
  to: [MAILBOX, 'arjun@flent.example'],
  cc: ['kiran@flent.example', FIXTURE_ACTOR.email],
  date: '2026-10-01T09:14:00.000Z',
  mime_blob_sha: null,
}

/** A synced email with its body, visible as `visibility` says. */
const anEmail = async (
  meta: EmailMeta = META,
  visibility: 'shared' | 'private' = 'shared',
  authorId: string = ME.id,
) => {
  const written = await db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId,
      kind: 'email',
      messageId: `<${randomUUID()}@flent.example>`,
      threadId: null,
      subject: 'Sept cap table + data room access',
      occurredAt: new Date(meta.date),
      meta,
      body: {
        title: 'Sept cap table + data room access',
        text: 'Attaching the September cap table.',
        authorId,
        visibility,
      },
      edges: [],
    }),
  )
  if (written.kind !== 'written') throw new Error('not written')
  return written.interactionId
}

const save = (over: Partial<DraftSave> = {}): DraftSave => ({
  id: randomUUID(),
  mode: 'new',
  inReplyToId: null,
  to: [{ email: 'dana@flent.example' }],
  cc: [],
  bcc: [],
  subject: 'Flent diligence — next steps',
  bodyMd: 'Hi Dana',
  attachments: [],
  ...over,
})

describe('a draft', () => {
  it('is listed, read and counted for its author only', async () => {
    const mine = save()
    await run(saveDraftProgram(ME, mine))
    await run(saveDraftProgram({ id: TEAMMATE.id }, save({ subject: 'Hers' })))

    const listed = await run(listDraftsProgram(ME))
    expect(listed.map((d) => d.id)).toEqual([mine.id])
    expect(await run(countDraftsProgram(ME))).toBe(1)
    expect(await run(countDraftsProgram({ id: TEAMMATE.id }))).toBe(1)

    await expect(
      run(getDraftProgram({ id: TEAMMATE.id }, mine.id)),
    ).rejects.toMatchObject({ _tag: 'DraftNotFound' })
  })

  it('saves in place by id, and another member cannot overwrite it', async () => {
    const first = save()
    await run(saveDraftProgram(ME, first))
    await run(
      saveDraftProgram(ME, { ...first, bodyMd: 'Hi Dana — three lines' }),
    )
    await expect(
      run(saveDraftProgram({ id: TEAMMATE.id }, { ...first, bodyMd: 'mine' })),
    ).rejects.toMatchObject({ _tag: 'DraftNotFound' })

    const rows = await db.select().from(emailDraft)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(ME.id)
    const back = await run(getDraftProgram(ME, first.id))
    expect(back.bodyMd).toBe('Hi Dana — three lines')
    expect(back.to).toEqual([{ email: 'dana@flent.example' }])
  })

  it('reads back only the attachments its author may read', async () => {
    const shared = await aDocument('flent-ic-note.pdf')
    const hidden = await aDocument('her-notes.pdf')
    await db
      .update(document)
      .set({ visibility: 'private', authorId: TEAMMATE.id })
      .where(eq(document.entityId, hidden))
    const draft = save({
      attachments: [{ documentId: shared }, { documentId: hidden }],
    })
    await run(saveDraftProgram(ME, draft))
    const back = await run(getDraftProgram(ME, draft.id))
    expect(back.attachments).toEqual([
      expect.objectContaining({
        documentId: shared,
        name: 'flent-ic-note.pdf',
      }),
    ])
  })

  it('goes on Trash, and the count follows', async () => {
    const a = save()
    const b = save()
    await run(saveDraftProgram(ME, a))
    await run(saveDraftProgram(ME, b))
    expect(await run(countDraftsProgram(ME))).toBe(2)
    // Another member's Trash deletes nothing.
    await run(deleteDraftProgram({ id: TEAMMATE.id }, a.id))
    expect(await run(countDraftsProgram(ME))).toBe(2)
    await run(deleteDraftProgram(ME, a.id))
    expect(await run(countDraftsProgram(ME))).toBe(1)
    expect((await run(listDraftsProgram(ME))).map((d) => d.id)).toEqual([b.id])
  })
})

describe('a reply', () => {
  it('goes to the sender, named where the address is an alias', async () => {
    const dana = await aPerson('Dana Moreau', ['dana@flent.example'])
    const parent = await anEmail()
    const opened = await run(openReplyProgram(ME, parent))
    expect(opened.draft).toBeNull()
    expect(opened.modes.reply).toMatchObject({
      mode: 'reply',
      inReplyToId: parent,
      to: [
        { email: 'dana@flent.example', entityId: dana, name: 'Dana Moreau' },
      ],
      cc: [],
      bcc: [],
      subject: 'Re: Sept cap table + data room access',
      bodyMd: '',
      attachments: [],
    })
  })

  it('reply all keeps To and Cc minus every address of the viewer', async () => {
    const parent = await anEmail()
    const { modes } = await run(openReplyProgram(ME, parent))
    expect(modes.reply_all.to.map((r) => r.email)).toEqual([
      'dana@flent.example',
      'arjun@flent.example',
    ])
    expect(modes.reply_all.cc.map((r) => r.email)).toEqual([
      'kiran@flent.example',
    ])
  })

  it('to your own message goes to its To', async () => {
    const parent = await anEmail({
      ...META,
      from: MAILBOX,
      to: ['dana@flent.example'],
      cc: [],
    })
    const { modes } = await run(openReplyProgram(ME, parent))
    expect(modes.reply.to.map((r) => r.email)).toEqual(['dana@flent.example'])
  })

  it('reopens the draft held on that email', async () => {
    const parent = await anEmail()
    const held = save({
      mode: 'reply',
      inReplyToId: parent,
      bodyMd: 'Thanks Dana',
    })
    await run(saveDraftProgram(ME, held))
    const opened = await run(openReplyProgram(ME, parent))
    expect(opened.draft).toMatchObject({ id: held.id, bodyMd: 'Thanks Dana' })
    // Someone else's draft on the same email is not theirs to reopen.
    const theirs = await run(openReplyProgram({ id: TEAMMATE.id }, parent))
    expect(theirs.draft).toBeNull()
  })
})

describe('a forward', () => {
  it('prefills nothing but the quoted body and the attachments', async () => {
    const parent = await anEmail()
    const file = await aDocument('flent-cap-table-sept.xlsx')
    await db
      .insert(interactionDocument)
      .values({ interactionId: parent, documentId: file, role: 'attachment' })
    const { modes } = await run(openReplyProgram(ME, parent))
    expect(modes.forward.to).toEqual([])
    expect(modes.forward.cc).toEqual([])
    expect(modes.forward.bcc).toEqual([])
    expect(modes.forward.subject).toBe('Fwd: Sept cap table + data room access')
    expect(modes.forward.bodyMd).toContain('From: dana@flent.example')
    expect(modes.forward.bodyMd).toContain('Attaching the September cap table.')
    expect(modes.forward.attachments).toEqual([
      expect.objectContaining({
        documentId: file,
        name: 'flent-cap-table-sept.xlsx',
      }),
    ])
  })

  it('carries neither the body nor the files of a body the viewer may not read', async () => {
    const parent = await anEmail(META, 'private', TEAMMATE.id)
    const file = await aDocument('flent-cap-table-sept.xlsx')
    await db
      .update(document)
      .set({ visibility: 'private', authorId: TEAMMATE.id })
      .where(eq(document.entityId, file))
    await db
      .insert(interactionDocument)
      .values({ interactionId: parent, documentId: file, role: 'attachment' })
    const { modes } = await run(openReplyProgram(ME, parent))
    expect(modes.forward.bodyMd).not.toContain('September')
    expect(modes.forward.attachments).toEqual([])
  })
})

describe('the recipient search', () => {
  it('matches people by name and by alias, with every alias they hold', async () => {
    const dana = await aPerson('Dana Moreau', [
      'dana@flent.example',
      'dana.moreau@gmail.example',
    ])
    await aPerson('Kiran Shah', ['kiran@flent.example'])
    await aPerson('No Email Person', [])

    expect(await run(searchRecipientsProgram('moreau'))).toEqual([
      {
        entityId: dana,
        name: 'Dana Moreau',
        emails: ['dana@flent.example', 'dana.moreau@gmail.example'],
      },
    ])
    const byAlias = await run(searchRecipientsProgram('gmail.example'))
    expect(byAlias.map((m) => m.entityId)).toEqual([dana])
    expect(byAlias[0]?.emails).toHaveLength(2)
    expect(await run(searchRecipientsProgram('No Email'))).toEqual([])
    expect(await run(searchRecipientsProgram('  '))).toEqual([])
  })
})
